//! Inbound side: accept iroh connections and bridge each bi-stream to a fresh
//! TCP connection to the local Quack server.
//!
//! Bytes, with one question asked of them. The bridge reads the request head far
//! enough to see whether the caller said it can decode a compressed response,
//! and if it did, the response direction is compressed on the way out -- see
//! `crate::compress`, which owns the header, the envelope and the codec so that
//! this file and the two clients cannot disagree about any of them. Nothing here
//! parses a response, and nothing here rewrites a request.

use crate::{Core, PeerMap, parse_endpoint_id, record_peer};
use anyhow::{Context, Result, bail};
use iroh::endpoint::{Connection, IncomingAddr};
use iroh::{Endpoint, EndpointId};
use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

#[derive(Debug)]
pub struct ServeHandle {
    cancel: CancellationToken,
    tracker: TaskTracker,
    join: JoinHandle<()>,
}

impl ServeHandle {
    /// Stop accepting and cancel in-flight bridges, bounded by `deadline`.
    pub fn stop(self, runtime: &tokio::runtime::Runtime, deadline: Duration) {
        self.cancel.cancel();
        self.tracker.close();
        runtime.block_on(async move {
            let _ = tokio::time::timeout(deadline, async move {
                let _ = self.join.await;
                self.tracker.wait().await;
            })
            .await;
        });
    }
}

impl Core {
    pub fn serve_start(&self, target: &str, allow: Vec<String>) -> Result<()> {
        let mut guard = self
            .serve
            .lock()
            .map_err(|_| anyhow::anyhow!("quackhole serve state is poisoned"))?;
        if guard.is_some() {
            bail!("quackhole is already serving; call quackhole_stop() first");
        }

        // Parse the allow list up front so a typo is a SQL error, not a silent
        // "nobody can connect".
        let allow: HashSet<EndpointId> = allow
            .iter()
            .map(|s| {
                parse_endpoint_id(s)
                    .with_context(|| format!("allow list entry '{s}' is not a valid endpoint id"))
            })
            .collect::<Result<_>>()?;
        let allow = Arc::new(allow);

        // Resolve now, for the same reason: an unparseable target should fail
        // the CALL rather than every future connection.
        let target: Arc<str> = Arc::from(target);
        if target.parse::<std::net::SocketAddr>().is_err() {
            bail!("target '{target}' is not a host:port address");
        }

        let cancel = CancellationToken::new();
        let tracker = TaskTracker::new();
        let endpoint = self.endpoint.clone();

        let join = {
            let cancel = cancel.clone();
            let tracker = tracker.clone();
            let peers = self.peers.clone();
            self.runtime()?
                .spawn(accept_loop(endpoint, target, allow, peers, cancel, tracker))
        };

        *guard = Some(ServeHandle {
            cancel,
            tracker,
            join,
        });
        Ok(())
    }

    pub fn serve_stop(&self, deadline: Duration) -> Result<()> {
        let handle = {
            let mut guard = self
                .serve
                .lock()
                .map_err(|_| anyhow::anyhow!("quackhole serve state is poisoned"))?;
            guard.take()
        };
        if let Some(handle) = handle {
            handle.stop(self.runtime()?, deadline);
        }
        Ok(())
    }

    pub fn is_serving(&self) -> bool {
        // is_some() alone only says "stop was never called": the accept loop also
        // exits when the endpoint closes or its task dies, and the handle stays
        // put. Ask the JoinHandle whether the loop is actually alive.
        self.serve
            .lock()
            .map(|g| g.as_ref().is_some_and(|h| !h.join.is_finished()))
            .unwrap_or(false)
    }
}

async fn accept_loop(
    endpoint: Endpoint,
    target: Arc<str>,
    allow: Arc<HashSet<EndpointId>>,
    peers: PeerMap,
    cancel: CancellationToken,
    tracker: TaskTracker,
) {
    loop {
        let incoming = tokio::select! {
            _ = cancel.cancelled() => break,
            incoming = endpoint.accept() => match incoming {
                Some(incoming) => incoming,
                None => break, // endpoint closed
            },
        };

        let target = target.clone();
        let allow = allow.clone();
        let cancel = cancel.clone();
        let peers = peers.clone();
        let inner = tracker.clone();
        // Read the transport address before the handshake consumes `incoming`:
        // this is the only place iroh tells us whether the peer got a direct
        // path or fell back to a relay.
        let path = match incoming.remote_addr() {
            IncomingAddr::Ip(_) => "direct",
            _ => "relay",
        };
        tracker.spawn(async move {
            let conn = match incoming.await {
                Ok(conn) => conn,
                Err(_) => return,
            };
            if let Err(err) =
                handle_connection(conn, target, allow, peers, path, cancel, inner).await
            {
                // A peer disconnecting is normal, not an error worth surfacing.
                let _ = err;
            }
        });
    }
}

#[allow(clippy::too_many_arguments)]
async fn handle_connection(
    conn: Connection,
    target: Arc<str>,
    allow: Arc<HashSet<EndpointId>>,
    peers: PeerMap,
    path: &'static str,
    cancel: CancellationToken,
    tracker: TaskTracker,
) -> Result<()> {
    let remote = conn.remote_id();
    if !allow.is_empty() && !allow.contains(&remote) {
        conn.close(1u32.into(), b"not on allow list");
        return Ok(());
    }
    record_peer(&peers, remote, path, "in");

    loop {
        let stream = tokio::select! {
            _ = cancel.cancelled() => break,
            stream = conn.accept_bi() => stream,
        };
        let (send, recv) = match stream {
            Ok(pair) => pair,
            Err(_) => break, // peer closed the connection
        };
        let target = target.clone();
        let bridge_cancel = cancel.clone();
        tracker.spawn(async move {
            // Give the bridge the token too: without it, quackhole_stop() returns
            // OK while a bridge stuck in connect() or copy() keeps its TCP socket
            // to the local Quack server open, contradicting the ABI's promise
            // that in-flight streams are cancelled.
            tokio::select! {
                _ = bridge_cancel.cancelled() => {}
                result = bridge(send, recv, &target) => { let _ = result; }
            }
        });
    }
    Ok(())
}

/// How much of a request will be buffered while looking for the end of its head.
///
/// A head is a few hundred bytes, so this is a bound on a hostile peer rather
/// than a working limit. Running out without finding the terminator means the
/// response goes out uncompressed, which is always a correct answer -- the
/// client can read either.
const MAX_HEAD_BYTES: usize = 16 * 1024;

/// Read enough of the request to answer one question, and hand back both.
///
/// The bytes are returned rather than consumed because they still have to reach
/// Quack: this reads ahead of the copy below, it does not replace it.
///
/// Only the head is offered to `wants_compression`. Everything after the
/// terminator is caller data -- an INSERT of a log line could contain the header
/// name -- and letting a body switch the response coding on would be letting one
/// peer's data decide how another peer's is framed.
async fn sniff(recv: &mut iroh::endpoint::RecvStream) -> Result<(Vec<u8>, bool)> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    while buf.len() < MAX_HEAD_BYTES {
        // The inherent read, not AsyncReadExt's: quinn reports end of stream as
        // `None` rather than as a zero-length read, and the two are different
        // questions on a QUIC stream.
        let n = match recv
            .read(&mut chunk)
            .await
            .context("failed to read request")?
        {
            Some(n) if n > 0 => n,
            _ => break,
        };
        buf.extend_from_slice(&chunk[..n]);
        if let Some(end) = crate::compress::head_end(&buf) {
            let wants = crate::compress::wants_compression(&buf[..end]);
            return Ok((buf, wants));
        }
    }
    Ok((buf, false))
}

/// Copy the response into the stream, compressing as it goes.
///
/// Chunk by chunk rather than buffering the reply: a result set is megabytes and
/// waiting for all of it before sending any would add the whole serialisation to
/// the time before the first byte moves. gzip buffers internally, so most pushes
/// produce nothing and that is not end of stream.
/// Generic over both halves so it can be tested without an iroh stream. The
/// serving side is where a compression bug would be invisible -- the client
/// decodes whatever it is given, and a bridge that quietly stopped compressing
/// would look exactly like a bridge that worked.
async fn pump_compressed(
    tcp_read: &mut (impl tokio::io::AsyncRead + Unpin),
    send: &mut (impl tokio::io::AsyncWrite + Unpin),
) -> Result<()> {
    let mut encoder = crate::compress::Encoder::new();
    let mut buf = vec![0u8; 64 * 1024];
    // One buffer for the whole response: the encoder appends to it and drains
    // its own sink into it, so a megabyte-scale reply settles into no
    // allocation per chunk on either side.
    let mut out = Vec::new();
    loop {
        let n = tcp_read
            .read(&mut buf)
            .await
            .context("failed to read response")?;
        if n == 0 {
            break;
        }
        out.clear();
        encoder.push(&buf[..n], &mut out)?;
        if !out.is_empty() {
            send.write_all(&out)
                .await
                .context("failed to write response")?;
        }
    }
    // The trailer, and the magic if nothing has gone out yet -- an empty reply
    // still has to be announced as an envelope, or the client reads gzip's
    // header as the start of a status line.
    out.clear();
    encoder.finish(&mut out)?;
    if !out.is_empty() {
        send.write_all(&out)
            .await
            .context("failed to write response")?;
    }
    Ok(())
}

/// Copy one bi-stream to one TCP connection, in both directions.
///
/// The exchange ends when the *response* ends. The client never half-closes its
/// request stream (see dial.rs for why cpp-httplib forces that), so the
/// request-side copy would otherwise block forever and leak this task.
async fn bridge(
    mut send: iroh::endpoint::SendStream,
    mut recv: iroh::endpoint::RecvStream,
    target: &str,
) -> Result<()> {
    // Before the socket, so a peer that opens a stream and says nothing does not
    // also cost a connection to Quack.
    let (head, compress) = sniff(&mut recv).await?;

    let mut tcp = TcpStream::connect(target)
        .await
        .with_context(|| format!("failed to connect to {target}"))?;
    let (mut tcp_read, mut tcp_write) = tcp.split();

    tcp_write
        .write_all(&head)
        .await
        .context("failed to forward request")?;

    {
        let to_server = async {
            tokio::io::copy(&mut recv, &mut tcp_write)
                .await
                .map(|_| ())
                .context("failed to copy request")
        };
        let to_client = async {
            if compress {
                pump_compressed(&mut tcp_read, &mut send).await
            } else {
                tokio::io::copy(&mut tcp_read, &mut send)
                    .await
                    .map(|_| ())
                    .context("failed to copy response")
            }
        };
        tokio::pin!(to_server, to_client);

        let mut request_drained = false;
        loop {
            tokio::select! {
                // The server closed after replying (we always send
                // `Connection: close`), so the response is complete.
                result = &mut to_client => {
                    result?;
                    break;
                }
                // Only completes if the peer did half-close. Guarded so a
                // finished future is never polled again.
                result = &mut to_server, if !request_drained => {
                    result?;
                    request_drained = true;
                }
            }
        }
    }

    // FIN the stream so the dialing side's read_to_end returns.
    send.finish().context("failed to finish response stream")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The serving half is where a compression bug hides. A client decodes
    /// whatever it is handed, so a bridge that quietly stopped compressing --
    /// or that dropped the magic, or the trailer -- would look from the other
    /// end exactly like one that worked, only slower.
    #[tokio::test]
    async fn the_response_half_is_compressed_and_comes_back_whole() {
        // Repetitive the way a result set is: fixed-width rows over a small
        // alphabet, which is what Quack actually puts on the wire.
        let payload: Vec<u8> = (0..300_000u32)
            .flat_map(|n| format!("{:08x}|", n % 5000).into_bytes())
            .collect();

        let mut out = Vec::new();
        pump_compressed(&mut payload.as_slice(), &mut out)
            .await
            .expect("pump");

        assert!(out.starts_with(crate::compress::MAGIC), "announced");
        assert!(
            out.len() * 4 < payload.len(),
            "compressed {} bytes to {}, which is not compression",
            payload.len(),
            out.len()
        );
        assert_eq!(crate::compress::decode(out).expect("decode"), payload);
    }

    /// Chunking is the bridge's, not the codec's: the reply arrives in whatever
    /// pieces the kernel hands over, and gzip's own buffering means most of
    /// those produce no output at all. A stream that only framed correctly when
    /// the whole reply arrived at once would pass every other test here.
    #[tokio::test]
    async fn a_reply_that_arrives_in_dribs_still_frames() {
        let payload: Vec<u8> = (0..40_000u32).map(|n| (n % 97) as u8).collect();

        let mut out = Vec::new();
        pump_compressed(&mut Dribble(&payload), &mut out)
            .await
            .expect("pump");
        assert_eq!(crate::compress::decode(out).expect("decode"), payload);
    }

    /// One byte per read, which no kernel does and every codec should survive.
    struct Dribble<'a>(&'a [u8]);

    impl tokio::io::AsyncRead for Dribble<'_> {
        fn poll_read(
            mut self: std::pin::Pin<&mut Self>,
            _: &mut std::task::Context<'_>,
            buf: &mut tokio::io::ReadBuf<'_>,
        ) -> std::task::Poll<std::io::Result<()>> {
            // Nothing put into `buf` is how AsyncRead spells end of stream, so
            // running out needs no separate arm.
            if let Some((first, rest)) = self.0.split_first() {
                buf.put_slice(&[*first]);
                self.0 = rest;
            }
            std::task::Poll::Ready(Ok(()))
        }
    }

    /// A peer that answered with nothing at all. Without the magic the client
    /// reads gzip's header as the start of a status line, and the error is
    /// about framing rather than about the empty reply it actually was.
    #[tokio::test]
    async fn an_empty_reply_is_still_an_envelope() {
        let mut out = Vec::new();
        pump_compressed(&mut [].as_slice(), &mut out)
            .await
            .expect("pump");
        assert!(out.starts_with(crate::compress::MAGIC));
        assert!(crate::compress::decode(out).expect("decode").is_empty());
    }
}
