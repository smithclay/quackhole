//===----------------------------------------------------------------------===//
// quackhole_core.h - C ABI for the quackhole Rust transport core.
//
// Hand-written (no cbindgen) so the borrow and lifetime contracts below can be
// stated where callers will read them.
//
// The core moves bytes over iroh QUIC streams and owns the HTTP framing that
// wraps them. Framing lives here rather than in either client because both
// need it -- the native extension drives it from C++, the browser from
// JavaScript -- and two implementations would drift on details that are not
// obvious (Connection: close, chunk extensions, which caller headers are
// dropped). C++ marshals to and from DuckDB's types; it does not parse.
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
//! Fits "quack:<z-base-32>.iroh:9494" and "qh_<z-base-32>", plus NUL.
#define QH_ADDRESS_LEN     96
#define QH_SECRET_NAME_LEN 64
//! A relay URL, and a token as long as anyone sensibly passes to `token :=`.
#define QH_RELAY_URL_LEN 512
#define QH_TOKEN_LEN     512
//! A ticket carrying all three of the above, base64'd. Generous on purpose:
//! these calls refuse rather than truncate, and a truncated ticket would be a
//! valid-looking one that dials nowhere.
#define QH_TICKET_LEN 2048

//! Return codes. Negative values are failures.
#define QH_OK  0
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
//! `relays` is the relay list this endpoint homes on: relay URLs separated by
//! commas or whitespace. Pass NULL or "" for n0's public relays. It is parsed
//! here rather than by the caller so that this setting and the browser's
//! `relays` config are one format with one parser; an unparsable URL fails the
//! call before the endpoint binds.
//!
//! This is only where *this* endpoint homes, which is the relay a minted ticket
//! carries. Reaching a peer through a relay needs nothing here: iroh dials the
//! relay URL a ticket names whether or not it is in this list.
//!
//! Returns NULL on failure and writes to `err`.
QhCore *qh_core_new(const char *key_path, bool ephemeral, const char *relays, char *err, size_t err_len);

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
// Peer identity
//===--------------------------------------------------------------------===//
//
// Endpoint id, relay and token, and every spelling derived from them. None of
// these take a core: peer identity is arithmetic on strings, and the caller
// needs it in places where no endpoint is bound and binding one as a side
// effect would be a surprise.
//
// These exist here for the same reason the HTTP framing does. Both clients
// link this library, so a shape defined here cannot drift; the same shapes
// written out in C++ and again in JavaScript already had.
//
// All of them refuse rather than truncate. A short endpoint id is a different,
// valid-looking address.

//! Mint a ticket: `qh1_` + base64url of {"e": id, "r": relay, "t": token}.
//!
//! One token with no spaces, so it survives a copy out of a terminal and a
//! paste into an input without a half-selection truncating it quietly.
//!
//! Fails when `relay_url` is empty or NULL. A ticket without a relay sends its
//! holder to pkarr -- a round trip to a third party that must also have seen
//! this endpoint publish, which a server started seconds ago routinely has not
//! -- so it fails on the first click. No ticket beats a broken one.
//!
//! `out` should be QH_TICKET_LEN bytes. Returns QH_OK, or QH_ERR with `err`.
int qh_ticket_mint(const char *endpoint_id, const char *relay_url, const char *token, char *out, size_t out_len,
                   char *err, size_t err_len);

//! Read a ticket back into its three parts.
//!
//! Generous about what arrives -- people paste the surrounding quotes, the
//! shell prompt, or the whole line -- so the first `qh1_…` in the text is used.
//! Errors are written for the person holding the ticket, because that is who
//! reads them, in a browser's error slot and in a DuckDB error alike.
//!
//! Buffers should be QH_ENDPOINT_ID_LEN, QH_RELAY_URL_LEN and QH_TOKEN_LEN.
//! Writes all three or none: an id without its token would attach and then fail
//! authentication, which reads as a server problem rather than a short buffer.
int qh_ticket_parse(const char *ticket, char *id_out, size_t id_len, char *relay_out, size_t relay_len, char *token_out,
                    size_t token_len, char *err, size_t err_len);

//! The address a client dials: `quack:<endpoint-id>.iroh:9494`.
//!
//! ATTACH and the secret's SCOPE have to agree on this string exactly, or the
//! token is filed under a path nothing attaches to and the failure reads
//! `Could not find a Quack authentication token` rather than as a typo. One
//! function is what makes them unable to disagree.
//!
//! The id is normalised to z-base-32 whatever form it arrives in -- hex is 64
//! characters where a DNS label allows 63. `out` should be QH_ADDRESS_LEN.
int qh_peer_address(const char *endpoint_id, char *out, size_t out_len, char *err, size_t err_len);

//! A DuckDB identifier naming this peer's secret: `qh_<endpoint-id>`.
//!
//! Derived rather than fixed, because an unnamed quack secret is really
//! `__default_quack`: a second CREATE SECRET fails on the name whatever its
//! scope says. The prefix is not decoration -- z-base-32 includes digits, so a
//! bare id is not always a valid unquoted identifier.
//!
//! `out` should be QH_SECRET_NAME_LEN bytes.
int qh_peer_secret_name(const char *endpoint_id, char *out, size_t out_len, char *err, size_t err_len);

//! The endpoint id in an `<id>.iroh` address, or QH_ERR if it is not one.
//!
//! Accepts a bare hostname, a host:port, or a full URL with a scheme and path.
//! Deliberately lexical: it does not check that the id is a real key, because a
//! `.iroh` host with a broken id must still be recognised as ours -- otherwise
//! it falls through to httpfs and fails at getaddrinfo instead of saying what
//! is wrong. Validation happens at dial time, in qh_request.
//!
//! `out` should be QH_ENDPOINT_ID_LEN bytes.
int qh_address_endpoint_id(const char *address, char *out, size_t out_len);

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

//! Perform one HTTP request against `endpoint_id` and buffer the response.
//! Blocking; intended to be called from a DuckDB worker thread that is already
//! blocking on I/O.
//!
//! The request head is built here, from `method`/`path`/`host`/`port`, the
//! `n_headers` caller headers, and the body. Any caller-supplied Host,
//! Content-Length, Connection or Transfer-Encoding is dropped: framing is ours
//! end to end, and a caller that reinstates them breaks the end-of-response
//! signal. CR or LF anywhere in the head is an error rather than a truncated
//! request block.
//!
//! `has_body` distinguishes "no body" from "empty body": only the former omits
//! Content-Length. `content_type` is used only when the caller supplied none
//! and there is a body; pass "" for the default.
//!
//! `relay_url` is the fallback relay: one registered for this peer with
//! qh_peer_relay_set wins, because that one came from the peer itself. With
//! neither, the peer is resolved by address lookup -- a round trip to a third
//! party that must also have seen it publish, which a server started seconds
//! ago routinely has not.
//!
//! The underlying QUIC connection is cached per endpoint id and held open
//! across calls, so only the first request to a peer pays a handshake. This is
//! why reuse cannot live in the C++ HTTPClient: DuckDB builds a fresh one for
//! every request.
//!
//! All pointer arguments are borrowed for the duration of the call only.
//!
//! Returns NULL on failure and writes to `err`. On success the handle owns the
//! response and must be released with qh_response_free.
QhResponse *qh_request(QhCore *core, const char *endpoint_id, const char *relay_url, const char *method,
                       const char *path, const char *host, const char *port, const char *const *header_names,
                       const char *const *header_values, size_t n_headers, const uint8_t *body, size_t body_len,
                       bool has_body, const char *content_type, uint32_t timeout_ms, char *err, size_t err_len);

//! Remember the relay to reach one peer through, overriding the per-call
//! fallback in qh_request.
//!
//! A relay belongs to a peer, not to a process: a client holding two remotes
//! reaches them through two different relays, and one global setting cannot
//! say that. The browser bridge has always keyed its relays this way.
//!
//! Set from a ticket, which carries the relay the peer actually published on.
//! An empty `relay_url` forgets the peer rather than registering nothing.
//!
//! Returns QH_OK, or QH_ERR with `err` if the id or the URL will not parse.
//! Rejecting here rather than at dial time is deliberate: an unusable relay
//! accepted now would surface as a failure on some later query, a long way
//! from the ATTACH that supplied it.
int qh_peer_relay_set(QhCore *core, const char *endpoint_id, const char *relay_url, char *err, size_t err_len);

//! Status code, or 0 if the status line was unreadable. A 0 here means the peer
//! answered with something that is not HTTP; it is not a transport failure.
uint16_t qh_response_status(const QhResponse *response);

//! Reason phrase, NUL-terminated and borrowed until qh_response_free.
const char *qh_response_reason(const QhResponse *response);

//! Response headers, in the order the peer sent them. Names are as received.
//! Both accessors return NULL for an out-of-range index.
size_t qh_response_header_count(const QhResponse *response);
const char *qh_response_header_name(const QhResponse *response, size_t index);
const char *qh_response_header_value(const QhResponse *response, size_t index);

//! Borrowed pointer to the decoded body, already de-chunked and framed. Never
//! NULL for a non-NULL handle, though the length may be zero.
const uint8_t *qh_response_body(const QhResponse *response);
size_t qh_response_body_len(const QhResponse *response);

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

//! As qh_relay_url, but waits up to `timeout_ms` for a relay to be learned.
//!
//! An endpoint does not know its home relay the instant it binds. A ticket
//! minted before then carries no relay and sends the peer through pkarr, which
//! routinely has not seen a server this new -- so a link handed to a browser
//! fails on the first click. Blocks the calling thread; writes an empty string
//! if the timeout expires.
int qh_relay_url_wait(const QhCore *core, uint64_t timeout_ms, char *out, size_t out_len);

#ifdef __cplusplus
} // extern "C"
#endif
