# Reshape: give peer identity one owner

A brief for a fresh session. Everything needed to start is here; read
[`CLAUDE.md`](../CLAUDE.md) first for the conventions and the hazards, and
[`ARCHITECTURE.md`](ARCHITECTURE.md) for the layer diagram.

**Do not start until the vite migration in `site/` has landed.** Moves 1–3 stay
out of `site/` almost entirely; move 4 rewrites `site/app.js` and will conflict
head-on. Check `git log -- site/` and confirm `site/build.mjs` and
`site/serve.mjs` are gone (replaced by `vite.config.js`) before beginning.

---

## The thesis

**The browser learned things the native side hasn't, and the core — which both
already link — owns none of them.**

| | browser | native |
|---|---|---|
| relay | per-peer map (`web/bridge-worker.js:30`) | one global setting (`src/quackhole_extension.cpp:455`) |
| handoff | ticket, carries the relay | `attach_sql`, does not |
| address shape | `quackUrl()` (`site/app.js:43`) | `QuackUrl()` (`src/quackhole_extension.cpp:153`) |
| catalog naming | auto-uniquified | fixed `AS remote` |

Every row is the same defect: knowledge belonging to *a peer* is stored
globally, or spelled twice. PR #6 fixed the symptoms in four places instead of
the cause in one.

The address shape `quack:<id>.iroh:9494` is currently constructed or parsed in
four code locations:

- `src/quackhole_extension.cpp:153` — builds it
- `site/app.js:43` — builds it
- `web/bridge-worker.js:68` — parses it (`hostname.slice(0, -'.iroh'.length)`)
- `src/include/quackhole_http.hpp:11` — detects it

`crates/quackhole-core` owns none of them, despite already owning HTTP framing
for exactly this reason — see the framing bullet in `CLAUDE.md`. The precedent
for the fix is already in the repo; it just was not followed.

---

## Established facts

Verified empirically against live servers and relays. Re-deriving these costs
network tests and two coordinated DuckDB processes, so take them as given.

1. **`peer_addr(endpoint_id, relay_url)` already exists** in the core
   (`crates/quackhole-core/src/lib.rs:95`), and `qh_request`
   (`crates/quackhole-core/src/ffi.rs:246`) already takes a relay **per call**.
   The core has always been per-peer. Only the C++ surface flattened it.
2. **iroh-base 1.1 has no ticket type** — it exposes `EndpointAddr`, `RelayUrl`
   and `key` only. The `qh1_` format is genuinely ours to own; there is no iroh
   type to adopt instead.
3. **Two unnamed quack secrets collide** on `__default_quack` regardless of
   scope. A name is mandatory, not stylistic.
4. **Quack honours secret `SCOPE`**, resolving by the ATTACH path. A secret
   scoped elsewhere fails *identically to having none*: `Could not find a Quack
   authentication token` — which does not sound like a scope problem.
5. **A duplicate ATTACH alias fails loudly**: `Binder Error: Failed to attach
   database: database with name "remote" already exists`.
6. **`duckdb_databases()` lists an attached quack catalog** and drops it on
   DETACH, purely locally with no round trip. It is the exception to the
   enumerates-nothing rule in `CLAUDE.md`.
7. **Two servers on one machine need distinct Quack ports.** `quackhole_serve`
   binds `127.0.0.1:9494` and `scripts/quackhole-demo.sh` refuses to stack on
   it; use `target := '127.0.0.1:9495'` for the second. Needed to test anything
   multi-remote locally.

---

## Move 1 — `Peer` becomes a type in the core

A Rust type owning endpoint id + relay + token, with:

- `to_ticket()` / `parse_ticket(&str)` — the `qh1_` format
- `address()` → `quack:<id>.iroh:9494`
- `parse_address(&str)` → the peer, replacing the `slice()` in `bridge-worker.js`
- `secret_name()` → `qh_<id>`

Exposed **twice**: over the C ABI (`qh_ticket_parse`, `qh_peer_address`, …) and
over wasm-bindgen. That double binding is the pattern `http.rs` already uses.

**Deletes:** `MintTicket` (`:168`), `Base64Url` (`:122`), `QuackUrl` (`:153`),
`SecretName` (`:164`) from C++; `site/ticket.js` and `quackUrl` from JS.

**Note:** `Base64Url` exists only to serve `MintTicket`; check nothing else
grew a caller before deleting it.

Pure consolidation — no behaviour change, so it should land with the existing
tests unchanged. That is the point of doing it first.

---

## Move 2 — registration travels the same path as the dial

**The highest-value move.** The ack, the 10s timeout, the `BroadcastChannel`
(`site/app.js:113`, `web/bridge-worker.js:137`) and the CLAUDE.md gotcha
*"register a peer and wait for the ack before ATTACH"* all exist for exactly one
reason: registration was put on a **different** path from the dial, so it could
be overtaken.

Send it down the SharedArrayBuffer channel the shim already owns — add a control
frame to `web/protocol.js` alongside `CHUNK`/`META` — and the ordering problem
**cannot occur**. Same path, therefore same order.

**Deletes:** `peerRelays` as a page-fed map, the whole `__qh: 'peer'` /
`'peer-ack'` protocol, `registerPeer()` and its timeout, the `channel=` worker
param in `web/shim.js`, and one CLAUDE.md gotcha.

A seam is working when a documented hazard stops needing documenting.

**Hazards:** `shim.js` has a history of a temporal-dead-zone bug that only
surfaced when a caller omitted an optional query param (see CLAUDE.md). Exercise
both the param-present and param-absent paths. `?relay=` must keep working —
`test/browser` depends on it.

---

## Move 3 — `quackhole_attach(ticket)` replaces `attach_sql`

```sql
CALL quackhole_attach('qh1_…', as := 'laptop');
```

Secret + scope + ATTACH + relay registration, atomically, with a caller-chosen
alias.

**Deletes:** the `attach_sql` column (`src/quackhole_extension.cpp:212`, `:297`)
and the fixed `AS remote` wart.

**The functional win, not just tidiness:** native clients finally get the relay,
so a native attach stops depending on pkarr having seen a peer that started
seconds ago. Today only the browser has that. One artifact (the ticket), one
verb (attach), two surfaces.

`attach_sql` is documented by *position* in more than one place — see the
comment at `src/quackhole_extension.cpp:210`. Removing a column shifts the
others; grep for every consumer, including `README.md`, `description.yml` and
`scripts/`.

---

## Move 4 — `web/` ships a session, not just a transport

The repo's claim is that the demo uses `web/` unmodified. That is true of the
transport and false of everything above it: `site/app.js` is ~640 lines of
connection model tangled with DOM.

Extract a `QuackholeSession` into `web/` — attach, detach, list, query, the
`connections` model, the `duckdb_databases()` reconcile — leaving `app.js` as a
view. Then the claim is true and the thing is actually vendorable.

**Conflicts with the vite migration. Do this last, and only after it lands.**

---

## Sequencing

**1 → 3 → 2 → 4.**

One is pure consolidation and lands safely. Three rides on the vocabulary from
one and is the visible win. Two is the biggest deletion and wants the vocabulary
already in place. Four needs `site/` to have settled.

Rough size: 1 is about a day, 3 half, 2 a day with the browser testing, 4 a day.

## Verifying

Moves 1–3 cross both the C ABI and the wasm boundary, so **every step needs both
sides**:

    prek run --all-files
    make test                       # and QUACKHOLE_NET_TESTS=1 make test
    make rust-check
    test/browser/run.mjs bridge     # and iroh, and timeout
    site/verify.mjs                 # needs a live laptop; QH_TICKET2 for two

`site/verify.mjs` takes `QH_TICKET2` and, given a second laptop, queries both
remotes in one statement, refuses a duplicate ticket and detaches one. Use it —
it is the only check that exercises the multi-remote paths end to end.

## What this obsoletes

PR #6 introduced `MintTicket`, `QuackUrl`, `SecretName` and the BroadcastChannel
peer protocol. This reshape deletes all four. That is the intended trade
pre-release: PR #6 fixed the symptoms correctly and cheaply, and this fixes the
cause. Do not treat the deletions as a regression to be avoided.
