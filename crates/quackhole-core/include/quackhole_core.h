//===----------------------------------------------------------------------===//
// quackhole_core.h - C ABI for the quackhole Rust transport core.
//
// Hand-written (no cbindgen) so the borrow and lifetime contracts below can be
// stated where callers will read them.
//
// The core moves opaque bytes over iroh QUIC streams. It has no HTTP awareness:
// the C++ extension builds request bytes and parses response bytes.
//
// Threading: every function is safe to call from any thread. The blocking calls
// (qh_core_new, qh_request, qh_serve_stop) must NOT be called from inside a
// callback dispatched by this library -- they block on the tokio runtime, and
// doing so from a runtime worker deadlocks.
//
// Errors: functions taking (err, err_len) write a NUL-terminated message there
// on failure. Pass a buffer of at least QH_ERR_LEN bytes.
//===----------------------------------------------------------------------===//

#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

//! Recommended size for caller-supplied error buffers.
#define QH_ERR_LEN 512
//! Buffer size that always fits an endpoint id in either encoding, plus NUL.
//! z-base-32 is 52 chars, hex is 64.
#define QH_ENDPOINT_ID_LEN 80

//! Return codes. Negative values are failures.
#define QH_OK 0
#define QH_ERR (-1)

//! Opaque handle: tokio runtime + iroh endpoint + accept loop + dial cache.
typedef struct QhCore QhCore;
//! Opaque handle to one buffered response. Owns its bytes until qh_response_free.
typedef struct QhResponse QhResponse;

//===--------------------------------------------------------------------===//
// Lifecycle
//===--------------------------------------------------------------------===//

//! Create a core and bind an iroh endpoint. Blocking.
//!
//! `key_path` is a NUL-terminated path to the persisted endpoint key; it is
//! created with mode 0600 if absent. Pass NULL, or set `ephemeral`, to use a
//! fresh random key that is not written to disk (CI runners, throwaway VMs).
//!
//! The key IS the address, so persisting it is what makes an endpoint id
//! survive a restart.
//!
//! Returns NULL on failure and writes to `err`.
QhCore *qh_core_new(const char *key_path, bool ephemeral, char *err, size_t err_len);

//! Stop the accept loop, close cached connections, and shut the runtime down
//! within `deadline_ms`, then free the handle. Safe on NULL. Idempotent.
//!
//! MUST NOT be called from a tokio worker thread.
void qh_core_free(QhCore *core, uint64_t deadline_ms);

//===--------------------------------------------------------------------===//
// Identity
//===--------------------------------------------------------------------===//

//! Write this endpoint's id, NUL-terminated, into `out`.
//!
//! `z32` selects z-base-32 (52 chars, fits a DNS label) over hex (64 chars).
//! z-base-32 is the form quackhole prints and puts in `<id>.iroh` hostnames;
//! iroh parses either, so both are accepted on the dialing side.
//!
//! Returns QH_OK, or QH_ERR if `out_len` is too small.
int qh_endpoint_id(const QhCore *core, bool z32, char *out, size_t out_len);

//===--------------------------------------------------------------------===//
// Serving
//===--------------------------------------------------------------------===//

//! Start accepting iroh connections and bridging each incoming bi-stream to a
//! fresh TCP connection to `target` (e.g. "127.0.0.1:9494"), copying both
//! directions until EOF. Blocking during setup so bind/parse errors surface to
//! the SQL caller rather than to a background thread.
//!
//! If `n_allow` is non-zero, `allow` is an array of `n_allow` NUL-terminated
//! endpoint ids (hex or z-base-32) and every other peer is rejected at accept
//! time. If `n_allow` is zero, any peer holding the Quack token may connect.
//!
//! Calling this while already serving returns QH_ERR.
int qh_serve_start(QhCore *core, const char *target, const char *const *allow, size_t n_allow, char *err,
                   size_t err_len);

//! Stop the accept loop within `deadline_ms`. In-flight streams are cancelled.
//! Returns QH_OK if serving stopped or was not running.
int qh_serve_stop(QhCore *core, uint64_t deadline_ms);

//! True if the accept loop is running.
bool qh_is_serving(const QhCore *core);

//===--------------------------------------------------------------------===//
// Dialing
//===--------------------------------------------------------------------===//

//! Send `req_len` bytes to `endpoint_id` on a fresh bi-stream and read the
//! reply to stream end. Blocking; intended to be called from a DuckDB worker
//! thread that is already blocking on I/O.
//!
//! The underlying QUIC connection is cached per endpoint id and held open
//! across calls, so only the first request to a peer pays a handshake. This is
//! why reuse cannot live in the C++ HTTPClient: DuckDB builds a fresh one for
//! every request.
//!
//! `req` is borrowed for the duration of the call only.
//!
//! Returns NULL on failure and writes to `err`. On success the handle owns the
//! response bytes and must be released with qh_response_free.
QhResponse *qh_request(QhCore *core, const char *endpoint_id, const uint8_t *req, size_t req_len,
                       uint32_t timeout_ms, char *err, size_t err_len);

//! Borrowed pointer to the response bytes; valid until qh_response_free. Never
//! NULL for a non-NULL handle, though the length may be zero.
const uint8_t *qh_response_data(const QhResponse *response);
size_t qh_response_len(const QhResponse *response);

//! Release a response. Safe on NULL.
void qh_response_free(QhResponse *response);

//===--------------------------------------------------------------------===//
// Status
//===--------------------------------------------------------------------===//

//! Number of peers currently held in the connection cache.
size_t qh_peer_count(const QhCore *core);

//! Describe the peer at `index` (0-based, ordered arbitrarily).
//!
//! Writes the peer's endpoint id (z-base-32) into `id_out`, the observed path --
//! "direct", "relay", or "unknown" -- into `path_out`, and "in" (the peer dialed
//! us) or "out" (we dialed it) into `dir_out`. All NUL-terminated.
//!
//! Returns QH_OK, or QH_ERR if `index` is out of range or a buffer is too small.
int qh_peer_info(const QhCore *core, size_t index, char *id_out, size_t id_len, char *path_out, size_t path_len,
                 char *dir_out, size_t dir_len);

//! Write the home relay URL, NUL-terminated, into `out`. Writes an empty string
//! if no relay is known yet. Returns QH_OK, or QH_ERR if `out_len` is too small.
int qh_relay_url(const QhCore *core, char *out, size_t out_len);

#ifdef __cplusplus
} // extern "C"
#endif
