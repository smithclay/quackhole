//! C ABI. Mirrors `include/quackhole_core.h`.
//!
//! Every entry point is wrapped in `catch_unwind`: a Rust panic unwinding across
//! `extern "C"` into DuckDB is undefined behaviour, so panics become error
//! returns instead.

use crate::Core;
use std::ffi::{c_char, CStr};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::PathBuf;
use std::time::Duration;

pub const QH_OK: i32 = 0;
pub const QH_ERR: i32 = -1;

/// Buffered response handle handed back to C++.
pub struct QhResponse {
    body: Vec<u8>,
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
    req: *const u8,
    req_len: usize,
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
    if req.is_null() && req_len != 0 {
        write_err(err, err_len, "request buffer must not be null");
        return std::ptr::null_mut();
    }
    let request = std::slice::from_raw_parts(req, req_len);

    let result = guard(err, err_len, || {
        core.request(
            endpoint_id,
            request,
            Duration::from_millis(timeout_ms as u64),
        )
    });
    match result {
        Some(body) => Box::into_raw(Box::new(QhResponse { body })),
        None => std::ptr::null_mut(),
    }
}

#[no_mangle]
pub unsafe extern "C" fn qh_response_data(response: *const QhResponse) -> *const u8 {
    match response.as_ref() {
        // Never hand back null for a live handle: C++ passes this straight to
        // memcpy, which is UB on null even with length 0.
        Some(r) => r.body.as_ptr(),
        None => std::ptr::null(),
    }
}

#[no_mangle]
pub unsafe extern "C" fn qh_response_len(response: *const QhResponse) -> usize {
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
