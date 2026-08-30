// Assembles npm/dist/ -- what `npm publish` and jsDelivr actually serve.
//
// Two jobs, and the second is the reason this is a script rather than a
// `files` list in package.json: npm cannot pack a file from outside the package
// directory, and `web/` has to stay where it is. So it is copied, never
// bundled, for the reasons CLAUDE.md gives: qh-worker.js reaches its siblings
// at runtime, which no content hash survives, and a bundler would break the
// property the whole demo rests on -- that these are the same files a person
// vendoring the client by hand would get.
//
//   node build.mjs           assemble dist/
//   node build.mjs --check   assert the version is in step, change nothing
import { cp, mkdir, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const WEB = join(ROOT, 'web');
const DIST = join(HERE, 'dist');
const CHECK = process.argv.includes('--check');

// The same list as VERBATIM in site/vite.config.js, minus the duckdb bundles.
// Both callers copy the client rather than reimplementing it, which is what
// makes what the demo proves true of what this package ships.
const CLIENT = ['protocol.js', 'shim.js', 'qh-worker.js', 'bridge-worker.js', 'peer.js', 'session.js', 'wasm'];

const has = (p) => stat(p).then(() => true, () => false);
const die = (msg) => {
  console.error(`\n  ${msg}\n`);
  process.exit(1);
};

// --- the version -------------------------------------------------------------

/// The extension's version, which is this package's version.
///
/// Derived rather than maintained: bin/quackhole.js resolves the GitHub release
/// tag it downloads from `package.json`, so an npm version that drifted from
/// the extension's would fetch a binary the CLI was not written for. One
/// number, stated where UPDATING.md says it is stated.
async function extensionVersion() {
  const toml = await readFile(join(ROOT, 'crates', 'Cargo.toml'), 'utf8');
  const version = toml.match(/^\[workspace\.package\][^[]*?^version\s*=\s*"([^"]+)"/ms)?.[1];
  if (!version) die('no [workspace.package] version in crates/Cargo.toml -- see docs/UPDATING.md');
  return version;
}

const manifestPath = join(HERE, 'package.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const version = await extensionVersion();

if (manifest.version !== version) {
  if (CHECK) {
    die(
      `npm/package.json is ${manifest.version}, the extension is ${version}.\n` +
        '  Run `node npm/build.mjs` -- the npm version is derived, not maintained.',
    );
  }
  manifest.version = version;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`  version  ${version} (from crates/Cargo.toml)`);
}
if (CHECK) {
  console.log(`  version  ${version}, in step`);
  process.exit(0);
}

// --- dist/ -------------------------------------------------------------------

// Gitignored, so a fresh checkout never has it. Saying so here is the
// difference between one sentence and a package that publishes without its
// transport.
if (!(await has(join(WEB, 'wasm', 'quackhole.js')))) {
  die('web/wasm is missing. Build the transport first:\n    web/build-wasm.sh');
}

await rm(DIST, { recursive: true, force: true });
await mkdir(join(DIST, 'web'), { recursive: true });

await cp(join(HERE, 'src', 'quackhole.js'), join(DIST, 'quackhole.js'));
for (const name of CLIENT) {
  // web/wasm/ carries a `.gitignore` of `*` -- the build output is not
  // committed -- and npm falls back to any .gitignore inside the package when
  // there is no .npmignore. Copied along, it drops the entire transport from
  // the tarball, leaving a package that installs, imports, and 404s for its
  // wasm inside a worker. Left behind here rather than papered over in
  // package.json, because the file has nothing to say about this package.
  await cp(join(WEB, name), join(DIST, 'web', name), {
    recursive: true,
    filter: (src) => basename(src) !== '.gitignore',
  });
}

console.log(`  dist     quackhole.js + web/ (${CLIENT.join(', ')})`);
console.log(`\n  npm/dist is ready. \`npm pack\` here, or \`npm publish\` on the release tag.\n`);
