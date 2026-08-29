// Phase 2, step 1: prove DuckDB-Wasm's quack client works over plain HTTP
// before any iroh or shim code exists.
//
// Starts a native DuckDB serving quack on 127.0.0.1:9494, serves the test page,
// drives headless Chromium at it, and asserts on the query results. A failure
// here is a failure in duckdb-wasm or quack, not in anything we wrote -- which
// is the whole point of running it first.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';
import * as esbuild from 'esbuild';
import { startServer } from './serve.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const DUCKDB = process.env.QH_DUCKDB ?? join(REPO, 'build', 'release', 'duckdb');
const TOKEN = 'browser-test-token';
const PORT = Number(process.env.QH_PORT ?? 0);
const QUACK_PORT = 9494;

// 'direct'  -- stock duckdb-wasm, plain HTTP. Proves the quack client path.
// 'bridge'  -- same SQL through the XHR shim and the Atomics bridge, still
//              over plain HTTP. Proves the sync/async bridge in isolation.
// 'iroh'    -- the real thing: the bridge's far end is an iroh endpoint and
//              the server is an unmodified quackhole_serve.
// 'timeout' -- fault injection: the bridge stops answering, and the run must
//              fail promptly rather than wedging the DuckDB worker forever.
const MODE = process.argv[2] ?? 'direct';
if (!['direct', 'bridge', 'iroh', 'timeout'].includes(MODE)) {
  throw new Error(`unknown mode ${MODE}`);
}
// Short, because the test spends the whole budget on purpose.
const TIMEOUT_MS = Number(process.env.QH_TIMEOUT_MS ?? (MODE === 'timeout' ? 2000 : 30000));
// Matches GRACE_MS in shim.js: the shim waits a little past the bridge's own
// budget so the bridge's more specific error wins when there is one.
const GRACE_MS = 5000;
// SharedArrayBuffer, and therefore Atomics.wait, requires cross-origin isolation.
const COI = MODE !== 'direct' || process.env.QH_COI === '1';

const log = (msg) => console.log(`[run] ${msg}`);

function startQuackServer() {
  if (!existsSync(DUCKDB)) {
    throw new Error(`no duckdb binary at ${DUCKDB} -- run 'make release' or set QH_DUCKDB`);
  }
  const proc = spawn(DUCKDB, [], { stdio: ['pipe', 'pipe', 'pipe'] });
  const out = [];
  proc.stdout.on('data', (d) => out.push(String(d)));
  proc.stderr.on('data', (d) => out.push(String(d)));

  // stdin is deliberately left open: the CLI reads until EOF, so keeping the
  // pipe open keeps the server alive for the duration of the test.
  // In iroh mode the server is the real extension, serving over the relay.
  // Nothing about it is browser-specific: this is the same quackhole_serve the
  // native cross-network test uses, which is the point.
  const serve =
    MODE === 'iroh'
      ? `LOAD quackhole;
SET GLOBAL quackhole_ephemeral = true;
CALL quackhole_serve(token := '${TOKEN}');
SELECT 'SERVER_READY', endpoint_id FROM quackhole_status();`
      : `CALL quack_serve('quack:localhost:${QUACK_PORT}', token := '${TOKEN}');
SELECT 'SERVER_READY';`;

  proc.stdin.write(`
.mode list
.headers off
INSTALL quack; LOAD quack;
CREATE TABLE logs AS SELECT range AS id, 'evt_' || range AS name FROM range(1000);
CREATE TABLE wide AS SELECT range AS id, repeat('x', 8) AS payload FROM range(200000);
${serve}
`);

  const ready = (async () => {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const text = out.join('');
      const line = text.split('\n').find((l) => l.startsWith('SERVER_READY'));
      if (line) return line.split('|')[1] ?? null;
      if (proc.exitCode !== null) throw new Error(`duckdb exited early:\n${text}`);
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`server never became ready:\n${out.join('')}`);
  })();

  /// Re-runs `sql` down the still-open stdin until `marker` carries a value.
  ///
  /// Polling rather than asking once because some answers appear late: the
  /// home relay is not known the instant an endpoint binds, and a peer has no
  /// path until the first request crosses it.
  const poll = async (sql, marker, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      proc.stdin.write(sql + '\n');
      await new Promise((r) => setTimeout(r, 1000));
      const hits = out.join('').split('\n').filter((l) => l.startsWith(marker));
      const last = hits[hits.length - 1];
      const value = last?.split('|')[1];
      if (value && value !== 'NULL' && value !== '') return value;
    }
    return null;
  };

  return { proc, ready, poll, output: out };
}

// The duckdb-wasm ESM entry point imports 'apache-arrow' by bare specifier,
// which no browser can resolve, so the page has to be bundled. The worker
// scripts and .wasm files are still served verbatim from node_modules.
async function bundlePage() {
  await esbuild.build({
    entryPoints: [join(HERE, 'app.mjs')],
    outfile: join(HERE, 'public', 'bundle.js'),
    bundle: true,
    format: 'esm',
    logLevel: 'warning',
  });
}

async function main() {
  await bundlePage();
  log('page bundled');

  const server = startQuackServer();
  const endpointId = await server.ready;
  const attach =
    MODE === 'iroh'
      ? `quack:${endpointId}.iroh:${QUACK_PORT}`
      : `quack:localhost:${QUACK_PORT}`;
  log(MODE === 'iroh' ? `serving as ${endpointId}` : `quack serving on 127.0.0.1:${QUACK_PORT}`);

  // The home relay is not known the instant the endpoint binds, so poll for
  // it. Handing it to the browser lets iroh connect without an address
  // lookup, which a freshly published endpoint routinely fails.
  let relay = '';
  if (MODE === 'iroh') {
    relay = await server.poll("SELECT 'SERVER_RELAY', relay_url FROM quackhole_status();", 'SERVER_RELAY', 30_000);
    if (!relay) throw new Error('server never reported a home relay');
    log(`home relay ${relay}`);
  }

  const { server: http, port } = await startServer(PORT, { coi: COI });
  log(`page on http://127.0.0.1:${port}`);

  const browser = await chromium.launch();
  const page = await browser.newPage();
  const intercepted = [];
  const shimErrors = [];
  page.on('console', (m) => {
    const text = m.text();
    if (text.startsWith('[qh-shim] intercept')) intercepted.push(text);
    else if (text.startsWith('[qh-shim] failed')) shimErrors.push(text);
    else log(`  browser: ${text}`);
  });
  page.on('pageerror', (e) => log(`  browser error: ${e.message}`));

  await page.addInitScript(
    `window.__token = ${JSON.stringify(TOKEN)};
     window.__mode = ${JSON.stringify(MODE)};
     window.__intercept = ${JSON.stringify(`localhost:${QUACK_PORT}`)};
     window.__chunk = ${JSON.stringify(process.env.QH_CHUNK ?? '65536')};
     window.__bridgeMode = ${JSON.stringify(MODE === 'iroh' ? 'iroh' : 'fetch')};
     window.__attach = ${JSON.stringify(attach)};
     window.__relay = ${JSON.stringify(relay)};
     window.__debug = ${JSON.stringify(MODE === 'direct' && process.env.QH_DEBUG !== '1' ? '0' : '1')};
     window.__timeout = ${JSON.stringify(String(TIMEOUT_MS))};
     window.__fault = ${JSON.stringify(MODE === 'timeout' ? 'blackhole' : '')};`,
  );
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction('window.__done === true', null, { timeout: 120_000 });
  const result = await page.evaluate('window.__result');

  // Ask the server what it actually saw. A browser cannot do anything but
  // relay -- iroh compiles its IP transport out entirely under cfg(wasm_browser)
  // -- but asserting it here means the claim rests on an observation rather
  // than on reading the cfg.
  let peerPath = null;
  if (MODE === 'iroh') {
    peerPath = await server.poll(
      "SELECT 'SERVER_PEER', peer_path FROM quackhole_status();",
      'SERVER_PEER',
      10_000,
    );
  }

  await browser.close();
  http.close();
  server.proc.stdin.end();
  server.proc.kill();

  console.log(`\n=== result (mode: ${MODE}) ===`);

  if (MODE === 'timeout') {
    // The guard is worth nothing if it only exists. Assert that it fired, that
    // it said why, and -- the point of the whole exercise -- that the run ended
    // at all rather than blocking in Atomics.wait forever.
    const budget = TIMEOUT_MS + GRACE_MS;
    // Asserted against the shim's own console output rather than the error
    // DuckDB reports, because DuckDB does not carry our message: quack renders
    // HTTPResponse::GetError (quack_client.cpp:63), which is duckdb-wasm's
    // generic text. Checking the console is what distinguishes "our deadline
    // fired" from "something else failed to happen within the budget".
    const timeoutChecks = [
      ['query failed', !result.ok, true],
      ['our deadline fired', shimErrors.some((e) => /did not respond/.test(e)), true],
      ['gave up in time', result.elapsedMs < budget * 3, true],
    ];
    let bad = false;
    for (const [name, got, want] of timeoutChecks) {
      const ok = got === want;
      bad ||= !ok;
      console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name} = ${got}${ok ? '' : ` (want ${want})`}`);
    }
    console.log(`\n  budget   ${budget}ms`);
    console.log(`  gave up  ${result.elapsedMs?.toFixed(0)}ms`);
    console.log(`  shim     ${shimErrors[0] ?? '<none>'}`);
    console.log(`  duckdb   ${(result.error ?? '').split('\n')[0]}`);
    console.log(`\n==> ${bad ? 'FAIL' : 'PASS'}`);
    process.exitCode = bad ? 1 : 0;
    return;
  }

  if (!result.ok) {
    console.log(`requests through the shim: ${intercepted.length}`);
    console.log(result.error);
    console.log('\n==> FAIL');
    process.exitCode = 1;
    return;
  }

  const checks = [
    ['count', result.count, 1000],
    ['point', result.name, 'evt_42'],
    ['wide', result.wide, 1600000],
  ];
  // The correctness checks above pass identically whether or not the shim ran,
  // so bridge mode has to prove the requests actually went through it.
  if (MODE !== 'direct') checks.push(['shim used', intercepted.length > 0, true]);
  if (MODE === 'iroh') checks.push(['peer path', peerPath, 'relay']);
  if (MODE === 'direct') checks.push(['shim absent', intercepted.length === 0, true]);
  let failed = false;
  for (const [name, got, want] of checks) {
    const ok = got === want;
    failed ||= !ok;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name} = ${got}${ok ? '' : ` (want ${want})`}`);
  }
  console.log(`\n  requests through the shim: ${intercepted.length}`);
  console.log(`\n  engine   ${result.version}`);
  console.log(`  attach   ${result.attachMs.toFixed(0)}ms`);
  console.log(`  count    ${result.countMs.toFixed(0)}ms`);
  console.log(`  point    ${result.pointMs.toFixed(0)}ms`);
  console.log(`  wide     ${result.wideMs.toFixed(0)}ms`);
  console.log(`\n==> ${failed ? 'FAIL' : 'PASS'}`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
