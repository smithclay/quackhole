//! Browser build of the quackhole transport.
//!
//! Deliberately thin: the connection cache, the redial-once policy and the
//! stream framing all come from `quackhole-core`, so the bytes on the wire are
//! the same ones the native extension sends. That is what lets an unmodified
//! `quackhole_serve` answer a browser.
//!
//! Browsers cannot open UDP sockets, so iroh compiles its IP transport out
//! entirely here and every connection runs over a relay via WebSocket. It is
//! still end-to-end encrypted -- the relay forwards ciphertext it cannot read.

use iroh::endpoint::presets;
use iroh::{Endpoint, EndpointAddr, RelayUrl};
use quackhole_core::{parse_endpoint_id, request_async, ConnCache, PeerMap};
use std::rc::Rc;
use std::time::Duration;
use wasm_bindgen::prelude::*;

struct Inner {
    endpoint: Endpoint,
    cache: ConnCache,
    peers: PeerMap,
}

#[wasm_bindgen]
pub struct QuackholeClient {
    inner: Rc<Inner>,
}

/// Bind an endpoint. Resolves once the browser has one, which does not require
/// a relay connection yet -- that happens on the first `request`.
#[wasm_bindgen]
pub async fn connect() -> Result<QuackholeClient, JsValue> {
    console_error_panic_hook::set_once();

    // No secret key argument: a browser has nowhere safe to persist one, and a
    // client never needs a stable address. Every page load is a new identity.
    let endpoint = Endpoint::builder(presets::N0)
        .bind()
        .await
        .map_err(|e| JsValue::from_str(&format!("failed to bind iroh endpoint: {e}")))?;

    Ok(QuackholeClient {
        inner: Rc::new(Inner {
            endpoint,
            cache: ConnCache::default(),
            peers: PeerMap::default(),
        }),
    })
}

#[wasm_bindgen]
impl QuackholeClient {
    #[wasm_bindgen(js_name = endpointId)]
    pub fn endpoint_id(&self) -> String {
        self.inner.endpoint.id().to_z32()
    }

    /// Send raw HTTP bytes to `peer` and resolve with the raw response bytes.
    ///
    /// `relay` is optional but strongly preferred in a browser. Without it iroh
    /// has to resolve the peer through pkarr over HTTPS, which is a round trip
    /// to a third party that must also have seen the peer publish -- a freshly
    /// started server is routinely not there yet. The relay URL travels with the
    /// endpoint id in the connection string the user pastes, so the browser
    /// already has it and never needs to ask.
    ///
    /// Returns a Promise rather than being an `async fn` method because the
    /// future has to own everything it touches: it outlives this call.
    /// `timeout_ms` is not optional in practice. The caller is a thread blocked
    /// in `Atomics.wait`, so a request that never resolves does not fail slowly
    /// -- it wedges the DuckDB worker permanently, with nothing logged anywhere.
    /// The native side bounds the identical call with `tokio::time::timeout`;
    /// this is the same guard for a target that has no tokio.
    pub fn request(
        &self,
        peer: String,
        relay: Option<String>,
        req: Vec<u8>,
        timeout_ms: u32,
    ) -> js_sys::Promise {
        let inner = self.inner.clone();
        wasm_bindgen_futures::future_to_promise(async move {
            let id = parse_endpoint_id(&peer)
                .map_err(|e| JsValue::from_str(&format!("{e:#}")))?;
            let mut addr = EndpointAddr::new(id);
            if let Some(url) = relay.as_deref().filter(|u| !u.is_empty()) {
                let url: RelayUrl = url
                    .parse()
                    .map_err(|e| JsValue::from_str(&format!("bad relay url {url}: {e}")))?;
                addr = addr.with_relay_url(url);
            }
            let body = n0_future::time::timeout(
                Duration::from_millis(u64::from(timeout_ms)),
                request_async(&inner.endpoint, &inner.cache, &inner.peers, addr, &req),
            )
            .await
            .map_err(|_| JsValue::from_str(&format!("request timed out after {timeout_ms}ms")))?
            .map_err(|e| JsValue::from_str(&format!("{e:#}")))?;
            Ok(js_sys::Uint8Array::from(body.as_slice()).into())
        })
    }
}
