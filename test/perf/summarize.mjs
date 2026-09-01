// results.csv -> a table you can paste into an issue.
import { existsSync, readFileSync } from 'node:fs';

const file = process.argv[2] ?? 'results.csv';
if (!existsSync(file)) {
  // The client writes the header before its first query, so a missing file
  // means it never started -- an attach failure, not an empty run.
  console.error(`no results at ${file}: the client never got as far as its first query.`);
  process.exit(1);
}
const lines = readFileSync(file, 'utf8').trim().split('\n');
const rows = lines.slice(1).map((line) => {
  // client.mjs strips commas and quotes out of error text, so the last field is
  // the only quoted one and a plain split is enough.
  const f = line.split(',');
  return {
    iso: f[0], elapsed: Number(f[1]), iter: Number(f[2]), op: f[3],
    ok: f[4] === 'true', ms: Number(f[5]), rows: Number(f[6]),
    bytes: Number(f[7]), path: f[8], error: (f.slice(9).join(',') || '').replace(/^"|"$/g, ''),
  };
});

/// Percentile by linear interpolation between ranks (R-7, numpy's default).
///
/// The obvious `xs[floor(p / 100 * n)]` clamps to the last index for every
/// n <= 100 at p99 -- so p99 printed the maximum, exactly, for every run this
/// harness has done. A column that looks like a tail statistic and is a copy of
/// the one beside it is worse than no column.
function pct(xs, p) {
  if (!xs.length) return 0;
  if (xs.length === 1) return xs[0];
  const rank = (p / 100) * (xs.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  return xs[lo] + (xs[hi] - xs[lo]) * (rank - lo);
}

/// Whether n samples can support percentile p at all.
///
/// A tail percentile needs at least one observation above it or it is pinned to
/// the maximum however it is interpolated: p99 needs 100 samples, p90 needs 10.
/// The median is a central statistic, meaningful at any n, so it is exempt.
const supports = (n, p) => (p <= 50 ? n >= 1 : n >= 100 / (100 - p));

const fmt = (n, d = 1) => n.toFixed(d).padStart(8);
const BLANK = '       -';
/// A percentile cell, or a dash when the sample count cannot justify one.
const cell = (xs, p) => (xs.length && supports(xs.length, p) ? fmt(pct(xs, p)) : BLANK);

const dial = rows.find((r) => r.op === 'dial');
const cold = rows.filter((r) => r.iter === 0 && r.op !== 'dial');
const steady = rows.filter((r) => r.iter > 0 && r.op !== 'dial');

console.log(`\n  ${file}`);
console.log(`  ${rows.length} samples, ${new Set(steady.map((r) => r.iter)).size} steady-state iterations`);
if (dial) console.log(`  attach (dial + relay handshake): ${dial.ms.toFixed(0)} ms`);
console.log(`  cold pass: ${cold.map((r) => `${r.op} ${r.ms.toFixed(0)}ms`).join(', ')}`);

const paths = {};
for (const r of steady) paths[r.path] = (paths[r.path] ?? 0) + 1;
console.log(`  path: ${Object.entries(paths).map(([p, n]) => `${p} ${((100 * n) / steady.length).toFixed(0)}%`).join(', ')}`);

console.log('\n  op       n    fail      p50      p90      p99      max     MB/s');
console.log('  ' + '-'.repeat(62));
for (const op of ['ping', 'agg', 'pull', 'push']) {
  const xs = steady.filter((r) => r.op === op);
  if (!xs.length) continue;
  const good = xs.filter((r) => r.ok);
  const ms = good.map((r) => r.ms).sort((a, b) => a - b);
  // Throughput per sample, then median -- a mean would let one stalled
  // iteration decide the number.
  const mb = good.filter((r) => r.bytes > 0).map((r) => r.bytes / 1e6 / (r.ms / 1000)).sort((a, b) => a - b);
  // An op where every sample failed has no latency to report, and printing 0.0
  // for it reads as "instant" rather than as "never completed".
  const lat = ms.length ? `${cell(ms, 50)}${cell(ms, 90)}${cell(ms, 99)}${fmt(ms.at(-1))}` : BLANK.repeat(4);
  console.log(
    `  ${op.padEnd(6)}${String(xs.length).padStart(4)}${String(xs.length - good.length).padStart(8)}` +
      lat + (mb.length ? fmt(pct(mb, 50)) : BLANK),
  );
}

// The sweep, when there was one. A transfer that is latency-bound rather than
// bandwidth-bound shows up here as MB/s climbing with size: the per-query
// overhead is fixed, so a bigger pull amortises it. Flat MB/s means the link
// itself is the limit.
const pullSizes = [...new Set(steady.filter((r) => r.op === 'pull').map((r) => r.rows))].sort((a, b) => a - b);
if (pullSizes.length > 1) {
  console.log('\n  pull rows       n    fail      p50      p90     MB/s   ms/1k rows');
  console.log('  ' + '-'.repeat(64));
  for (const size of pullSizes) {
    const xs = steady.filter((r) => r.op === 'pull' && r.rows === size);
    const good = xs.filter((r) => r.ok);
    const ms = good.map((r) => r.ms).sort((a, b) => a - b);
    const mb = good.map((r) => r.bytes / 1e6 / (r.ms / 1000)).sort((a, b) => a - b);
    console.log(
      `  ${String(size).padStart(9)}${String(xs.length).padStart(8)}${String(xs.length - good.length).padStart(8)}` +
        `${cell(ms, 50)}${cell(ms, 90)}${mb.length ? fmt(pct(mb, 50)) : BLANK}` +
        `${ms.length ? fmt((1000 * pct(ms, 50)) / size, 2) : BLANK}`,
    );
  }
}

// Reliability over time: the point of running for minutes rather than seconds.
console.log('\n  minute   samples   fail   ping p50   pull p50   pull MB/s');
console.log('  ' + '-'.repeat(58));
const byMinute = new Map();
for (const r of steady) {
  const m = Math.floor(r.elapsed / 60);
  if (!byMinute.has(m)) byMinute.set(m, []);
  byMinute.get(m).push(r);
}
for (const [m, xs] of [...byMinute].sort((a, b) => a[0] - b[0])) {
  // A minute can hold part of an iteration -- the ping in one and the pull in
  // the next -- so an empty bucket is normal and has to read as "no sample",
  // not as a 0.0 ms round trip.
  const p50 = (op) => {
    const ms = xs.filter((r) => r.op === op && r.ok).map((r) => r.ms).sort((a, b) => a - b);
    return ms.length ? cell(ms, 50) : BLANK;
  };
  const pulls = xs.filter((r) => r.op === 'pull' && r.ok);
  const mbps = pulls.length ? pulls.reduce((a, r) => a + r.bytes / 1e6 / (r.ms / 1000), 0) / pulls.length : 0;
  console.log(
    `  ${String(m).padStart(6)}${String(xs.length).padStart(10)}${String(xs.filter((r) => !r.ok).length).padStart(7)}` +
      `${p50('ping')}   ${p50('pull')}   ${pulls.length ? fmt(mbps) : '       -'}`,
  );
}

const errors = steady.filter((r) => !r.ok);
if (errors.length) {
  console.log(`\n  ${errors.length} failures:`);
  const seen = new Map();
  for (const e of errors) seen.set(e.error, (seen.get(e.error) ?? 0) + 1);
  for (const [msg, n] of [...seen].sort((a, b) => b[1] - a[1]).slice(0, 5)) console.log(`    ${n}x  ${msg}`);
} else {
  console.log('\n  no failures.');
}
const timeouts = errors.filter((r) => /timed out/.test(r.error));
if (timeouts.length) console.log(`  ${timeouts.length} of those were the client's own timeout, not an error from the link.`);
console.log('');
