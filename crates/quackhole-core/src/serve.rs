//! Inbound side: accept iroh connections and bridge each bi-stream to a fresh
//! TCP connection to the local Quack server. Bytes only -- no HTTP parsing here.

use crate::{parse_endpoint_id, record_peer, Core, PeerMap};
use anyhow::{bail, Context, Result};
use iroh::endpoint::{Connection, IncomingAddr};
use iroh::{Endpoint, EndpointId};
use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;
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
    let mut tcp = TcpStream::connect(target)
        .await
        .with_context(|| format!("failed to connect to {target}"))?;
    let (mut tcp_read, mut tcp_write) = tcp.split();

    {
        let to_server = async { tokio::io::copy(&mut recv, &mut tcp_write).await };
        let to_client = async { tokio::io::copy(&mut tcp_read, &mut send).await };
        tokio::pin!(to_server, to_client);

        let mut request_drained = false;
        loop {
            tokio::select! {
                // The server closed after replying (we always send
                // `Connection: close`), so the response is complete.
                result = &mut to_client => {
                    result.context("failed to copy response")?;
                    break;
                }
                // Only completes if the peer did half-close. Guarded so a
                // finished future is never polled again.
                result = &mut to_server, if !request_drained => {
                    result.context("failed to copy request")?;
                    request_drained = true;
                }
            }
        }
    }

    // FIN the stream so the dialing side's read_to_end returns.
    send.finish().context("failed to finish response stream")?;
    Ok(())
}
