//! Outbound side: one cached QUIC connection per peer, one bi-stream per request.

use crate::{record_peer, PeerMap, ALPN};
use anyhow::{Context, Result};
use iroh::endpoint::Connection;
use iroh::{Endpoint, EndpointAddr, EndpointId};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

#[cfg(not(target_family = "wasm"))]
use crate::Core;
#[cfg(not(target_family = "wasm"))]
use std::time::Duration;

/// Cap on a single buffered response. Quack's fetch loop is bounded by
/// `quack_fetch_batch_chunks` (default 12 chunks, ~24k rows), so this is a
/// backstop against a hostile peer, not a working limit.
const MAX_RESPONSE_BYTES: usize = 512 * 1024 * 1024;

/// Connections cached by peer, held open across requests.
///
/// This has to live here rather than in the C++ `HTTPClient`, because DuckDB
/// constructs a fresh `HTTPClient` for every single request and closes it
/// afterwards -- there is no C++-side object with a long enough life.
#[derive(Default, Clone)]
pub struct ConnCache {
    inner: Arc<Mutex<HashMap<EndpointId, Connection>>>,
}

impl ConnCache {
    pub(crate) fn get(&self, id: &EndpointId) -> Option<Connection> {
        self.inner.lock().ok()?.get(id).cloned()
    }

    fn put(&self, id: EndpointId, conn: Connection) {
        if let Ok(mut map) = self.inner.lock() {
            map.insert(id, conn);
        }
    }

    fn invalidate(&self, id: &EndpointId) {
        if let Ok(mut map) = self.inner.lock() {
            map.remove(id);
        }
    }

    pub fn close_all(&self) {
        if let Ok(mut map) = self.inner.lock() {
            for (_, conn) in map.drain() {
                conn.close(0u32.into(), b"shutdown");
            }
        }
    }

    /// Connect to `addr`, reusing a cached connection when there is one.
    ///
    /// Takes a full `EndpointAddr` rather than a bare id so a caller that
    /// already knows the peer's relay can say so. Address lookup is a network
    /// round trip to a third party that also has to have seen the peer publish
    /// -- fine on a laptop that can wait, but a browser handed a paste-ready
    /// connection string already has the answer.
    async fn get_or_connect(
        &self,
        endpoint: &Endpoint,
        addr: EndpointAddr,
        peers: &PeerMap,
    ) -> Result<Connection> {
        let id = addr.id;
        if let Some(conn) = self.get(&id) {
            return Ok(conn);
        }
        let conn = endpoint
            .connect(addr, ALPN)
            .await
            .with_context(|| format!("failed to connect to endpoint {id}"))?;
        self.put(id, conn.clone());
        record_peer(peers, id, "unknown", "out");
        Ok(conn)
    }
}

/// Outcome of one attempt, split by whether the peer could already have acted.
enum Attempt {
    /// Failed before the request was fully handed to the peer. Safe to repeat.
    BeforeSend(anyhow::Error),
    /// Request was written; the failure came later. NOT safe to repeat.
    AfterSend(anyhow::Error),
    Response(Vec<u8>),
}

/// Which transport the connection is using right now.
///
/// A sample, not a property: iroh starts on the relay and switches to a direct
/// path once hole punching succeeds, so the answer can change mid-connection.
/// The selected path is the one carrying application data; if nothing is
/// selected yet, any open path is a better answer than none.
fn observed_path(conn: &Connection) -> &'static str {
    let paths = conn.paths();
    let path = paths
        .iter()
        .find(|p| p.is_selected())
        .or_else(|| paths.iter().next());
    match path {
        Some(p) if p.is_ip() => "direct",
        Some(p) if p.is_relay() => "relay",
        _ => "unknown",
    }
}

/// Write `req` on a fresh bi-stream and read the reply to stream end.
async fn round_trip(conn: &Connection, req: &[u8]) -> Attempt {
    let (mut send, mut recv) = match conn.open_bi().await {
        Ok(pair) => pair,
        Err(e) => {
            return Attempt::BeforeSend(anyhow::Error::new(e).context("failed to open bi-stream"))
        }
    };
    if let Err(e) = send.write_all(req).await {
        return Attempt::BeforeSend(anyhow::Error::new(e).context("failed to write request"));
    }

    // Deliberately NOT finish()ing the send stream here.
    //
    // Half-closing looks right -- it tells the peer the request is complete --
    // but Quack's server is cpp-httplib, and cpp-httplib answers a half-closed
    // connection with nothing at all, even when a complete Content-Length-framed
    // request is already buffered. Verified against a live quack_serve: an
    // identical request returns 244 bytes without shutdown(SHUT_WR) and 0 with it.
    //
    // Instead we rely on `Connection: close`, which we always send: the server
    // closes the socket after replying, the serving side turns that into a
    // stream FIN, and read_to_end returns.
    match recv.read_to_end(MAX_RESPONSE_BYTES).await {
        Ok(body) => {
            let _ = send.finish();
            Attempt::Response(body)
        }
        Err(e) => Attempt::AfterSend(anyhow::Error::new(e).context("failed to read response")),
    }
}

/// One request/response exchange, including the redial-once policy.
///
/// Target-agnostic on purpose: native DuckDB drives this from a tokio runtime
/// and the browser drives it from the JS event loop, but the wire behaviour --
/// and therefore what a server has to understand -- is identical.
pub async fn request_async(
    endpoint: &Endpoint,
    cache: &ConnCache,
    peers: &PeerMap,
    addr: EndpointAddr,
    req: &[u8],
) -> Result<Vec<u8>> {
    let id = addr.id;
    let reused = cache.get(&id).is_some();
    let conn = cache.get_or_connect(endpoint, addr.clone(), peers).await?;
    let (conn, body) = match round_trip(&conn, req).await {
        Attempt::Response(body) => (conn, body),
        // A cached connection can be dead (peer restarted, idle timeout).
        // Redial once -- but only when the request cannot have reached the
        // peer, because Quack carries INSERTs and DDL, and replaying those
        // would apply them twice.
        Attempt::BeforeSend(_) if reused => {
            cache.invalidate(&id);
            let conn = cache.get_or_connect(endpoint, addr, peers).await?;
            match round_trip(&conn, req).await {
                Attempt::Response(body) => (conn, body),
                Attempt::BeforeSend(err) | Attempt::AfterSend(err) => return Err(err),
            }
        }
        Attempt::BeforeSend(err) | Attempt::AfterSend(err) => {
            cache.invalidate(&id);
            return Err(err);
        }
    };
    // Sampled after every round trip rather than once at connect, so an upgrade
    // from relay to direct shows up in quackhole_status().
    record_peer(peers, id, observed_path(&conn), "out");
    Ok(body)
}

#[cfg(not(target_family = "wasm"))]
impl Core {
    /// Blocking HTTP request/response over iroh, from a DuckDB worker thread.
    ///
    /// Framing lives in `crate::http` rather than in the caller because the
    /// browser client needs the identical bytes; see the note there.
    ///
    /// `relay_url` may be empty, in which case the peer is resolved by address
    /// lookup. Supplying it skips that round trip -- and works for a peer that
    /// has not finished publishing, which lookup does not.
    pub fn request(
        &self,
        endpoint_id: &str,
        relay_url: &str,
        req: &crate::http::Request,
        timeout: Duration,
    ) -> Result<crate::http::Response> {
        let addr = crate::peer_addr(endpoint_id, relay_url)?;
        let bytes = crate::http::build_request(req)?;
        let endpoint = self.endpoint.clone();
        let cache = self.conns.clone();
        let peers = self.peers.clone();

        let raw = self.runtime()?.block_on(async move {
            tokio::time::timeout(
                timeout,
                request_async(&endpoint, &cache, &peers, addr, &bytes),
            )
            .await
            .context("request timed out")?
        })?;
        // HEAD carries a Content-Length it does not honour.
        crate::http::parse_response(&raw, req.method != "HEAD")
    }
}
