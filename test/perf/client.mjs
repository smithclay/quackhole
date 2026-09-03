// The client half: attach the ticket, then hammer four fixed queries on an
// interval and write one CSV row per query.
//
// Deliberately dumb. No adaptive load, no warm pools, no percentile streaming:
// a fixed workload on a fixed cadence for a fixed duration, appended to disk as
// it goes, so a run that dies at minute 9 of 10 still has nine minutes of data.
import { DuckDBInstance } from '@duckdb/node-api';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Where the run keeps its database, extension and results. The VM side leaves
// this unset and lands in ~/qhperf; the laptop side points it at test/perf/.local.
const DIR = process.env.QHPERF_DIR ?? join(process.env.HOME, 'qhperf');

const opt = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};

const ticket = opt('ticket') ?? process.env.QH_TICKET;
if (!ticket) throw new Error('--ticket or QH_TICKET is required');
const duration = Number(opt('duration', 600)); // seconds
const interval = Number(opt('interval', 5)); // seconds between iterations
// A comma list sweeps: iteration i pulls sizes[i % sizes.length]. Cycling
// rather than doing every size each iteration, so over a long run each size is
// sampled across varied network conditions instead of all of them being
// measured back to back under whatever the link was doing that minute.
const pullSizes = String(opt('pull-rows', 50_000)).split(',').map(Number);
const pushRows = Number(opt('push-rows', 5_000));
// A query that hangs would otherwise stall the loop forever, and a stalled loop
// looks exactly like a slow one in the CSV.
const timeoutMs = Number(opt('timeout', 90)) * 1000;
const out = opt('out', join(DIR, 'results.csv'));
const ext = opt('ext', join(DIR, 'ext', 'quackhole.duckdb_extension'));

// Byte widths implied by the schemas in server.mjs. Payload bytes, not wire
// bytes: this counts what the query moved, not what QUIC put on the link.
const PULL_ROW_BYTES = 8 + 8 + 8 + 64;
const PUSH_ROW_BYTES = 4 + 8 + 8 + 64;

const sql = (s) => `'${String(s).replaceAll("'", "''")}'`;

const instance = await DuckDBInstance.create(join(DIR, 'client.db'), {
  allow_unsigned_extensions: 'true',
});
const conn = await instance.connect();
const all = async (q) => (await conn.runAndReadAll(q)).getRowObjectsJS();

await conn.run('INSTALL quack');
await conn.run('LOAD quack');
await conn.run(`LOAD ${sql(ext)}`);
await conn.run('SET GLOBAL quackhole_ephemeral = true');

console.log('attaching…');
const dialStart = performance.now();
await conn.run(`CALL quackhole_attach(${sql(ticket)}, name := 'srv')`);
const dialMs = performance.now() - dialStart;
console.log(`attached in ${dialMs.toFixed(0)} ms`);

writeFileSync(out, 'iso,elapsed_s,iter,op,ok,ms,rows,bytes,path,error\n');

/// The one path a peer is reachable on right now: 'direct' once iroh has hole
/// punched, 'relay' while it is still going through n0.
async function peerPath() {
  try {
    const rows = await all("SELECT peer_path FROM quackhole_status() WHERE peer_path IS NOT NULL");
    return rows.map((r) => r.peer_path).join('+') || 'unknown';
  } catch {
    return 'unknown';
  }
}

const started = Date.now();
// Only for the progress line; each CSV row carries the path measured around its
// own query.
let lastPath = 'unknown';

/// Runs a query under a deadline.
///
/// On expiry it interrupts the connection rather than just abandoning the
/// promise: duckdb_interrupt cancels the running statement, so the next
/// iteration gets a usable connection instead of queueing behind a query that
/// is never coming back. Without this a single hang ends the run's usefulness
/// while leaving it apparently alive.
async function withTimeout(run) {
  let timer;
  const query = run();
  // Promise.race abandons the loser but does not cancel it. Once the timeout
  // wins, this promise still rejects later, and an abandoned rejection with no
  // handler takes the process down with it.
  query.catch(() => {});
  try {
    return await Promise.race([
      query,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          conn.interrupt();
          reject(new Error(`timed out after ${timeoutMs / 1000} s`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/// One timed query. Never throws: a failed op is a data point, not the end of
/// the run, because reliability over time is half of what this measures.
async function timed(iter, op, query, rowsMoved, bytesMoved) {
  // Sampled around each query, and outside the timed region. A single op runs
  // for a minute or more cross-region -- long enough for iroh to upgrade off
  // the relay while it is in flight -- so a path read once per iteration would
  // stamp every op in that iteration with whatever was true at the top, and the
  // mislabelling would be undetectable because all four rows would agree.
  const before = await peerPath();
  const t0 = performance.now();
  let ok = true;
  let error = '';
  let rows = rowsMoved;
  try {
    const result = await withTimeout(() => all(query));
    if (rowsMoved === null) rows = Number(result[0]?.n ?? result.length);
  } catch (err) {
    ok = false;
    error = err.message.replaceAll(/[\r\n",]+/g, ' ').slice(0, 200);
    rows = 0;
  }
  const ms = performance.now() - t0;
  // An op that spans a transition records it as `relay>direct` rather than
  // silently picking one end.
  const after = await peerPath();
  const path = before === after ? after : `${before}>${after}`;
  lastPath = path;
  const bytes = ok ? (bytesMoved ?? 0) : 0;
  appendFileSync(
    out,
    `${new Date().toISOString()},${((Date.now() - started) / 1000).toFixed(1)},${iter},${op},${ok},${ms.toFixed(2)},${rows},${bytes},${path},"${error}"\n`,
  );
  return ok;
}

async function iteration(iter) {
  // A single row from a one-row table: the round-trip floor, with no scan
  // behind it.
  await timed(iter, 'ping', 'SELECT count(*) AS n FROM srv.host_info', null, 0);
  // A full remote aggregate: pushed down, so the result is one row and this is
  // not a transfer. It is emphatically not one round trip either -- 5.3 s p50
  // laptop to Frankfurt against a 170 ms RTT, and 35 ms for the same query on
  // loopback. Where the rest of that time goes has not been traced.
  await timed(iter, 'agg', 'SELECT count(*) AS n, sum(value) AS s FROM srv.events', null, 0);
  // Rows down the wire, into a local table. The size comes off the sweep cycle,
  // so `rows` in the CSV is what distinguishes one pull sample from another.
  //
  // LIMIT rather than `WHERE id < n`, because Quack does not push a predicate
  // down through a full-column scan: `WHERE id < 1000` and `WHERE id < 100000`
  // and no clause at all all transfer the whole table and filter locally, so a
  // WHERE-based sweep measures the same transfer three times and reports it as
  // three sizes. LIMIT is pushed down and does scale. Verified against a local
  // server: WHERE 1k/100k/all = 242/239/237 ms, LIMIT 1k/100k = 33/158 ms.
  const pullRows = pullSizes[iter % pullSizes.length];
  await timed(
    iter,
    'pull',
    `CREATE OR REPLACE TABLE pull_local AS SELECT * FROM srv.events LIMIT ${pullRows}`,
    pullRows,
    pullRows * PULL_ROW_BYTES,
  );
  // Rows up the wire. Generated locally from range() so the source is not the
  // remote, and INSERT so the write path is what is being timed.
  await timed(
    iter,
    'push',
    `INSERT INTO srv.sink SELECT ${iter}, now(), range::BIGINT,
       md5(range::VARCHAR) || md5((range + 1)::VARCHAR) FROM range(${pushRows})`,
    pushRows,
    pushRows * PUSH_ROW_BYTES,
  );
}

// Iteration 0 is the cold one: first real traffic after the dial, before iroh
// has had a chance to upgrade off the relay. summarize.mjs reports it on its
// own rather than letting it skew a p99.
console.log('warmup…');
await iteration(0);

const deadline = started + duration * 1000;
let iter = 1;
console.log(`running ${duration}s, one iteration every ${interval}s, pull sizes ${pullSizes.join('/')}`);
while (Date.now() < deadline) {
  const top = Date.now();
  await iteration(iter);
  const elapsed = ((Date.now() - started) / 1000).toFixed(0);
  process.stdout.write(`\r  iter ${iter} at ${elapsed}s over ${lastPath}   `);
  iter += 1;
  // Sleep the remainder of the interval, so cadence is wall-clock and a slow
  // iteration eats its own slack instead of shifting every later one.
  const rest = interval * 1000 - (Date.now() - top);
  if (rest > 0) await new Promise((r) => setTimeout(r, rest));
}

console.log(`\ndone: ${iter - 1} iterations, results in ${out}`);
appendFileSync(out, `,,,dial,true,${dialMs.toFixed(2)},0,0,${lastPath},""\n`);
process.exit(0);
