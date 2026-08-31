// The server half: seed a table, serve it over iroh, print the ticket, stay up.
//
// Loads the release extension by path with allow_unsigned_extensions, which is
// what npm/bin/quackhole.js does and what keeps the binary under test pinned to
// a release rather than to whatever community-extensions serves today.
import { DuckDBInstance } from '@duckdb/node-api';
import { hostname } from 'node:os';
import { join } from 'node:path';

// Where the run keeps its database, extension and results. The VM side leaves
// this unset and lands in ~/qhperf; the laptop side points it at test/perf/.local.
const DIR = process.env.QHPERF_DIR ?? join(process.env.HOME, 'qhperf');

const opt = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};

const token = process.env.QH_TOKEN ?? 'perf-token';
const rows = Number(opt('rows', 200_000));
const port = Number(opt('port', 9494));
const ext = opt('ext', join(DIR, 'ext', 'quackhole.duckdb_extension'));

const sql = (s) => `'${String(s).replaceAll("'", "''")}'`;

const instance = await DuckDBInstance.create(join(DIR, 'server.db'), {
  allow_unsigned_extensions: 'true',
});
const conn = await instance.connect();
const all = async (q) => (await conn.runAndReadAll(q)).getRowObjectsJS();

await conn.run('INSTALL quack');
await conn.run('LOAD quack');
await conn.run(`LOAD ${sql(ext)}`);

// A fixed-width payload, so "bytes moved" on the client is arithmetic on the
// schema rather than a guess about DuckDB's internal representation. Varying
// content per row, so the number is not an artifact of dictionary compression.
// 8 (id) + 8 (ts) + 8 (value) + 64 (payload) = 88 bytes/row; client.mjs repeats
// that constant and README.md explains it.
await conn.run('DROP TABLE IF EXISTS events');
await conn.run(`CREATE TABLE events AS SELECT
  range::BIGINT AS id,
  now()::TIMESTAMP - INTERVAL (range % 100000) SECOND AS ts,
  (range * 7919 % 1000) / 10.0 AS value,
  md5(range::VARCHAR) || md5((range + 1)::VARCHAR) AS payload
FROM range(${rows})`);

// Where the client's writes land, so the run exercises both directions.
await conn.run('DROP TABLE IF EXISTS sink');
await conn.run('CREATE TABLE sink(iter INTEGER, sent_at TIMESTAMP, id BIGINT, payload VARCHAR)');

await conn.run(`CREATE OR REPLACE TABLE host_info AS SELECT
  ${sql(hostname())} AS host, version() AS duckdb_version, ${rows}::BIGINT AS seeded_rows, now() AS started_at`);

// A throwaway identity per run, so a stale ticket from an earlier run cannot
// dial successfully and then fail at token auth. Read when the endpoint binds,
// so it has to precede the serve call.
await conn.run('SET GLOBAL quackhole_ephemeral = true');

// serve blocks until the endpoint learns its home relay -- a ticket minted
// before then omits the relay and sends the peer to pkarr, which routinely has
// not seen a server this new.
const served = await all(
  `SELECT * FROM quackhole_serve(token := ${sql(token)}, target := ${sql(`127.0.0.1:${port}`)})`,
);

const status = await all('SELECT * FROM quackhole_status()');
console.log(`QHPERF_SERVED ${JSON.stringify({ ...served[0], seeded_rows: rows, status: status[0] })}`);
console.log(`QHPERF_TICKET ${served[0].ticket}`);

// Nothing else to do: the accept loop runs inside the extension, and this
// process only has to stay alive to hold it. run.sh kills it.
setInterval(() => {}, 1 << 30);
