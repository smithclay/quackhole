//! C ABI. Mirrors `include/quackhole_core.h`.
//!
//! Every entry point is wrapped in `catch_unwind`: a Rust panic unwinding across
//! `extern "C"` into DuckDB is undefined behaviour, so panics become error
//! returns instead.
//!
//! `unsafe` blocks are kept as small as the code allows, so that what is
//! actually being trusted is visible rather than blanketed over a whole
//! function. Two exceptions -- `qh_serve_start` and `qh_request` -- read a
//! dozen-odd pointers each, and threading a block around every one of them
//! obscures more than it reveals; those carry a single block with the contract
//! stated above it. The contract itself lives in `include/quackhole_core.h`:
//! every pointer argument is either null or valid for the duration of the call.

use crate::Core;
use std::ffi::{CStr, CString, c_char};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::PathBuf;
use std::time::Duration;

pub const QH_OK: i32 = 0;
pub const QH_ERR: i32 = -1;

/// Buffered response handle handed back to C++.
///
/// Holds C strings rather than Rust ones so the accessors can hand out
/// borrowed pointers without allocating per call.
pub struct QhResponse {
    status: u16,
    reason_c: CString,
    headers_c: Vec<(CString, CString)>,
    body: Vec<u8>,
}

impl From<crate::Response> for QhResponse {
    fn from(response: crate::Response) -> Self {
        // A header parsed from a text line cannot contain an interior NUL, but
        // CString::new rejects rather than truncates, so degrade to empty
        // instead of unwrapping on something a hostile peer controls.
        let c = |s: String| CString::new(s).unwrap_or_default();
        Self {
            status: response.status,
            reason_c: c(response.reason),
            headers_c: response
                .headers
                .into_iter()
                .map(|(k, v)| (c(k), c(v)))
                .collect(),
            body: response.body,
        }
    }
}

/// Write a NUL-terminated message into a caller-supplied buffer, truncating.
unsafe fn write_err(err: *mut c_char, err_len: usize, msg: &str) {
    if err.is_null() || err_len == 0 {
        return;
    }
    let bytes = msg.as_bytes();
    let n = bytes.len().min(err_len - 1);
    // SAFETY: err is non-null and the caller promises err_len writable bytes;
    // n is clamped to err_len - 1 so the terminator fits.
    unsafe {
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), err as *mut u8, n);
        *err.add(n) = 0;
    }
}

/// Write a NUL-terminated string into a caller buffer. QH_ERR if it will not fit.
unsafe fn write_str(out: *mut c_char, out_len: usize, value: &str) -> i32 {
    if out.is_null() || value.len() + 1 > out_len {
        return QH_ERR;
    }
    // SAFETY: out is non-null and holds out_len bytes, which the check above
    // proves is more than value plus its terminator.
    unsafe {
        std::ptr::copy_nonoverlapping(value.as_ptr(), out as *mut u8, value.len());
        *out.add(value.len()) = 0;
    }
    QH_OK
}

/// `write_str`, but says so in the error buffer when it will not fit.
///
/// The peer-identity calls below all write a string a caller sized a buffer
/// for, and "QH_ERR with nothing said" is indistinguishable there from a
/// malformed ticket.
unsafe fn write_str_or_err(
    out: *mut c_char,
    out_len: usize,
    value: &str,
    err: *mut c_char,
    err_len: usize,
) -> i32 {
    // SAFETY: both buffers are the caller's, passed through unchanged.
    unsafe {
        if write_str(out, out_len, value) == QH_OK {
            return QH_OK;
        }
        write_err(
            err,
            err_len,
            &format!("a {out_len} byte buffer does not fit {} bytes", value.len()),
        );
        QH_ERR
    }
}

unsafe fn cstr<'a>(ptr: *const c_char) -> Option<&'a str> {
    if ptr.is_null() {
        return None;
    }
    // SAFETY: non-null, and the caller guarantees a NUL-terminated string that
    // outlives the call. The unbounded 'a is why this function is unsafe.
    unsafe { CStr::from_ptr(ptr) }.to_str().ok()
}

/// Run `f`, converting both panics and `Err` into an error message.
unsafe fn guard<T>(
    err: *mut c_char,
    err_len: usize,
    f: impl FnOnce() -> anyhow::Result<T>,
) -> Option<T> {
    match catch_unwind(AssertUnwindSafe(f)) {
        Ok(Ok(value)) => Some(value),
        Ok(Err(e)) => {
            // SAFETY: err and err_len are the caller's, passed through unchanged.
            unsafe { write_err(err, err_len, &format!("{e:#}")) };
            None
        }
        Err(_) => {
            // SAFETY: as above.
            unsafe { write_err(err, err_len, "quackhole core panicked") };
            None
        }
    }
}

//===--------------------------------------------------------------------===//
// Lifecycle
//===--------------------------------------------------------------------===//

#[unsafe(no_mangle)]
pub unsafe extern "C" fn qh_core_new(
    key_path: *const c_char,
    ephemeral: bool,
    relays: *const c_char,
    err: *mut c_char,
    err_len: usize,
) -> *mut Core {
    // SAFETY: key_path and relays are null or NUL-terminated strings; err holds
    // err_len bytes.
    let owned = unsafe { cstr(key_path) }.map(PathBuf::from);
    let path = owned.as_deref();
    // One string rather than an array of them: the relay list arrives as a
    // DuckDB setting, and splitting it in the core is what keeps C++ and the
    // browser from each owning a copy of the format.
    //
    // A relays pointer that will not decode is an error, not "". Every other
    // string here degrades to empty, but empty is a *meaning* for this one --
    // n0's relays -- so degrading would bind on exactly the relays the caller
    // asked to avoid and report success.
    let relays = if relays.is_null() {
        Some("")
    } else {
        unsafe { cstr(relays) }
    };
    let core = unsafe {
        guard(err, err_len, || match relays {
            Some(relays) => Core::new(path, ephemeral, relays),
            None => anyhow::bail!("the relay list is not valid UTF-8"),
        })
    };
    match core {
        Some(core) => Box::into_raw(Box::new(core)),
        None => std::ptr::null_mut(),
    }
}

/// Write `relays` back in the canonical form two lists can be compared in.
///
/// See `quackhole_core::normalize_relays`: the C++ side has to be able to tell
/// a changed `quackhole_relays` from the same list typed differently, and doing
/// that by comparing raw strings would call a reordered list a change.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn qh_relays_normalize(
    relays: *const c_char,
    out: *mut c_char,
    out_len: usize,
    err: *mut c_char,
    err_len: usize,
) -> i32 {
    // SAFETY: relays is null or a NUL-terminated string; out and err are the
    // caller's buffers, of the lengths given.
    let spec = unsafe { cstr(relays) }.unwrap_or("");
    let Some(normalized) = (unsafe { guard(err, err_len, || crate::normalize_relays(spec)) })
    else {
        return QH_ERR;
    };
    unsafe { write_str_or_err(out, out_len, &normalized, err, err_len) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn qh_core_free(core: *mut Core, deadline_ms: u64) {
    if core.is_null() {
        return;
    }
    // SAFETY: the handle came from Box::into_raw in qh_core_new, and the header
    // says it is freed exactly once.
    let mut core = unsafe { Box::from_raw(core) };
    let _ = catch_unwind(AssertUnwindSafe(|| {
        let _ = core.serve_stop(Duration::from_millis(deadline_ms));
        core.conns.close_all();
        core.shutdown(Duration::from_millis(deadline_ms));
    }));
}

//===--------------------------------------------------------------------===//
// Identity
//===--------------------------------------------------------------------===//

#[unsafe(no_mangle)]
pub unsafe extern "C" fn qh_endpoint_id(
    core: *const Core,
    z32: bool,
    out: *mut c_char,
    out_len: usize,
) -> i32 {
    // SAFETY: null or a live handle from this library, per quackhole_core.h.
    let Some(core) = (unsafe { core.as_ref() }) else {
        return QH_ERR;
    };
    let id = if z32 {
        core.endpoint_id_z32()
    } else {
        core.endpoint_id_hex()
    };
    // SAFETY: out holds out_len bytes; write_str refuses to overrun it.
    unsafe { write_str(out, out_len, id) }
}

//===--------------------------------------------------------------------===//
// Peer identity
//===--------------------------------------------------------------------===//
//
// None of these need a Core. Peer identity is arithmetic on strings, and the
// C++ needs it in places -- binding a table function, formatting a column --
// where no endpoint has been bound and none should be as a side effect.

/// Build a `Peer` from an endpoint id alone, for the spellings that ignore the
/// rest. Relay and token are empty because `address()` and `secret_name()` are
/// derived from the id and nothing else.
fn peer_from_id(endpoint_id: Option<&str>) -> anyhow::Result<crate::Peer> {
    let Some(endpoint_id) = endpoint_id else {
        anyhow::bail!("endpoint id must not be null");
    };
    crate::Peer::new(endpoint_id, "", "")
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn qh_ticket_mint(
    endpoint_id: *const c_char,
    relay_url: *const c_char,
    token: *const c_char,
    out: *mut c_char,
    out_len: usize,
    err: *mut c_char,
    err_len: usize,
) -> i32 {
    // SAFETY: per quackhole_core.h, every string pointer is null or
    // NUL-terminated, out holds out_len bytes and err holds err_len.
    unsafe {
        let ticket = guard(err, err_len, || {
            let Some(endpoint_id) = cstr(endpoint_id) else {
                anyhow::bail!("endpoint id must not be null");
            };
            crate::Peer::new(
                endpoint_id,
                cstr(relay_url).unwrap_or(""),
                cstr(token).unwrap_or(""),
            )?
            .to_ticket()
        });
        match ticket {
            Some(ticket) => write_str_or_err(out, out_len, &ticket, err, err_len),
            None => QH_ERR,
        }
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn qh_ticket_parse(
    ticket: *const c_char,
    id_out: *mut c_char,
    id_len: usize,
    relay_out: *mut c_char,
    relay_len: usize,
    token_out: *mut c_char,
    token_len: usize,
    err: *mut c_char,
    err_len: usize,
) -> i32 {
    // SAFETY: as above, and each output buffer holds the length given beside it.
    unsafe {
        let peer = guard(err, err_len, || {
            let Some(ticket) = cstr(ticket) else {
                anyhow::bail!("ticket must not be null");
            };
            crate::Peer::parse_ticket(ticket)
        });
        let Some(peer) = peer else {
            return QH_ERR;
        };
        // All three or none: a caller handed an id but silently no token would
        // attach and then fail authentication, which reads as a server problem
        // rather than as a buffer that was too small.
        if write_str_or_err(id_out, id_len, peer.endpoint_id(), err, err_len) != QH_OK
            || write_str_or_err(relay_out, relay_len, peer.relay_url(), err, err_len) != QH_OK
        {
            return QH_ERR;
        }
        write_str_or_err(token_out, token_len, peer.token(), err, err_len)
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn qh_peer_address(
    endpoint_id: *const c_char,
    out: *mut c_char,
    out_len: usize,
    err: *mut c_char,
    err_len: usize,
) -> i32 {
    // SAFETY: as on qh_ticket_mint.
    unsafe {
        match guard(err, err_len, || {
            Ok(peer_from_id(cstr(endpoint_id))?.address())
        }) {
            Some(address) => write_str_or_err(out, out_len, &address, err, err_len),
            None => QH_ERR,
        }
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn qh_peer_secret_name(
    endpoint_id: *const c_char,
    out: *mut c_char,
    out_len: usize,
    err: *mut c_char,
    err_len: usize,
) -> i32 {
    // SAFETY: as on qh_ticket_mint.
    unsafe {
        match guard(err, err_len, || {
            Ok(peer_from_id(cstr(endpoint_id))?.secret_name())
        }) {
            Some(name) => write_str_or_err(out, out_len, &name, err, err_len),
            None => QH_ERR,
        }
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn qh_address_endpoint_id(
    address: *const c_char,
    out: *mut c_char,
    out_len: usize,
) -> i32 {
    // SAFETY: address is null or NUL-terminated; out holds out_len bytes.
    unsafe {
        let Some(id) = cstr(address).and_then(crate::Peer::parse_address) else {
            return QH_ERR;
        };
        write_str(out, out_len, &id)
    }
}

//===--------------------------------------------------------------------===//
// Serving
//===--------------------------------------------------------------------===//

#[unsafe(no_mangle)]
pub unsafe extern "C" fn qh_serve_start(
    core: *mut Core,
    target: *const c_char,
    allow: *const *const c_char,
    n_allow: usize,
    err: *mut c_char,
    err_len: usize,
) -> i32 {
    // SAFETY: one block rather than seven, because every statement below reads
    // a caller pointer and threading a block around each obscures more than it
    // reveals. The contract is the one in quackhole_core.h: core is null or a
    // live handle, target is null or NUL-terminated, allow is null or n_allow
    // NUL-terminated strings, and err holds err_len bytes.
    unsafe {
        let Some(core) = core.as_ref() else {
            write_err(err, err_len, "null quackhole core");
            return QH_ERR;
        };
        let Some(target) = cstr(target) else {
            write_err(err, err_len, "target must not be null");
            return QH_ERR;
        };

        let mut allow_list = Vec::with_capacity(n_allow);
        if !allow.is_null() {
            for i in 0..n_allow {
                match cstr(*allow.add(i)) {
                    Some(entry) => allow_list.push(entry.to_string()),
                    None => {
                        write_err(err, err_len, "allow list contains a null entry");
                        return QH_ERR;
                    }
                }
            }
        }

        match guard(err, err_len, || core.serve_start(target, allow_list)) {
            Some(()) => QH_OK,
            None => QH_ERR,
        }
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn qh_serve_stop(core: *mut Core, deadline_ms: u64) -> i32 {
    // SAFETY: null or a live handle from this library, per quackhole_core.h.
    let Some(core) = (unsafe { core.as_ref() }) else {
        return QH_ERR;
    };
    match catch_unwind(AssertUnwindSafe(|| {
        core.serve_stop(Duration::from_millis(deadline_ms))
    })) {
        Ok(Ok(())) => QH_OK,
        _ => QH_ERR,
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn qh_is_serving(core: *const Core) -> bool {
    // SAFETY: null or a live handle from this library, per quackhole_core.h.
    unsafe { core.as_ref() }
        .map(|c| c.is_serving())
        .unwrap_or(false)
}

//===--------------------------------------------------------------------===//
// Dialing
//===--------------------------------------------------------------------===//

#[unsafe(no_mangle)]
pub unsafe extern "C" fn qh_request(
    core: *mut Core,
    endpoint_id: *const c_char,
    relay_url: *const c_char,
    method: *const c_char,
    path: *const c_char,
    host: *const c_char,
    port: *const c_char,
    header_names: *const *const c_char,
    header_values: *const *const c_char,
    n_headers: usize,
    body: *const u8,
    body_len: usize,
    has_body: bool,
    content_type: *const c_char,
    timeout_ms: u32,
    err: *mut c_char,
    err_len: usize,
) -> *mut QhResponse {
    // SAFETY: one block rather than fourteen, for the reason given on
    // qh_serve_start. Per quackhole_core.h: core is null or a live handle, each
    // string pointer is null or NUL-terminated, the header arrays are null or
    // hold n_headers entries each, body is null or holds body_len bytes, and
    // err holds err_len bytes. All are read here and nowhere else.
    unsafe {
        let Some(core) = core.as_ref() else {
            write_err(err, err_len, "null quackhole core");
            return std::ptr::null_mut();
        };
        let Some(endpoint_id) = cstr(endpoint_id) else {
            write_err(err, err_len, "endpoint id must not be null");
            return std::ptr::null_mut();
        };
        if body.is_null() && body_len != 0 {
            write_err(err, err_len, "request body must not be null");
            return std::ptr::null_mut();
        }
        let Some(headers) = collect_headers(header_names, header_values, n_headers) else {
            write_err(err, err_len, "header arrays must not be null");
            return std::ptr::null_mut();
        };

        let body_slice = if body.is_null() {
            &[][..]
        } else {
            std::slice::from_raw_parts(body, body_len)
        };
        let request = crate::Request {
            method: cstr(method).unwrap_or("POST"),
            path: cstr(path).unwrap_or("/"),
            host: cstr(host).unwrap_or(""),
            port: cstr(port).unwrap_or("9494"),
            headers,
            body: has_body.then_some(body_slice),
            content_type: cstr(content_type).unwrap_or(""),
        };

        let result = guard(err, err_len, || {
            core.request(
                endpoint_id,
                cstr(relay_url).unwrap_or(""),
                &request,
                Duration::from_millis(timeout_ms as u64),
            )
        });
        match result {
            Some(response) => Box::into_raw(Box::new(QhResponse::from(response))),
            None => std::ptr::null_mut(),
        }
    }
}

/// Borrow `n` NUL-terminated strings from each array. None if either is null.
unsafe fn collect_headers(
    names: *const *const c_char,
    values: *const *const c_char,
    n: usize,
) -> Option<Vec<(String, String)>> {
    if n == 0 {
        return Some(Vec::new());
    }
    if names.is_null() || values.is_null() {
        return None;
    }
    // SAFETY: both arrays are non-null and the caller promises n entries in
    // each, every one either null or a NUL-terminated string.
    unsafe {
        let names = std::slice::from_raw_parts(names, n);
        let values = std::slice::from_raw_parts(values, n);
        Some(
            names
                .iter()
                .zip(values)
                .filter_map(|(n, v)| Some((cstr(*n)?.to_string(), cstr(*v)?.to_string())))
                .collect(),
        )
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn qh_peer_relay_set(
    core: *mut Core,
    endpoint_id: *const c_char,
    relay_url: *const c_char,
    err: *mut c_char,
    err_len: usize,
) -> i32 {
    // SAFETY: core is null or a live handle, the strings are null or
    // NUL-terminated, and err holds err_len bytes -- per quackhole_core.h.
    unsafe {
        let Some(core) = core.as_ref() else {
            write_err(err, err_len, "null quackhole core");
            return QH_ERR;
        };
        let result = guard(err, err_len, || {
            let Some(endpoint_id) = cstr(endpoint_id) else {
                anyhow::bail!("endpoint id must not be null");
            };
            core.set_peer_relay(endpoint_id, cstr(relay_url).unwrap_or(""))
        });
        match result {
            Some(()) => QH_OK,
            None => QH_ERR,
        }
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn qh_response_status(response: *const QhResponse) -> u16 {
    // SAFETY: null or a live handle from this library, per quackhole_core.h.
    unsafe { response.as_ref() }.map(|r| r.status).unwrap_or(0)
}

/// Borrowed, NUL-terminated. Valid until qh_response_free.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn qh_response_reason(response: *const QhResponse) -> *const c_char {
    // SAFETY: null or a live handle from this library, per quackhole_core.h.
    match unsafe { response.as_ref() } {
        Some(r) => r.reason_c.as_ptr(),
        None => std::ptr::null(),
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn qh_response_header_count(response: *const QhResponse) -> usize {
    // SAFETY: null or a live handle from this library, per quackhole_core.h.
    unsafe { response.as_ref() }
        .map(|r| r.headers_c.len())
        .unwrap_or(0)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn qh_response_header_name(
    response: *const QhResponse,
    index: usize,
) -> *const c_char {
    // SAFETY: null or a live handle from this library, per quackhole_core.h.
    match unsafe { response.as_ref() }.and_then(|r| r.headers_c.get(index)) {
        Some((name, _)) => name.as_ptr(),
        None => std::ptr::null(),
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn qh_response_header_value(
    response: *const QhResponse,
    index: usize,
) -> *const c_char {
    // SAFETY: null or a live handle from this library, per quackhole_core.h.
    match unsafe { response.as_ref() }.and_then(|r| r.headers_c.get(index)) {
        Some((_, value)) => value.as_ptr(),
        None => std::ptr::null(),
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn qh_response_body(response: *const QhResponse) -> *const u8 {
    // SAFETY: null or a live handle from this library, per quackhole_core.h.
    match unsafe { response.as_ref() } {
        // Never hand back null for a live handle: C++ passes this straight to
        // memcpy, which is UB on null even with length 0.
        Some(r) => r.body.as_ptr(),
        None => std::ptr::null(),
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn qh_response_body_len(response: *const QhResponse) -> usize {
    // SAFETY: null or a live handle from this library, per quackhole_core.h.
    unsafe { response.as_ref() }
        .map(|r| r.body.len())
        .unwrap_or(0)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn qh_response_free(response: *mut QhResponse) {
    if response.is_null() {
        return;
    }
    // SAFETY: the handle came from Box::into_raw in qh_request, and the header
    // says it is released exactly once.
    drop(unsafe { Box::from_raw(response) });
}

//===--------------------------------------------------------------------===//
// Status
//===--------------------------------------------------------------------===//

#[unsafe(no_mangle)]
pub unsafe extern "C" fn qh_peer_count(core: *const Core) -> usize {
    // SAFETY: null or a live handle from this library, per quackhole_core.h.
    unsafe { core.as_ref() }
        .map(|c| c.peer_snapshot().len())
        .unwrap_or(0)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn qh_peer_info(
    core: *const Core,
    index: usize,
    id_out: *mut c_char,
    id_len: usize,
    path_out: *mut c_char,
    path_len: usize,
    dir_out: *mut c_char,
    dir_len: usize,
) -> i32 {
    // SAFETY: null or a live handle from this library, per quackhole_core.h.
    let Some(core) = (unsafe { core.as_ref() }) else {
        return QH_ERR;
    };
    let peers = core.peer_snapshot();
    let Some((id, entry)) = peers.get(index) else {
        return QH_ERR;
    };
    // SAFETY: each output buffer holds the length given alongside it, and
    // write_str refuses to overrun.
    unsafe {
        if write_str(id_out, id_len, &id.to_z32()) != QH_OK {
            return QH_ERR;
        }
        if write_str(path_out, path_len, entry.path) != QH_OK {
            return QH_ERR;
        }
        write_str(dir_out, dir_len, entry.direction)
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn qh_relay_url(core: *const Core, out: *mut c_char, out_len: usize) -> i32 {
    // SAFETY: null or a live handle from this library, per quackhole_core.h.
    let Some(core) = (unsafe { core.as_ref() }) else {
        return QH_ERR;
    };
    // SAFETY: out holds out_len bytes; write_str refuses to overrun it.
    unsafe { write_str(out, out_len, &core.relay_url()) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn qh_relay_url_wait(
    core: *const Core,
    timeout_ms: u64,
    out: *mut c_char,
    out_len: usize,
) -> i32 {
    // SAFETY: null or a live handle from this library, per quackhole_core.h.
    let Some(core) = (unsafe { core.as_ref() }) else {
        return QH_ERR;
    };
    let url = core.wait_relay_url(std::time::Duration::from_millis(timeout_ms));
    // SAFETY: out holds out_len bytes; write_str refuses to overrun it.
    unsafe { write_str(out, out_len, &url) }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every entry point is reachable from C with a null handle, so each has to
    /// answer rather than dereference. None of these need a Core -- binding one
    /// would touch the network -- which is exactly why they were cheap enough
    /// to have written long ago.
    #[test]
    fn null_handles_are_answered_not_dereferenced() {
        let mut buf = [0 as c_char; 64];
        unsafe {
            assert_eq!(
                qh_endpoint_id(std::ptr::null(), true, buf.as_mut_ptr(), 64),
                QH_ERR
            );
            assert_eq!(qh_serve_stop(std::ptr::null_mut(), 100), QH_ERR);
            assert!(!qh_is_serving(std::ptr::null()));
            assert_eq!(qh_peer_count(std::ptr::null()), 0);
            assert_eq!(qh_relay_url(std::ptr::null(), buf.as_mut_ptr(), 64), QH_ERR);
            assert_eq!(
                qh_peer_info(
                    std::ptr::null(),
                    0,
                    buf.as_mut_ptr(),
                    64,
                    buf.as_mut_ptr(),
                    64,
                    buf.as_mut_ptr(),
                    64
                ),
                QH_ERR
            );
        }
    }

    #[test]
    fn peer_identity_survives_the_c_abi() {
        let id = crate::parse_endpoint_id(&iroh::SecretKey::generate().public().to_z32())
            .unwrap()
            .to_z32();
        let id_c = CString::new(id.clone()).unwrap();
        let relay_c = CString::new("https://relay.example/").unwrap();
        // The one field a caller controls, and the one that can carry a quote
        // into the JSON.
        let token_c = CString::new(r#"a"b\c"#).unwrap();

        let mut ticket = [0 as c_char; 2048];
        let mut err = [0 as c_char; 512];
        unsafe {
            assert_eq!(
                qh_ticket_mint(
                    id_c.as_ptr(),
                    relay_c.as_ptr(),
                    token_c.as_ptr(),
                    ticket.as_mut_ptr(),
                    2048,
                    err.as_mut_ptr(),
                    512,
                ),
                QH_OK,
                "{}",
                CStr::from_ptr(err.as_ptr()).to_string_lossy()
            );

            let (mut id_out, mut relay_out, mut token_out) =
                ([0 as c_char; 80], [0 as c_char; 512], [0 as c_char; 512]);
            assert_eq!(
                qh_ticket_parse(
                    ticket.as_ptr(),
                    id_out.as_mut_ptr(),
                    80,
                    relay_out.as_mut_ptr(),
                    512,
                    token_out.as_mut_ptr(),
                    512,
                    err.as_mut_ptr(),
                    512,
                ),
                QH_OK
            );
            assert_eq!(cstr(id_out.as_ptr()), Some(id.as_str()));
            assert_eq!(cstr(relay_out.as_ptr()), Some("https://relay.example/"));
            assert_eq!(cstr(token_out.as_ptr()), Some(r#"a"b\c"#));

            // The invariant the C++ used to hold by writing the same string
            // twice: the SCOPE and the ATTACH path are one function.
            let mut address = [0 as c_char; 96];
            assert_eq!(
                qh_peer_address(
                    id_c.as_ptr(),
                    address.as_mut_ptr(),
                    96,
                    err.as_mut_ptr(),
                    512
                ),
                QH_OK
            );
            assert_eq!(
                cstr(address.as_ptr()),
                Some(format!("quack:{id}.iroh:9494").as_str())
            );

            let mut back = [0 as c_char; 80];
            assert_eq!(
                qh_address_endpoint_id(address.as_ptr(), back.as_mut_ptr(), 80),
                QH_OK
            );
            assert_eq!(cstr(back.as_ptr()), Some(id.as_str()));

            let mut secret = [0 as c_char; 64];
            assert_eq!(
                qh_peer_secret_name(
                    id_c.as_ptr(),
                    secret.as_mut_ptr(),
                    64,
                    err.as_mut_ptr(),
                    512
                ),
                QH_OK
            );
            assert_eq!(cstr(secret.as_ptr()), Some(format!("qh_{id}").as_str()));
        }
    }

    #[test]
    fn peer_identity_refuses_rather_than_truncating() {
        let id_c = CString::new(iroh::SecretKey::generate().public().to_z32()).unwrap();
        let relay_c = CString::new("https://relay.example/").unwrap();
        let mut small = [0 as c_char; 8];
        let mut err = [0 as c_char; 512];
        unsafe {
            // A truncated address is a different, valid-looking one, so this
            // has to fail -- and say why, or it is indistinguishable from a
            // malformed id.
            assert_eq!(
                qh_peer_address(id_c.as_ptr(), small.as_mut_ptr(), 8, err.as_mut_ptr(), 512),
                QH_ERR
            );
            assert!(
                CStr::from_ptr(err.as_ptr())
                    .to_string_lossy()
                    .contains("does not fit"),
                "{}",
                CStr::from_ptr(err.as_ptr()).to_string_lossy()
            );

            // No relay means no ticket: minting one would hand out a link that
            // fails on the first click.
            let mut ticket = [0 as c_char; 2048];
            let empty = CString::new("").unwrap();
            assert_eq!(
                qh_ticket_mint(
                    id_c.as_ptr(),
                    empty.as_ptr(),
                    empty.as_ptr(),
                    ticket.as_mut_ptr(),
                    2048,
                    err.as_mut_ptr(),
                    512,
                ),
                QH_ERR
            );

            // Nulls are answered, not dereferenced, like everything else here.
            assert_eq!(
                qh_ticket_mint(
                    std::ptr::null(),
                    relay_c.as_ptr(),
                    std::ptr::null(),
                    ticket.as_mut_ptr(),
                    2048,
                    err.as_mut_ptr(),
                    512,
                ),
                QH_ERR
            );
            assert_eq!(
                qh_ticket_parse(
                    std::ptr::null(),
                    small.as_mut_ptr(),
                    8,
                    small.as_mut_ptr(),
                    8,
                    small.as_mut_ptr(),
                    8,
                    err.as_mut_ptr(),
                    512,
                ),
                QH_ERR
            );
            assert_eq!(
                qh_address_endpoint_id(std::ptr::null(), small.as_mut_ptr(), 8),
                QH_ERR
            );
            // Not an iroh address at all.
            let local = CString::new("quack:localhost:9494").unwrap();
            let mut out = [0 as c_char; 80];
            assert_eq!(
                qh_address_endpoint_id(local.as_ptr(), out.as_mut_ptr(), 80),
                QH_ERR
            );
        }
    }

    #[test]
    fn freeing_null_is_a_no_op() {
        // The header promises this, and C++ destructors lean on it.
        unsafe {
            qh_core_free(std::ptr::null_mut(), 100);
            qh_response_free(std::ptr::null_mut());
        }
    }

    #[test]
    fn response_accessors_survive_a_null_handle() {
        let null = std::ptr::null();
        unsafe {
            assert_eq!(qh_response_status(null), 0);
            assert_eq!(qh_response_header_count(null), 0);
            assert_eq!(qh_response_body_len(null), 0);
            assert!(qh_response_reason(null).is_null());
            assert!(qh_response_body(null).is_null());
            assert!(qh_response_header_name(null, 0).is_null());
            assert!(qh_response_header_value(null, 0).is_null());
        }
    }

    #[test]
    fn a_header_index_past_the_end_returns_null() {
        let response: QhResponse = crate::Response {
            status: 200,
            reason: "OK".into(),
            headers: vec![("Content-Length".into(), "2".into())],
            body: b"hi".to_vec(),
        }
        .into();
        let ptr: *const QhResponse = &response;
        unsafe {
            assert_eq!(qh_response_header_count(ptr), 1);
            assert!(!qh_response_header_name(ptr, 0).is_null());
            // C++ loops up to header_count; an off-by-one must not read past it.
            assert!(qh_response_header_name(ptr, 1).is_null());
            assert!(qh_response_header_value(ptr, 99).is_null());
            assert_eq!(qh_response_body_len(ptr), 2);
        }
    }

    #[test]
    fn an_empty_body_still_yields_a_pointer() {
        // C++ hands this straight to memcpy, which is UB on null even with a
        // length of zero.
        let response: QhResponse = crate::Response::default().into();
        let ptr: *const QhResponse = &response;
        unsafe {
            assert_eq!(qh_response_body_len(ptr), 0);
            assert!(!qh_response_body(ptr).is_null());
        }
    }

    #[test]
    fn write_str_refuses_a_buffer_that_cannot_hold_the_terminator() {
        let mut buf = [0 as c_char; 4];
        unsafe {
            // "abc" plus NUL is exactly 4.
            assert_eq!(write_str(buf.as_mut_ptr(), 4, "abc"), QH_OK);
            assert_eq!(CStr::from_ptr(buf.as_ptr()).to_str().unwrap(), "abc");
            // "abcd" would need 5, so it refuses rather than truncating: a
            // truncated endpoint id is a different, valid-looking address.
            assert_eq!(write_str(buf.as_mut_ptr(), 4, "abcd"), QH_ERR);
            assert_eq!(write_str(std::ptr::null_mut(), 64, "abc"), QH_ERR);
        }
    }

    #[test]
    fn write_err_truncates_rather_than_overrunning() {
        let mut buf = [0x7f as c_char; 8];
        unsafe {
            write_err(buf.as_mut_ptr(), 8, "a message far longer than eight bytes");
            let written = CStr::from_ptr(buf.as_ptr()).to_str().unwrap();
            assert_eq!(written, "a messa", "fills 7 bytes and terminates");

            // Neither of these may write anywhere.
            write_err(std::ptr::null_mut(), 8, "ignored");
            write_err(buf.as_mut_ptr(), 0, "ignored");
        }
    }

    #[test]
    fn cstr_rejects_null_and_invalid_utf8() {
        unsafe {
            assert_eq!(cstr(std::ptr::null()), None);

            let good = CString::new("endpoint").unwrap();
            assert_eq!(cstr(good.as_ptr()), Some("endpoint"));

            // A C caller can hand us any bytes. A lone 0xff is not UTF-8, and
            // this has to be None rather than an unchecked conversion.
            let bad = CString::new([0xffu8, 0xfe]).unwrap();
            assert_eq!(cstr(bad.as_ptr()), None);
        }
    }

    #[test]
    fn collect_headers_distinguishes_empty_from_null() {
        unsafe {
            // n == 0 is a valid request with no headers, not an error.
            assert_eq!(
                collect_headers(std::ptr::null(), std::ptr::null(), 0),
                Some(Vec::new())
            );
            // Claiming entries while passing no array is a caller bug.
            assert!(collect_headers(std::ptr::null(), std::ptr::null(), 2).is_none());

            let name = CString::new("X-Test").unwrap();
            let value = CString::new("1").unwrap();
            let names = [name.as_ptr()];
            let values = [value.as_ptr()];
            assert_eq!(
                collect_headers(names.as_ptr(), values.as_ptr(), 1),
                Some(vec![("X-Test".to_string(), "1".to_string())])
            );
        }
    }
}
