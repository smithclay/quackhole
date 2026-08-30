#!/usr/bin/env node
//
// Starts a DuckDB on this machine that a browser can reach, and prints the link
// that connects the two.
//
// This is what https://smithclay.github.io/quackhole/ tells a visitor to run.
// What it does, in order: fetch the quackhole extension for this platform
// (cached after the first run), build a small sample database in a temp
// directory, start serving it over iroh, and print the link quackhole_serve()
// returns.
//
// The link is the whole handoff -- opening it adds this database to the
// workbench and connects. quackhole_serve waits for the home relay and mints
// the ticket itself, so nothing here knows the ticket format.
//
// Nothing is installed outside the npm cache and this package's own cache
// directory, no cryptographic identity is persisted (the endpoint is
// ephemeral), and nothing is left running after Ctrl-C.
//
// This replaced a 373-line POSIX shell script, and most of what went is
// mechanism rather than behaviour. @duckdb/node-api is pinned to the DuckDB the
// extension is built against, so the ABI check and the CLI download it guarded
// are true by construction; a Node process holding a connection does not exit
// when stdin closes, so there is no FIFO and no log to poll for the URL.
//
// One override for developing on the repo, and it is what lets this be
// exercised before a release exists:
//
//   QH_EXT=build/release/extension/quackhole/quackhole.duckdb_extension npx .
import { DuckDBInstance } from '@duckdb/node-api';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

const REPO = process.env.QH_REPO ?? 'smithclay/quackhole';
const PAGE = process.env.QH_PAGE ?? 'https://smithclay.github.io/quackhole/';

const say = (msg = '') => console.log(msg ? `  ${msg}` : '');
const die = (msg) => {
  console.error(`\n  ${msg}\n`);
  process.exit(1);
};

/// Quote a string as a SQL literal. Everything a caller supplies goes through
/// this before it reaches a statement.
const sqlString = (s) => `'${String(s).replaceAll("'", "''")}'`;

// --- arguments ---------------------------------------------------------------

const HELP = `
  quackhole ${pkg.version}

  Serve this machine's DuckDB to a browser, over an encrypted peer-to-peer
  connection. Prints a link that opens the workbench already connecting.

    npx quackhole

    --token <t>   Shared token. A fresh random one by default
    --port <n>    Quack's local port (default 9494)
    --page <url>  Aim the printed link at another workbench
    --version     Print the version and exit
    --help        This

  The link carries the token, so treat it like one: anyone holding it can query
  this database until you stop. Ctrl-C stops it and removes the sample data.
`;

function parseArgs(argv) {
  const opts = { token: randomBytes(12).toString('hex'), port: 9494, page: PAGE };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => argv[++i] ?? die(`${arg} needs a value.`);
    if (arg === '--help' || arg === '-h') {
      console.log(HELP);
      process.exit(0);
    } else if (arg === '--version' || arg === '-v') {
      console.log(pkg.version);
      process.exit(0);
    } else if (arg === '--token') opts.token = value();
    else if (arg === '--port') opts.port = Number(value());
    else if (arg === '--page') opts.page = value();
    else die(`Unknown option ${arg}. Try --help.`);
  }
  if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) die(`--port ${opts.port} is not a port.`);
  return opts;
}

const opts = parseArgs(process.argv.slice(2));

// --- which build -------------------------------------------------------------

/// The release asset for this machine, in DuckDB's platform naming.
function platform() {
  const os = { darwin: 'osx', linux: 'linux', win32: 'windows' }[process.platform];
  const arch = { arm64: 'arm64', x64: 'amd64' }[process.arch];
  if (!os || !arch) {
    die(`No quackhole build for ${process.platform}/${process.arch}. See ${PAGE} for the by-hand path.`);
  }
  // Windows is built for x64 only, and naming the gap beats a 404 from GitHub.
  if (os === 'windows' && arch !== 'amd64') die('Windows builds are x64 only. Under WSL, the linux build works.');
  return `${os}_${arch}`;
}

// --- the extension -----------------------------------------------------------

/// Where downloads are kept between runs.
///
/// npx is a repeatable command in a way `curl | sh` never was, so a 45 MB
/// download per invocation is the difference between a three-second start and a
/// twenty-second one. Keyed by version and platform, because both decide which
/// binary is correct.
function cacheDir() {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Caches', 'quackhole');
  if (process.platform === 'win32') {
    return join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'quackhole', 'Cache');
  }
  return join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'quackhole');
}

async function extensionPath() {
  if (process.env.QH_EXT) {
    const local = process.env.QH_EXT;
    if (!(await stat(local).catch(() => null))) die(`QH_EXT is set to '${local}', which does not exist.`);
    say(`using the local extension ${local}`);
    return local;
  }

  const target = platform();
  const cached = join(cacheDir(), `quackhole-${pkg.version}-${target}.duckdb_extension`);
  if (await stat(cached).catch(() => null)) {
    say(`using the cached extension for ${target}`);
    return cached;
  }

  // Pinned to this package's version rather than releases/latest. npm and
  // GitHub releases are two publishing surfaces, so `latest` is a race:
  // quackhole@0.0.2 on npm against a v0.0.1 release downloads a binary this
  // file was not written for.
  const url = `https://github.com/${REPO}/releases/download/v${pkg.version}/quackhole-${target}.duckdb_extension`;
  say(`fetching the extension for ${target}`);
  const res = await fetch(url).catch((err) => die(`Could not reach GitHub: ${err.message}`));
  if (!res.ok) {
    die(
      `Could not download the extension for ${target} (HTTP ${res.status}).\n` +
        `  ${url}\n\n` +
        `  quackhole ${pkg.version} expects a v${pkg.version} release with a build for this\n` +
        `  platform. If the release is newer than this package, upgrade it:\n\n` +
        '    npx quackhole@latest',
    );
  }
  const bytes = Buffer.from(await res.arrayBuffer());

  // Written beside the final name and renamed, so an interrupted download
  // cannot leave a truncated binary in the cache to be trusted next time.
  await mkdir(cacheDir(), { recursive: true });
  const partial = `${cached}.${process.pid}.part`;
  await writeFile(partial, bytes);
  await rename(partial, cached);
  say(`cached ${(bytes.length / 1e6).toFixed(0)} MB in ${cacheDir()}`);
  return cached;
}

// --- the port ----------------------------------------------------------------

/// Whether something is already listening on 127.0.0.1:port.
///
/// quackhole_serve reuses a Quack that is already listening rather than
/// starting one, so if another DuckDB got there first, the token below is NOT
/// the token that server accepts. The browser then fails to attach with an
/// authentication error that names nothing. Catch it here, where it can be
/// explained.
///
/// Asked by binding rather than by connecting: a connect that is refused proves
/// the port is free, but a connect that hangs proves nothing in time.
function portInUse(port) {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', (err) => resolve(err.code === 'EADDRINUSE'));
    probe.once('listening', () => probe.close(() => resolve(false)));
    probe.listen(port, '127.0.0.1');
  });
}

// --- the run -----------------------------------------------------------------

let workdir = null;
let instance = null;

async function cleanup() {
  instance?.closeSync();
  if (workdir) await rm(workdir, { recursive: true, force: true }).catch(() => {});
}

console.log('\n  quackhole demo\n  --------------\n');

if (await portInUse(opts.port)) {
  die(
    `Something is already listening on 127.0.0.1:${opts.port} -- most likely a DuckDB\n` +
      '  still serving from an earlier run.\n\n' +
      '  quackhole_serve would reuse it instead of starting a fresh Quack, so the token\n' +
      '  below would not be the one it accepts and the browser could not attach. Stop\n' +
      `  that process and run this again, or pass --port ${opts.port + 1}.`,
  );
}

const extension = await extensionPath();

workdir = await mkdtemp(join(tmpdir(), 'quackhole-'));
process.on('SIGINT', () => void cleanup().then(() => process.exit(0)));
process.on('SIGTERM', () => void cleanup().then(() => process.exit(0)));

// The extension is not signed, and is loaded from a path rather than a
// repository, which is the only way to load one that is not in
// community-extensions yet.
instance = await DuckDBInstance.create(join(workdir, 'demo.db'), { allow_unsigned_extensions: 'true' });
const conn = await instance.connect();

const rows = async (sql) => (await conn.runAndReadAll(sql)).getRowObjectsJS();

try {
  await conn.run('INSTALL quack');
  await conn.run('LOAD quack');
  await conn.run(`LOAD ${sqlString(extension)}`);
} catch (err) {
  await cleanup();
  die(`The quackhole extension did not load:\n\n    ${err.message}`);
}

// The extension binary and this file are released together, so a mismatch is
// not an old install any more -- it is a package whose version resolved a
// release that does not match it, or a QH_EXT pointed at a stale local build.
// Asking the extension what it has beats matching on DuckDB's error prose after
// the fact.
const known = await rows("SELECT count(*) AS n FROM duckdb_settings() WHERE name = 'quackhole_workbench_url'");
if (Number(known[0].n) === 0) {
  await cleanup();
  die(
    `The extension that loaded is not the one quackhole ${pkg.version} expects: it has no\n` +
      '  quackhole_workbench_url, which is what aims the link this prints.\n\n' +
      (process.env.QH_EXT
        ? `  QH_EXT is set to ${process.env.QH_EXT}. Rebuild it:\n\n    make release`
        : `  Remove ${cacheDir()} and run this again. If it persists, the\n` +
          `  v${pkg.version} release and this package disagree -- please open an issue.`),
  );
}

const version = (await rows('SELECT version() AS v'))[0].v;
say(`duckdb ${version}, serving from ${workdir}`);
say('building a sample database');

await conn.run(`CREATE TABLE laptop_info AS SELECT
  ${sqlString(hostname())} AS host,
  ${sqlString(`${process.platform} ${process.arch}`)} AS os,
  version() AS duckdb_version,
  now() AS started_at`);

await conn.run(`CREATE TABLE events AS SELECT
  range AS id,
  'evt_' || range AS name,
  (['debug', 'info', 'warn', 'error'])[(range % 4) + 1] AS level,
  now()::TIMESTAMP - INTERVAL (range) MINUTE AS ts,
  (range * 7919 % 1000) / 10.0 AS duration_ms
FROM range(5000)`);

// A throwaway identity, so the promise above holds: without this the extension
// persists an ed25519 key at ~/.quackhole/key, which outlives the temp
// directory and this process. It also keeps a stale ticket from an earlier run
// from dialling successfully and then failing at token auth, since each run now
// has a different endpoint id. Read when the endpoint binds, so it has to
// precede the serve call.
await conn.run('SET GLOBAL quackhole_ephemeral = true');

// The extension bakes in the public workbench; this is what makes --page work
// against a local build. Set unconditionally so the link this prints and the
// link the extension mints can never disagree.
await conn.run(`SET GLOBAL quackhole_workbench_url = ${sqlString(opts.page)}`);

// serve blocks internally until the endpoint learns its home relay, which is a
// round trip to n0's infrastructure and where this spends its time. A ticket
// minted before then omits the relay and sends the browser to pkarr, which
// routinely has not seen a server this new.
say('starting the endpoint, waiting for a home relay…');
const served = await rows(
  `SELECT * FROM quackhole_serve(token := ${sqlString(opts.token)}, target := ${sqlString(`127.0.0.1:${opts.port}`)})`,
).catch(async (err) => {
  await cleanup();
  die(`quackhole_serve failed:\n\n    ${err.message}`);
});

const { endpoint_id: endpointId, relay_url: relay, url } = served[0];
if (!url) {
  await cleanup();
  die('The endpoint bound but minted no workbench link. Its relay may not have been reached in time.');
}

console.log(`
  Serving as ${endpointId}
  through ${relay ?? '(no relay yet)'}

  ------------------------------------------------------------------
  Open this link. It adds this database to the workbench and connects:

  ${url}
  ------------------------------------------------------------------

  The link carries the token, so treat it like one: anyone holding it
  can query this database until you stop.

  Serving 5,000 rows in 'events'. Ctrl-C to stop.
`);

// Nothing else holds the event loop open: the accept loop is a native thread
// libuv knows nothing about, so without a timer Node would exit here and take
// the server with it.
setInterval(() => {}, 1 << 30);
