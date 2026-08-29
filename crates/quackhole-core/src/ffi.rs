//! C ABI. Mirrors `include/quackhole_core.h`.
//!
//! Every entry point is wrapped in `catch_unwind`: a Rust panic unwinding across
//! `extern "C"` into DuckDB is undefined behaviour, so panics become error
//! returns instead.

use crate::Core;
use std::ffi::{c_char, CStr, CString};
use std::panic::{catch_unwind, AssertUnwindSafe};
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
    std::ptr::copy_nonoverlapping(bytes.as_ptr(), err as *mut u8, n);
    *err.add(n) = 0;
}

/// Write a NUL-terminated string into a caller buffer. QH_ERR if it will not fit.
unsafe fn write_str(out: *mut c_char, out_len: usize, value: &str) -> i32 {
    if out.is_null() || value.len() + 1 > out_len {
        return QH_ERR;
    }
    std::ptr::copy_nonoverlapping(value.as_ptr(), out as *mut u8, value.len());
    *out.add(value.len()) = 0;
    QH_OK
}

unsafe fn cstr<'a>(ptr: *const c_char) -> Option<&'a str> {
    if ptr.is_null() {
        None
    } else {
        CStr::from_ptr(ptr).to_str().ok()
    }
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
            write_err(err, err_len, &format!("{e:#}"));
            None
        }
        Err(_) => {
            write_err(err, err_len, "quackhole core panicked");
            None
        }
    }
}

//===--------------------------------------------------------------------===//
// Lifecycle
//===--------------------------------------------------------------------===//

#[no_mangle]
pub unsafe extern "C" fn qh_core_new(
    key_path: *const c_char,
    ephemeral: bool,
    err: *mut c_char,
    err_len: usize,
) -> *mut Core {
    let path = cstr(key_path).map(PathBuf::from);
    match guard(err, err_len, || Core::new(path.as_deref(), ephemeral)) {
        Some(core) => Box::into_raw(Box::new(core)),
        None => std::ptr::null_mut(),
    }
}

#[no_mangle]
pub unsafe extern "C" fn qh_core_free(core: *mut Core, deadline_ms: u64) {
    if core.is_null() {
        return;
    }
    let mut core = Box::from_raw(core);
    let _ = catch_unwind(AssertUnwindSafe(|| {
        let _ = core.serve_stop(Duration::from_millis(deadline_ms));
        core.conns.close_all();
        core.shutdown(Duration::from_millis(deadline_ms));
    }));
}

//===--------------------------------------------------------------------===//
// Identity
//===--------------------------------------------------------------------===//

#[no_mangle]
pub unsafe extern "C" fn qh_endpoint_id(
    core: *const Core,
    z32: bool,
    out: *mut c_char,
    out_len: usize,
) -> i32 {
    let Some(core) = core.as_ref() else {
        return QH_ERR;
    };
    let id = if z32 {
        core.endpoint_id_z32()
    } else {
        core.endpoint_id_hex()
    };
    write_str(out, out_len, id)
}

//===--------------------------------------------------------------------===//
// Serving
//===--------------------------------------------------------------------===//

#[no_mangle]
pub unsafe extern "C" fn qh_serve_start(
    core: *mut Core,
    target: *const c_char,
    allow: *const *const c_char,
    n_allow: usize,
    err: *mut c_char,
    err_len: usize,
) -> i32 {
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

#[no_mangle]
pub unsafe extern "C" fn qh_serve_stop(core: *mut Core, deadline_ms: u64) -> i32 {
    let Some(core) = core.as_ref() else {
        return QH_ERR;
    };
    match catch_unwind(AssertUnwindSafe(|| {
        core.serve_stop(Duration::from_millis(deadline_ms))
    })) {
        Ok(Ok(())) => QH_OK,
        _ => QH_ERR,
    }
}

#[no_mangle]
pub unsafe extern "C" fn qh_is_serving(core: *const Core) -> bool {
    core.as_ref().map(|c| c.is_serving()).unwrap_or(false)
}

//===--------------------------------------------------------------------===//
// Dialing
//===--------------------------------------------------------------------===//

#[no_mangle]
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

#[no_mangle]
pub unsafe extern "C" fn qh_response_status(response: *const QhResponse) -> u16 {
    response.as_ref().map(|r| r.status).unwrap_or(0)
}

/// Borrowed, NUL-terminated. Valid until qh_response_free.
#[no_mangle]
pub unsafe extern "C" fn qh_response_reason(response: *const QhResponse) -> *const c_char {
    match response.as_ref() {
        Some(r) => r.reason_c.as_ptr(),
        None => std::ptr::null(),
    }
}

#[no_mangle]
pub unsafe extern "C" fn qh_response_header_count(response: *const QhResponse) -> usize {
    response.as_ref().map(|r| r.headers_c.len()).unwrap_or(0)
}

#[no_mangle]
pub unsafe extern "C" fn qh_response_header_name(
    response: *const QhResponse,
    index: usize,
) -> *const c_char {
    match response.as_ref().and_then(|r| r.headers_c.get(index)) {
        Some((name, _)) => name.as_ptr(),
        None => std::ptr::null(),
    }
}

#[no_mangle]
pub unsafe extern "C" fn qh_response_header_value(
    response: *const QhResponse,
    index: usize,
) -> *const c_char {
    match response.as_ref().and_then(|r| r.headers_c.get(index)) {
        Some((_, value)) => value.as_ptr(),
        None => std::ptr::null(),
    }
}

#[no_mangle]
pub unsafe extern "C" fn qh_response_body(response: *const QhResponse) -> *const u8 {
    match response.as_ref() {
        // Never hand back null for a live handle: C++ passes this straight to
        // memcpy, which is UB on null even with length 0.
        Some(r) => r.body.as_ptr(),
        None => std::ptr::null(),
    }
}

#[no_mangle]
pub unsafe extern "C" fn qh_response_body_len(response: *const QhResponse) -> usize {
    response.as_ref().map(|r| r.body.len()).unwrap_or(0)
}

#[no_mangle]
pub unsafe extern "C" fn qh_response_free(response: *mut QhResponse) {
    if !response.is_null() {
        drop(Box::from_raw(response));
    }
}

//===--------------------------------------------------------------------===//
// Status
//===--------------------------------------------------------------------===//

#[no_mangle]
pub unsafe extern "C" fn qh_peer_count(core: *const Core) -> usize {
    core.as_ref().map(|c| c.peer_snapshot().len()).unwrap_or(0)
}

#[no_mangle]
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
    let Some(core) = core.as_ref() else {
        return QH_ERR;
    };
    let peers = core.peer_snapshot();
    let Some((id, entry)) = peers.get(index) else {
        return QH_ERR;
    };
    if write_str(id_out, id_len, &id.to_z32()) != QH_OK {
        return QH_ERR;
    }
    if write_str(path_out, path_len, entry.path) != QH_OK {
        return QH_ERR;
    }
    write_str(dir_out, dir_len, entry.direction)
}

#[no_mangle]
pub unsafe extern "C" fn qh_relay_url(core: *const Core, out: *mut c_char, out_len: usize) -> i32 {
    let Some(core) = core.as_ref() else {
        return QH_ERR;
    };
    write_str(out, out_len, &core.relay_url())
}
