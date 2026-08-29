// Step 1 of Phase 2: does DuckDB-Wasm's quack client work at all, over ordinary
// HTTP, with no shim and no iroh?
//
// `quack:localhost:9494` hits QuackUri::IsLocal() (quack_uri.hpp:36 -- literally
// localhost/127.0.0.1/::1), which means enable_ssl is false and the request goes
// out as plain HTTP through duckdb-wasm's synchronous XHR glue. If this fails,
// no amount of transport work makes a browser client possible.
import * as duckdb from '@duckdb/duckdb-wasm';

const out = document.getElementById('log');
const lines = [];
const say = (msg) => {
  lines.push(msg);
  out.textContent = lines.join('\n');
  console.log(msg);
};

const BUNDLES = {
  mvp: {
    mainModule: '/duckdb/duckdb-mvp.wasm',
    mainWorker: '/duckdb/duckdb-browser-mvp.worker.js',
  },
  eh: {
    mainModule: '/duckdb/duckdb-eh.wasm',
    mainWorker: '/duckdb/duckdb-browser-eh.worker.js',
  },
};

// One column of the first row, as a plain JS value.
const scalar = (table) => {
  const rows = table.toArray();
  if (rows.length === 0) return null;
  const v = Object.values(rows[0].toJSON())[0];
  return typeof v === 'bigint' ? Number(v) : v;
};

async function main() {
  const bundle = await duckdb.selectBundle(BUNDLES);
  say(`bundle: ${bundle.mainModule}`);

  // In shimmed modes the DuckDB worker is started through our own bootstrap,
  // which installs the XHR shim before duckdb loads. Everything downstream --
  // duckdb, quack, the SQL -- is identical either way; only the transport moves.
  const workerUrl =
    window.__mode !== 'direct'
      ? `/qh-worker.js?target=${encodeURIComponent(bundle.mainWorker)}&intercept=${encodeURIComponent(window.__intercept)}&chunk=${window.__chunk}&mode=${window.__bridgeMode}&relay=${encodeURIComponent(window.__relay ?? '')}&debug=${window.__debug}`
      : bundle.mainWorker;
  say(`mode: ${window.__mode}, crossOriginIsolated=${self.crossOriginIsolated}`);

  const worker = new Worker(workerUrl);
  const db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING), worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  const conn = await db.connect();

  const version = scalar(await conn.query('SELECT version()'));
  say(`duckdb-wasm reports ${version}`);

  // Fetched from extensions.duckdb.org, which does send
  // Access-Control-Allow-Origin: *, so this is a normal cross-origin load.
  await conn.query('INSTALL quack');
  await conn.query('LOAD quack');
  say('quack loaded');

  await conn.query(`CREATE SECRET (TYPE quack, TOKEN '${window.__token}')`);
  const t0 = performance.now();
  await conn.query(`ATTACH '${window.__attach}' AS remote`);
  const attachMs = performance.now() - t0;
  say(`attached in ${attachMs.toFixed(0)}ms`);

  const t1 = performance.now();
  const count = scalar(await conn.query('SELECT count(*) FROM remote.logs'));
  const countMs = performance.now() - t1;

  const t2 = performance.now();
  const name = scalar(await conn.query('SELECT name FROM remote.logs WHERE id = 42'));
  const pointMs = performance.now() - t2;

  const t3 = performance.now();
  const wide = scalar(await conn.query('SELECT sum(length(payload))::BIGINT FROM remote.wide'));
  const wideMs = performance.now() - t3;

  say(`count=${count} (${countMs.toFixed(0)}ms), point=${name} (${pointMs.toFixed(0)}ms), wide=${wide} (${wideMs.toFixed(0)}ms)`);

  await conn.close();
  await db.terminate();
  await worker.terminate();

  return { version, count, name, wide, attachMs, countMs, pointMs, wideMs };
}

main().then(
  (result) => {
    window.__result = { ok: true, ...result, log: lines };
    window.__done = true;
  },
  (err) => {
    say(`ERROR: ${err?.stack || err}`);
    window.__result = { ok: false, error: String(err?.stack || err), log: lines };
    window.__done = true;
  },
);
