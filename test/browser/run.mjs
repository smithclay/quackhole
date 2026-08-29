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
  proc.stdin.write(`
.mode list
.headers off
INSTALL quack; LOAD quack;
CREATE TABLE logs AS SELECT range AS id, 'evt_' || range AS name FROM range(1000);
CALL quack_serve('quack:localhost:${QUACK_PORT}', token := '${TOKEN}');
SELECT 'SERVER_READY';
`);

  const ready = (async () => {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (out.join('').includes('SERVER_READY')) return;
      if (proc.exitCode !== null) throw new Error(`duckdb exited early:\n${out.join('')}`);
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`quack_serve never became ready:\n${out.join('')}`);
  })();

  return { proc, ready, output: out };
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
  await server.ready;
  log(`quack serving on 127.0.0.1:${QUACK_PORT}`);

  const { server: http, port } = await startServer(PORT, { coi: process.env.QH_COI === '1' });
  log(`page on http://127.0.0.1:${port}`);

  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on('console', (m) => log(`  browser: ${m.text()}`));
  page.on('pageerror', (e) => log(`  browser error: ${e.message}`));

  await page.addInitScript(`window.__token = ${JSON.stringify(TOKEN)};`);
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction('window.__done === true', null, { timeout: 120_000 });
  const result = await page.evaluate('window.__result');

  await browser.close();
  http.close();
  server.proc.stdin.end();
  server.proc.kill();

  console.log('\n=== result ===');
  if (!result.ok) {
    console.log(result.error);
    console.log('\n==> FAIL');
    process.exitCode = 1;
    return;
  }

  const checks = [
    ['count', result.count, 1000],
    ['point', result.name, 'evt_42'],
  ];
  let failed = false;
  for (const [name, got, want] of checks) {
    const ok = got === want;
    failed ||= !ok;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name} = ${got}${ok ? '' : ` (want ${want})`}`);
  }
  console.log(`\n  engine   ${result.version}`);
  console.log(`  attach   ${result.attachMs.toFixed(0)}ms`);
  console.log(`  count    ${result.countMs.toFixed(0)}ms`);
  console.log(`  point    ${result.pointMs.toFixed(0)}ms`);
  console.log(`\n==> ${failed ? 'FAIL' : 'PASS'}`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
