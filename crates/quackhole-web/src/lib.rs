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
use iroh::Endpoint;
use quackhole_core::{build_request, parse_response, peer_addr, request_async, ConnCache, PeerMap};
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

    /// Perform one HTTP request over iroh and resolve with `{status, headers, body}`.
    ///
    /// Framing is `quackhole_core::build_request`/`parse_response` -- the same
    /// code the native extension uses -- so the bytes on the wire are identical
    /// and an unmodified `quackhole_serve` cannot tell the two clients apart.
    ///
    /// `relay` is optional but strongly preferred here. Without it iroh must
    /// resolve the peer through pkarr over HTTPS, a round trip to a third party
    /// that must also have seen the peer publish; a server that started seconds
    /// ago routinely has not. The relay URL travels with the endpoint id in the
    /// connection string a user pastes, so the browser already has it.
    ///
    /// `timeout_ms` is not optional in practice. The caller is a thread blocked
    /// in `Atomics.wait`, so a request that never resolves does not fail slowly
    /// -- it wedges the DuckDB worker permanently, with nothing logged anywhere.
    ///
    /// Returns a Promise rather than being an `async fn` method because the
    /// future has to own everything it touches: it outlives this call.
    #[allow(clippy::too_many_arguments)]
    pub fn request(
        &self,
        peer: String,
        relay: Option<String>,
        method: String,
        path: String,
        host: String,
        port: String,
        headers: JsValue,
        body: Option<Vec<u8>>,
        content_type: String,
        timeout_ms: u32,
    ) -> js_sys::Promise {
        let inner = self.inner.clone();
        let headers = js_headers(&headers);
        wasm_bindgen_futures::future_to_promise(async move {
            let addr = peer_addr(&peer, relay.as_deref().unwrap_or(""))
                .map_err(|e| JsValue::from_str(&format!("{e:#}")))?;
            let request = quackhole_core::Request {
                method: &method,
                path: &path,
                host: &host,
                port: &port,
                headers,
                body: body.as_deref(),
                content_type: &content_type,
            };
            let bytes = build_request(&request).map_err(|e| JsValue::from_str(&format!("{e:#}")))?;

            let raw = n0_future::time::timeout(
                Duration::from_millis(u64::from(timeout_ms)),
                request_async(&inner.endpoint, &inner.cache, &inner.peers, addr, &bytes),
            )
            .await
            .map_err(|_| JsValue::from_str(&format!("request timed out after {timeout_ms}ms")))?
            .map_err(|e| JsValue::from_str(&format!("{e:#}")))?;

            // HEAD carries a Content-Length it does not honour.
            let response = parse_response(&raw, method != "HEAD")
                .map_err(|e| JsValue::from_str(&format!("{e:#}")))?;
            Ok(js_response(&response))
        })
    }
}

/// Read a plain `{name: value}` object into header pairs.
fn js_headers(value: &JsValue) -> Vec<(String, String)> {
    let Some(entries) = js_sys::Object::try_from(value).map(js_sys::Object::entries) else {
        return Vec::new();
    };
    entries
        .iter()
        .filter_map(|entry| {
            let pair = js_sys::Array::from(&entry);
            Some((pair.get(0).as_string()?, pair.get(1).as_string()?))
        })
        .collect()
}

/// Shape the response the way the bridge worker expects it.
fn js_response(response: &quackhole_core::Response) -> JsValue {
    let headers = js_sys::Object::new();
    for (name, value) in &response.headers {
        // Lowercased to match XMLHttpRequest's getAllResponseHeaders, which the
        // shim reproduces from this object.
        let _ = js_sys::Reflect::set(
            &headers,
            &JsValue::from_str(&name.to_lowercase()),
            &JsValue::from_str(value),
        );
    }
    let out = js_sys::Object::new();
    let _ = js_sys::Reflect::set(&out, &"status".into(), &JsValue::from(response.status));
    let _ = js_sys::Reflect::set(&out, &"headers".into(), &headers);
    let _ = js_sys::Reflect::set(
        &out,
        &"body".into(),
        &js_sys::Uint8Array::from(response.body.as_slice()),
    );
    out.into()
}
