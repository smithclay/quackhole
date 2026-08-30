# Deferred decisions

Things we investigated, decided not to build yet, and the evidence behind that.

---

## Files over `.iroh` (`read_parquet` / `read_csv`)

**Status:** deferred, not blocked. Needs a product decision first.

### Why it doesn't work today

No httpfs file I/O reaches Quackhole — not ranged GETs, not plain GETs, not HEAD, not S3.
Only Quack traffic does. The reason is a seam that is narrower than it looks:

1. `FileOpener::GetHTTPUtil()` returns `DBConfig`'s util, i.e. **ours**
   (`duckdb/src/main/client_context_file_opener.cpp:29-31`). So we *are* consulted.
2. httpfs calls `http_util.InitializeParameters(opener, info)` on us
   (`duckdb-httpfs/src/http/httpfs.cpp:280`), and our override delegates to `prev`.
3. httpfs then builds `make_uniq<HTTPFSParams>(httpfs_util)` — bound to **the HTTPFSUtil
   instance itself**, not to whoever was asked (`duckdb-httpfs/src/http/httpfs.cpp:42`).
4. `HTTPParams::http_util` is a plain reference member, fixed at construction
   (`duckdb/src/include/duckdb/common/http_util.hpp:54`).
5. Every client is then created via `snapshot_params.http_util.InitializeClient(...)`
   (`duckdb-httpfs/src/http/http_request_session.cpp:135`) — httpfs's, never ours.

So we are asked exactly once, for parameters, and delegating that one call hands the
connection to httpfs permanently.

Quack differs because it never goes through a `FileOpener`: it calls `HTTPUtil::Get(db)` and
then `Request()` **on that object** (`duckdb-quack/src/quack_client.cpp:34`). That is the
whole reason `ATTACH` works and `read_csv` does not.

(Checked against duckdb-httpfs `aca74bd`, 2026-08-27.)

### Options

| Option | Verdict |
|---|---|
| Return our own `HTTPParams` instead of delegating | **Blocked.** httpfs does `params->Cast<HTTPFSParams>()` on the plain-HTTP path (`httpfs.cpp:206`, `:289`); a base `HTTPParams` fails the cast |
| Vendor httpfs headers, construct `HTTPFSParams(*this)` | Would work — the constructor takes a base `HTTPUtil &` (`httpfs_client.hpp:39`) — but couples our binary to httpfs internals across two independently-released extensions. ABI landmine |
| Register a `FileSystem` for `.iroh` | **Tractable.** See sizing below. Changes what Quackhole *is* |
| Upstream change in httpfs | **Smallest correct fix.** Resolve the util from the opener at client-creation time instead of binding params to `*this`. Makes any `DBConfig`-level `HTTPUtil` wrapper work as the seam intends. Not ours to land |

### Sizing the FileSystem option

Smaller than it first appears, because the expensive part is already in core:

- **`CachingFileSystem` / `ExternalFileCache` are core duckdb**, not httpfs
  (`duckdb/src/storage/caching_file_system.cpp`). The Parquet reader wraps whatever
  filesystem it is handed — `fs(CachingFileSystem::Get(context_p))`
  (`duckdb/extension/parquet/parquet_reader.cpp:871`). Block caching, range dedup, read
  coalescing and cache invalidation are **not ours to write**.
- `FileSystem` has one pure virtual (`GetName()`), `FileHandle` one (`Close()`). Everything
  else defaults to throwing, so we implement only what is actually called.
- The transport already exists: `QuackholeHTTPClient::Get` with a `Range:` header.

`CachingFileHandle::GetFileHandle` (`caching_file_system.cpp:112-128`) calls exactly:
`OpenFile`, `GetLastModifiedTime`, `GetVersionTag`, then `GetFileSize()` / `CanSeek()` /
`OnDiskFile()` on the handle. Reads land at `GetFileHandle().Read(context, buffer, nr_bytes,
location)` (`:136`, `:174`) — one positional read per ranged GET. Add `CanHandleFile`,
`GetName`, `Seek`/`SeekPosition`/`Reset`, `FileExists`, and a `Glob` returning the single
path when there is no wildcard (the default throws — `file_system.cpp:632`).

**Estimate: ~300-450 lines, 1-2 days to a working `read_parquet` over `.iroh`.** httpfs's
~1500+ lines are mostly things we would skip: S3 signing, HuggingFace, curl-vs-httplib
selection, its own pre-`ExternalFileCache` buffering, and download fallbacks.

### What would bite

- **A server that ignores `Range` returns 200 with the whole body.** Detect it and fail
  loudly, or we silently return wrong bytes — the same class of bug as the `Content-Length`
  truncation we already fixed.
- Quack's cpp-httplib server has no notion of `Range`, so serving *files* means pointing the
  bridge at something other than Quack. `quackhole_serve` currently bridges one fixed port.
- `GetVersionTag` wants an ETag, or the cache stays cold across handles.
- `CanHandleFile` must not collide with httpfs's claim on `https://`.

### Recommendation

If the goal is "existing httpfs behaviour over iroh", the **upstream httpfs change** is the
smaller and more correct fix; file an issue. Build the `FileSystem` only if we want files
over iroh sooner than upstream will move — and note it cuts against the README's "transport
bridge and nothing else" framing, so it is a scope decision, not a bug fix.

### Open question

`quackscale` delegates all three `InitializeParameters` overloads identically
(`quackscale/src/include/tailscale_http.hpp:85-92`), so structurally it should hit the same
wall — yet its README advertises `read_csv('http://my-laptop.ts.net:8000/sales.csv')` as
working. Either that claim is untested, or it works via their loopback proxy/forwarder rather
than the HTTPUtil route. Worth confirming before treating it as prior art.

---

## Idle sessions hold a relay open

**Status:** measured, not a problem yet. Worth knowing before anyone runs this at scale.

An attached session that is doing nothing is not free. iroh configures the QUIC connection
with a 5-second keep-alive against a 15-second path idle timeout — 30 seconds for a relay
path (`iroh/src/socket.rs:109,117,129`). Keep-alive is well inside the timeout, so a cached
connection survives indefinitely rather than dying and being redialled.

That is the behaviour we want (see the idle scenario in `test/docker/`: a session sat idle
15 minutes and then took a write with no reconnect). It also means **every idle ATTACH costs
n0's relay a packet every 5 seconds**, indefinitely, whether or not anyone is querying.

Two things follow:

- The cost of an abandoned browser tab or a forgotten `ATTACH` is not zero, and it lands on
  infrastructure that is not ours. This is the concrete version of the deferred "relay
  economics" question.
- Our `ConnCache` never evicts. Nothing currently closes an idle connection, so the process
  keeps it — and the relay traffic — alive for the life of the `DatabaseInstance`.

Neither is worth acting on at this scale. If it becomes one, the fix is an idle eviction in
`ConnCache` rather than anything in the transport: dropping a cached connection is already
safe, because `Attempt::BeforeSend` redials.
