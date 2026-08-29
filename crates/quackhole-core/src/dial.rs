//! Outbound side: one cached QUIC connection per peer, one bi-stream per request.

use crate::{parse_endpoint_id, record_peer, Core, PeerMap, ALPN};
use anyhow::{Context, Result};
use iroh::endpoint::Connection;
use iroh::{Endpoint, EndpointId};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
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

    async fn get_or_connect(
        &self,
        endpoint: &Endpoint,
        id: EndpointId,
        peers: &PeerMap,
    ) -> Result<Connection> {
        if let Some(conn) = self.get(&id) {
            return Ok(conn);
        }
        let conn = endpoint
            .connect(id, ALPN)
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

/// Write `req` on a fresh bi-stream and read the reply to stream end.
async fn round_trip(conn: &Connection, req: &[u8]) -> Attempt {
    let (mut send, mut recv) = match conn.open_bi().await {
        Ok(pair) => pair,
        Err(e) => return Attempt::BeforeSend(anyhow::Error::new(e).context("failed to open bi-stream")),
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

impl Core {
    /// Blocking request/response over iroh. Called from a DuckDB worker thread.
    pub fn request(&self, endpoint_id: &str, req: &[u8], timeout: Duration) -> Result<Vec<u8>> {
        let id = parse_endpoint_id(endpoint_id)?;
        let endpoint = self.endpoint.clone();
        let cache = self.conns.clone();
        let peers = self.peers.clone();

        self.runtime()?.block_on(async move {
            tokio::time::timeout(timeout, async move {
                let reused = cache.get(&id).is_some();
                let conn = cache.get_or_connect(&endpoint, id, &peers).await?;
                match round_trip(&conn, req).await {
                    Attempt::Response(body) => Ok(body),
                    // A cached connection can be dead (peer restarted, idle
                    // timeout). Redial once -- but only when the request cannot
                    // have reached the peer, because Quack carries INSERTs and
                    // DDL, and replaying those would apply them twice.
                    Attempt::BeforeSend(_) if reused => {
                        cache.invalidate(&id);
                        let conn = cache.get_or_connect(&endpoint, id, &peers).await?;
                        match round_trip(&conn, req).await {
                            Attempt::Response(body) => Ok(body),
                            Attempt::BeforeSend(err) | Attempt::AfterSend(err) => Err(err),
                        }
                    }
                    Attempt::BeforeSend(err) | Attempt::AfterSend(err) => {
                        cache.invalidate(&id);
                        Err(err)
                    }
                }
            })
            .await
            .context("request timed out")?
        })
    }
}
