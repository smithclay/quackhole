# Troubleshooting

Fixes keyed by the error you actually see. Each heading is the message, verbatim where the
message is quotable, because that is what you searched for.

## "Could not find a Quack authentication token"

The secret exists but is not scoped to the path you `ATTACH`ed, or an unnamed secret
collided. Quack resolves the secret by the ATTACH path, so the `SCOPE` must be
character-for-character the address you attach — and DuckDB stores an unnamed quack secret
as `__default_quack`, a single global a second `CREATE SECRET` collides with.

Fix: let `quackhole_attach('qh1_…', name := '…')` build the secret; it names and scopes it
for you. By hand, the shape is:

```sql
CREATE SECRET qh_<endpoint-id> (TYPE quack, TOKEN 'your-shared-token',
                                SCOPE 'quack:<endpoint-id>.iroh:9494');
```

## "did not contain the expected entrypoint function"

The extension file was renamed. DuckDB derives the entrypoint symbol from the file's
basename, so `quackhole-osx_arm64.duckdb_extension` (the release asset name) makes it look
for `quackhole-osx_arm64_duckdb_cpp_init`, which does not exist. It is a filename problem
that does not sound like one.

Fix: save the file as exactly `quackhole.duckdb_extension` before `LOAD`ing it — or skip
the download entirely with `INSTALL quackhole FROM community;`, which cannot get this
wrong.

## "signature is either missing" at LOAD

You loaded an unsigned binary — one downloaded from the GitHub release, or built locally —
and DuckDB refuses those by default.

Fix: `INSTALL quackhole FROM community; LOAD quackhole;` installs the signed build and
needs no flag. If you specifically want the release or a local binary (pinning, or
developing on the repo), start DuckDB with `-unsigned`, or set
`allow_unsigned_extensions` before opening the database. `npx quackhole` handles this for
you.

## "connecting to ourself is not supported"

A client and a server in the same process — or two processes on one machine — loaded the
same key from `~/.quackhole/key`, so both sides share one endpoint id and iroh refuses the
dial.

Fix, before the endpoint binds (which can happen on your first `.iroh` ATTACH):

```sql
SET GLOBAL quackhole_ephemeral = true;
```

On two machines there is nothing to do.

## ATTACH times out against a server that just started

You attached with a bare endpoint id — no ticket, no registered relay — so iroh fell back to
resolving the peer through pkarr, a third party that must have seen the server publish
first. A server started seconds ago routinely has not published yet.

Fix: use the ticket. `quackhole_attach('qh1_…')` registers the relay the ticket carries
before it dials. In the browser the same rule holds: pass the ticket, not the id.

## "Unauthorized", or a 401 — the token a second server printed is rejected

`quackhole_serve` binds Quack on `127.0.0.1:9494` by default and *reuses* whatever is
already listening there rather than starting its own. A second server on the same machine
is therefore handed the first one's Quack, and the token it prints is not a token that
Quack accepts.

Fix: give the second server its own port — `quackhole_serve(target := '127.0.0.1:9495')`,
or `npx quackhole --port 9495`.

## The browser worker dies with an error event carrying no message

The page is not cross-origin isolated. The transport parks the DuckDB thread in
`Atomics.wait` on a `SharedArrayBuffer`, which browsers only hand to a page serving
`Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`.
A worker fetched over a 200 still refuses to start, and the error event says nothing.

Fix: send both headers from your origin. On a host that cannot set headers (GitHub Pages),
copy `coi-serviceworker.js` to your own origin's *root* — a service worker registers itself
by its own URL, so a copy under `assets/` silently scopes itself to `assets/`. Ask
`quackhole.check()` first; it names the problem and the fix.

## A CORS error for `.wasm` files, in a vendored or packaged setup

Usually not CORS at all: the wasm files are missing and the 404 response carries no
`Access-Control-Allow-Origin`, which the browser reports as a CORS failure. Common cause
when repackaging: `web/wasm/.gitignore` is `*`, and a copy step that preserves it makes npm
drop the entire directory from the tarball.

Fix: verify the `.wasm` URL responds 200 directly, and exclude that `.gitignore` from any
copy.

## A 404 inside a worker after importing from jsDelivr

You imported the package through `/+esm`. That transform bundles everything into one
module, but `quackhole.js` must stay unbundled: it derives its base from `import.meta.url`
and fetches `web/qh-worker.js` as a real sibling over the network, and under `+esm` there
is no sibling to fetch.

Fix: pin the plain file path — `https://cdn.jsdelivr.net/npm/quackhole@0/dist/quackhole.js`.

## "Invalid connection id" in the workbench, after every statement

`.open` at the shell's prompt resets the database. Every connection goes with it, every
attached catalog goes with it, and so does the `quack` extension the transport needs — but
the shell writes its message and returns *before* it reconnects, so it is left holding the
connection id the reset destroyed. Every statement after that fails the same way.

The page rebuilds its own session underneath, which is why the connection rail empties
rather than going stale, but it cannot hand the shell a new connection id.

Fix: reload the page. Anything that had been loaded into the browser-side database is gone
either way — that is what `.open` did.

## `read_csv('https://<id>.iroh:9494/…')` cannot connect

Quackhole carries Quack traffic only. httpfs builds its own HTTP client and never consults
the transport quackhole installs, so `.iroh` hosts do not work for `read_csv`, `read_parquet`
or any direct file read.

Fix: `ATTACH` the remote and reach the data with SQL.

## Listing tables on an attached remote returns nothing

Not an error, but it looks like one: a Quack-attached catalog enumerates nothing.
`duckdb_tables()`, `SHOW TABLES FROM <db>` and `information_schema` are all empty for it —
it resolves table names on demand and nothing more.

Fix: `SELECT name FROM <db>.sqlite_master;` is the one listing Quack pushes down to the
remote.
