# perf

This laptop and one exe.dev VM, one serving a DuckDB over iroh and the other
querying it, for a fixed stretch of wall clock. Answers two questions: how fast
is a query across the link, and does the link still work in twenty minutes.

    test/perf/run.sh                    # 10 min; creates a VM, destroys it after
    test/perf/run.sh --duration 3600    # an hour
    test/perf/run.sh --vm <name>        # against a VM that already exists
    test/perf/run.sh --local server     # laptop serves, VM queries
    test/perf/run.sh --region fra       # place the VM across the Atlantic
    test/perf/run.sh --pull-rows 1000,50000   # sweep transfer sizes
    test/perf/run.sh --timeout 180      # per-query deadline, seconds
    test/perf/run.sh --keep             # leave it up, print the reuse command

Laptop-to-VM rather than VM-to-VM on purpose. Two VMs in one datacenter hole
punch immediately over the LAN and measure almost nothing about a
NAT-traversing transport; a laptop on home Wi-Fi reaching a cloud box is the
case quackhole exists for.

Unless `--vm` names an existing one, it creates a billed VM. `cleanup` is
trapped on EXIT, so a failed setup, a hung client and a Ctrl-C at minute three
all still destroy it; `--keep` is the only way to leave it running, and it
prints the `ssh exe.dev rm` to undo that.

`--local` picks which end runs here. `client` (the default) makes `pull` a
download to the laptop. `server` is the NAT'd-laptop story from the top-level
README, and makes `pull` a *upload* from the laptop -- on an asymmetric home
connection those are very different numbers, which is the point of having both.

## What it measures

Four queries, on a fixed cadence, for a fixed duration. No adaptive load and no
warm pools: the point is a series you can read down a column, not a peak number.

| op | query | what it isolates |
|---|---|---|
| `ping` | `count(*)` of a one-row table | round-trip floor, no scan behind it |
| `agg` | `count`/`sum` over the whole remote table | pushdown: a scan whose result is one row, so cost that is not transfer |
| `pull` | `CREATE TABLE … AS SELECT … FROM srv.events LIMIT n` | rows down the wire |
| `push` | `INSERT INTO srv.sink SELECT … FROM range(…)` | rows up the wire, on the write path |

Each writes one CSV row — `iso, elapsed_s, iter, op, ok, ms, rows, bytes, path,
error` — appended as it goes, so a run that dies at minute nine of ten still has
nine minutes of data on disk. `path` is `direct` or `relay`, read from
`quackhole_status()` each iteration, because an upgrade off the relay mid-run is
exactly what a latency series should show.

Iteration 0 is the cold pass, reported separately so the first post-dial query
does not decide a p99.

None of these is a single round trip, which is worth knowing before reading the
numbers as latency. Laptop to Frankfurt, 50 iterations, `ping` held at 168 ms
p50 -- but `agg` returned its one row in 5.3 s p50, some thirty times the round
trip, against 35 ms for the same query on loopback. The best-case 1,000-row
`pull` took ~6 round trips for 88 KB. Something is chattier than the shape of
the query suggests; that is an observation from timings, not from a trace.

`bytes` is **payload bytes, not wire bytes**: `rows × 88` for pull and
`rows × 84` for push, from the fixed-width schemas in `server.mjs`. The payload
column is `md5(id) || md5(id+1)`, varying per row, so the number is not an
artifact of dictionary compression. It does not count QUIC or Quack framing, and
it is not what a packet capture would show. For `agg`, `rows` is the remote row
count scanned, not rows transferred.

## Quack does not push a WHERE down through a scan

Measured against a local server holding 200,000 rows:

    CTAS host_info (1 row table)                 1.7 ms
    CTAS events WHERE id < 1000                241.7 ms
    CTAS events WHERE id < 100000              239.0 ms
    CTAS events (all 200000)                   237.2 ms
    CTAS events LIMIT 1000                      29.4 ms
    count(*) WHERE id < 1000 (aggregate)        34.9 ms

The three WHERE forms are the same number because they do the same work: the
whole table crosses the link and DuckDB filters locally. Per-query overhead is
not the explanation -- a one-row table answers in 1.7 ms. `LIMIT` *is* pushed
down, and so are aggregates.

So `pull` uses `LIMIT n`, not `WHERE id < n`. A WHERE-based sweep measures one
transfer size three times and labels it as three, which is exactly what the
first version of this harness did: its sweep came back flat at 223/225/228 ms
for 5k/25k/100k rows, and the flatness was the bug, not a finding about
bandwidth. With LIMIT the same sweep is 33/65/158 ms for 1k/25k/100k.

If you add an op here, check it against that table before trusting its `bytes`.

## Things worth knowing

- **`quackhole_ephemeral` is set on both sides.** Every run gets a fresh
  endpoint id, so a stale ticket cannot dial successfully and then fail at token
  auth — and the laptop can serve and attach in the same session without iroh
  refusing the dial with `connecting to ourself is not supported`.
- **A leftover `server.mjs` is killed before starting a new one.** It would
  still hold `127.0.0.1:9494`, and `quackhole_serve` reuses whatever is already
  listening there rather than starting its own — so the new server is handed the
  old one's Quack and prints a token that Quack does not accept. The client then
  fails to attach with an authentication error that names nothing.
- **The extension is the GitHub release asset, loaded by path**, the way
  `npm/bin/quackhole.js` does it — so the binary under test is the one that
  shipped, not whatever community-extensions serves today. `--version` picks a
  different release; each side fetches the asset for its own platform, so the
  laptop gets `osx_arm64` and the VM `linux_amd64`.
- **`@duckdb/node-api` is pinned to `1.5.5-r.4`.** Its `version()` is v1.5.5,
  the `duckdb_version` the extension is built against, so the ABI match is true
  by construction. Do not loosen it to a range.
- **exeuntu ships Node 18** and `@duckdb/node-api` wants 20+, so `setup.sh`
  installs a current v22 LTS under `$HOME` — no sudo, no apt, and resolved from
  nodejs.org rather than pinned, because a pinned patch release is a 404 waiting
  to happen. On macOS it refuses instead: upgrading the user's node behind their
  back is not this script's business.

## exe.dev's CLI is ssh, and it has two sharp edges

- **Value flags take `=`, and the value must not contain a space.** `ssh` joins
  its argv into one string and the far side re-splits it, so `--comment=a b`
  arrives as a flag plus a positional and `new` rejects the whole invocation
  with `"new" command has no subcommands and does not take positional
  arguments` — which does not sound like a quoting problem.
- **exe.dev places VMs from an account-wide preference, not a flag on `new`.**
  `--region` therefore sets it, creates, and restores the original — on the EXIT
  trap too, so an interrupted run does not leave the account pointing somewhere
  else.

## Other things that bite

- **`a && b &` backgrounds the list in a subshell that still holds ssh's
  stdout.** Redirecting only the last command leaves ssh waiting on that
  subshell for as long as the server runs, which is forever. The redirect has to
  wrap the whole group: `{ cd … && setsid nohup node …; } > log 2>&1 </dev/null &`.
- **`pkill -f server.mjs` over ssh matches the shell running it**, because that
  shell's own command line contains the pattern — so it kills its own session
  and returns non-zero. `pkill -f 'node server[.]mjs'` does not.
- **`at` is a reserved word in DuckDB**, which is why `sink` has `sent_at`.
- **`quackhole_status()` calls the column `peer_path`, not `path`.**
- **A query past `--timeout` (default 90s) is interrupted, not abandoned.**
  `Promise.race` picks a winner but does not cancel the loser, so a bare race
  leaves the hung query holding the connection and every later iteration queues
  behind it. `DuckDBConnection.interrupt()` cancels the running statement, which
  is what makes the next iteration usable. The abandoned promise still needs a
  `.catch()`: an unhandled rejection arriving later takes the process down.

## Without a VM

`server.mjs` and `client.mjs` run against each other on one machine — that is
the `quackhole_ephemeral` case above, so the ids differ and iroh does not refuse
the dial. Point both at a local build with `--ext`:

    QHPERF_DIR=/tmp/qh node server.mjs --rows 20000 --ext ../../build/release/extension/quackhole/quackhole.duckdb_extension
    QHPERF_DIR=/tmp/qh node client.mjs --ticket qh1_… --duration 30 --interval 3 --ext <same>
    node summarize.mjs /tmp/qh/results.csv

It proves the harness, not the network: the path is `direct` over loopback.
