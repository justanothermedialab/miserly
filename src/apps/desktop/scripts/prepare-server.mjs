/**
 * prepare-server.mjs — assemble the self-contained server tree the Electron
 * shell wraps, with a better-sqlite3 that is PHYSICALLY INDEPENDENT of the
 * pnpm store (so building it for the Electron ABI can never touch the web
 * package's Node-ABI copy).
 * ============================================================================
 * Cross-platform (Windows/macOS/Linux — the team is on Windows, so no `cp -r`).
 * Steps:
 *   1. Build the SvelteKit adapter-node server (apps/web/build/).
 *   2. `pnpm deploy` apps/web into ./server (flat, prod-only tree).
 *   3. Copy the built build/ (deploy skips it — /build is gitignored) + the
 *      drizzle migrations (resolved at runtime via MISERLY_MIGRATIONS_DIR).
 *   4. DE-SHARE better-sqlite3, then install the Electron-ABI binary into it.
 *      pnpm links ./server's better-sqlite3 to the global content-addressable
 *      store; a naive electron-rebuild would rebuild it THERE and flip the web
 *      copy to the Electron ABI (NODE_MODULE_VERSION mismatch → dev/test/Docker
 *      break). So we replace it with a real, independent physical copy first,
 *      then fetch better-sqlite3's Electron prebuilt binary (falling back to a
 *      local compile) — all confined to ./server. @node-rs/argon2 is N-API
 *      (ABI-stable) — no rebuild.
 *   5. Bundle build/ into one index.js and cut node_modules to the two native
 *      packages (a few hundred files to ship, not 19,000).
 * ============================================================================
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const desktopDir = path.dirname(fileURLToPath(import.meta.url)).replace(/[/\\]scripts$/, '');
const serverDir = path.join(desktopDir, 'server');
const webBuild = path.resolve(desktopDir, '..', 'web', 'build');
const webDrizzle = path.resolve(desktopDir, '..', 'web', 'drizzle');

function run(cmd, cwd = desktopDir, env = process.env) {
  console.log(`\n$ ${cmd}`);
  execSync(cmd, { cwd, stdio: 'inherit', env });
}

/** process.env with all npm_config_* keys removed — pnpm injects npm_config_runtime/
 *  target which would OVERRIDE prebuild-install's CLI flags and fetch the wrong ABI. */
function envWithoutNpmConfig() {
  const e = { ...process.env };
  for (const k of Object.keys(e)) if (k.toLowerCase().startsWith('npm_config_')) delete e[k];
  return e;
}

/** Recursive rm that survives Windows. pnpm's content-addressable store marks its
 *  files READ-ONLY, which makes a plain fs.rmSync throw EPERM on Windows when
 *  wiping a previously-prepared ./server. Clear the read-only bit across the tree
 *  first, then remove with retries (also rides out transient AV/indexer locks). */
function rmrf(target) {
  if (!fs.existsSync(target)) return;
  const clear = (p) => {
    let st;
    try { st = fs.lstatSync(p); } catch { return; }
    try { fs.chmodSync(p, 0o777); } catch { /* best-effort */ }
    if (st.isDirectory() && !st.isSymbolicLink()) {
      for (const name of fs.readdirSync(p)) clear(path.join(p, name));
    }
  };
  clear(target);
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

/** Recursively unlink symlinks whose target no longer exists (dangling), walking
 *  only REAL directories (never following a symlink, so no cycles). Returns the
 *  count removed. Used to clean up after the build-time store prune. */
function sweepDanglingSymlinks(root) {
  let removed = 0;
  const walk = (dir) => {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const fp = path.join(dir, e.name);
      if (e.isSymbolicLink()) {
        if (!fs.existsSync(fp)) { try { fs.unlinkSync(fp); removed++; } catch { /* best-effort */ } }
      } else if (e.isDirectory()) {
        walk(fp);
      }
    }
  };
  walk(root);
  return removed;
}

// 1. Build the web server.
run('pnpm --filter @miserly/web build');

// 2. Deploy a flat, prod-only, self-contained copy into ./server.
rmrf(serverDir); // Windows-safe (pnpm store files are read-only → plain rmSync EPERMs)
run(`pnpm deploy --filter=@miserly/web --prod --legacy --force "${serverDir}"`);
// The deploy copies apps/web's local dev database folder too. The desktop app keeps
// its data in userData (MISERLY_DB_PATH), so a dev DB must never ship in a build.
rmrf(path.join(serverDir, 'data'));

// 3. Copy the built output + drizzle migrations.
if (!fs.existsSync(webBuild)) {
  throw new Error(`Expected web build at ${webBuild} — did step 1 fail?`);
}
fs.cpSync(webBuild, path.join(serverDir, 'build'), { recursive: true });
fs.cpSync(webDrizzle, path.join(serverDir, 'drizzle'), { recursive: true });

// 3.5 Prune build-time-only trees from the deployed --prod store.
//     `pnpm deploy --legacy` does NOT honour --prod pruning for this
//     (non-injected) workspace, so the ENTIRE build toolchain rides along —
//     dominated by esbuild's + rolldown's + lightningcss's per-PLATFORM native
//     binary matrices (~670 MB) — even though the bundled adapter-node runtime
//     (build/index.js) never requires ANY of it.
//     Deleting the .pnpm store entries frees the real bytes (everything else is
//     a symlink into it); dangling symlinks the runtime never resolves are
//     harmless. Runtime deps (better-sqlite3, @node-rs/argon2 + its bindings,
//     bindings/file-uri-to-path/prebuild-install used by step 4) do NOT match
//     these patterns and are left intact — the electron-smoke test (which runs
//     first-run auth = argon2, and opens the DB = better-sqlite3) is the gate.
const PRUNE_BUILD_TIME = [
  /^@esbuild\+/, /^esbuild@/, // esbuild + its 28 per-platform binaries (~283 MB)
  /^@rolldown\+/, /^rolldown@/, // vite 8's rolldown bundler bindings (~250 MB)
  /^@rollup\+/, /^rollup@/, // (legacy rollup bindings, if present)
  /^lightningcss-/, /^lightningcss@/, // tailwind/vite CSS build tool platform bins
  /^vite@/, /^vitefu@/, /^typescript@/, // build tools, never needed at runtime
  /^tailwindcss@/, /^@tailwindcss\+/, /^drizzle-kit@/,
];
const pnpmStore = path.join(serverDir, 'node_modules', '.pnpm');
if (fs.existsSync(pnpmStore)) {
  let pruned = 0;
  for (const name of fs.readdirSync(pnpmStore)) {
    if (PRUNE_BUILD_TIME.some((re) => re.test(name))) {
      fs.rmSync(path.join(pnpmStore, name), { recursive: true, force: true });
      pruned++;
    }
  }
  // Sweep the DANGLING symlinks the prune leaves behind — a top-level
  // node_modules/<pkg> or a peer link (e.g. @sveltejs/kit → vite) now pointing
  // at a deleted store entry. Runtime never resolves them, but electron-builder's
  // NSIS 7za step ABORTS (exit 1) the moment it archives a symlink whose target
  // is gone. existsSync FOLLOWS the link → false for a dangling one.
  const swept = sweepDanglingSymlinks(path.join(serverDir, 'node_modules'));
  console.log(`\n✓ pruned ${pruned} build-time store entries + swept ${swept} dangling symlinks`);
}

// 4. Put the Electron-ABI better-sqlite3 into ./server WITHOUT touching pnpm's
//    shared store (which the web package/tests/Docker use as Node ABI). This box
//    has no MSVC, so we never COMPILE — better-sqlite3 publishes a prebuilt
//    Electron binary (better-sqlite3-vX-electron-v130-...), which prebuild-install
//    fetches deterministically. Steps:
//      4a. Make ./server's better-sqlite3 an INDEPENDENT physical copy (fresh
//          inodes) so nothing we write can reach the store.
//      4b. Fetch the published Electron prebuild into that copy.
const target = path.join(serverDir, 'node_modules', 'better-sqlite3');
const realSrc = fs.realpathSync(target);

// Resolve the tooling BEFORE de-sharing, while pnpm's .pnpm symlink context is
// still intact (the flat copy below loses it). prebuild-install resolves its own
// deps relative to its real location, so it still runs after the swap.
const desktopRequire = createRequire(pathToFileURL(path.join(desktopDir, 'package.json')));
const electronVersion = desktopRequire('electron/package.json').version;
const originalRequire = createRequire(pathToFileURL(path.join(realSrc, 'package.json')));
const prebuildInstallBin = originalRequire.resolve('prebuild-install/bin.js');

// better-sqlite3 does `require('bindings')` at RUNTIME; flattening it into an
// independent copy loses pnpm's .pnpm link to that dep. Locate its runtime deps
// in the deployed .pnpm store (handles both pnpm virtual-store layouts) so we
// can copy them INTO the copy below and make it fully self-contained.
function findInPnpmStore(pkg) {
  const pnpmDir = path.join(serverDir, 'node_modules', '.pnpm');
  if (!fs.existsSync(pnpmDir)) return null;
  const candidates = [
    path.join(pnpmDir, 'node_modules', pkg), // flat virtual store
    ...fs
      .readdirSync(pnpmDir)
      .filter((d) => d.startsWith(`${pkg}@`))
      .map((d) => path.join(pnpmDir, d, 'node_modules', pkg)),
  ];
  return candidates.find((p) => fs.existsSync(path.join(p, 'package.json'))) ?? null;
}
const runtimeDepDirs = {};
for (const dep of ['bindings', 'file-uri-to-path']) {
  const dir = findInPnpmStore(dep);
  if (dir) runtimeDepDirs[dep] = dir;
}

// 4a. Make ./server's better-sqlite3 an INDEPENDENT physical copy (fresh inodes)
//     so nothing we write below can reach the shared store.
const indep = `${target}__indep`;
fs.rmSync(indep, { recursive: true, force: true });
fs.cpSync(realSrc, indep, { recursive: true });
if (fs.lstatSync(target).isSymbolicLink()) fs.unlinkSync(target);
else fs.rmSync(target, { recursive: true, force: true });
fs.renameSync(indep, target);

// Make the copy self-contained: place its runtime deps in its own node_modules.
const targetNM = path.join(target, 'node_modules');
fs.mkdirSync(targetNM, { recursive: true });
for (const [dep, dir] of Object.entries(runtimeDepDirs)) {
  // realpath: `dir` is a link into .pnpm, which step 5 deletes; copy the package itself.
  fs.cpSync(fs.realpathSync(dir), path.join(targetNM, dep), { recursive: true });
}

// 4b. Fetch the published Electron prebuild into that independent copy. Clear
//     BOTH build/ and prebuilds/ first: the copy carries a Node-ABI prebuild
//     that better-sqlite3's loader would otherwise prefer under Electron and
//     crash on the first real DB open. Leave ONLY the Electron binary.
fs.rmSync(path.join(target, 'build'), { recursive: true, force: true });
fs.rmSync(path.join(target, 'prebuilds'), { recursive: true, force: true });
run(
  `node "${prebuildInstallBin}" --runtime electron --target ${electronVersion} --arch ${process.arch}`,
  target,
  envWithoutNpmConfig(), // pnpm's npm_config_runtime would otherwise force the Node ABI
);

// 5. Bundle the server into ONE file and keep only the two native packages. The
//    0.1.0 alpha shipped the whole deployed node_modules (19,305 files, 17,916 in
//    .pnpm); the installer wrote and Defender scanned them one by one, so a fresh
//    install took 15+ minutes on an SSD. adapter-node leaves
//    every `dependencies` package external, so esbuild pulls them all into
//    build/index.js here; better-sqlite3 and @node-rs/argon2 load .node binaries
//    and stay as packages. CJS deps inside an ESM bundle call require(), hence
//    the banner. env.js's import.meta.url still names build/, where it ends up.
const buildDir = path.join(serverDir, 'build');
const NATIVE = ['better-sqlite3', '@node-rs/argon2'];
await desktopRequire('esbuild').build({
  entryPoints: [path.join(buildDir, 'index.js')],
  outfile: path.join(buildDir, 'bundle.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: `node${process.versions.node.split('.')[0]}`,
  external: NATIVE,
  tsconfigRaw: {}, // build/ is plain JS; the deployed web tsconfig extends a file that isn't here
  banner: { js: "import { createRequire as __miserlyRequire } from 'node:module'; const require = __miserlyRequire(import.meta.url);" },
  logLevel: 'warning',
  logOverride: { 'ignored-bare-import': 'silent' }, // d3's side-effect-free bare imports, dropped as intended
});
for (const name of fs.readdirSync(buildDir)) {
  if (name !== 'client' && name !== 'prerendered' && name !== 'bundle.js') rmrf(path.join(buildDir, name));
}
fs.renameSync(path.join(buildDir, 'bundle.js'), path.join(buildDir, 'index.js'));

// The new node_modules: better-sqlite3 (already an independent copy with its own
// bindings, step 4) and argon2 with whichever platform bindings pnpm installed
// (the others are links to nothing).
const nm = path.join(serverDir, 'node_modules');
const slim = `${nm}__slim`;
rmrf(slim);
fs.mkdirSync(path.join(slim, '@node-rs'), { recursive: true });
fs.renameSync(target, path.join(slim, 'better-sqlite3'));
const argonScope = path.dirname(fs.realpathSync(path.join(nm, '@node-rs', 'argon2')));
for (const name of fs.readdirSync(argonScope)) {
  const src = path.join(argonScope, name);
  if (!fs.existsSync(path.join(src, 'package.json'))) continue;
  fs.cpSync(fs.realpathSync(src), path.join(slim, '@node-rs', name), { recursive: true });
}
rmrf(nm);
fs.renameSync(slim, nm);
// `pnpm deploy` copies the whole web package (src/, tests, test videos, configs); the
// app runs on build/ + drizzle/ + node_modules/ + package.json ("type": "module") only.
const RUNTIME = new Set(['build', 'drizzle', 'node_modules', 'package.json']);
for (const name of fs.readdirSync(serverDir)) {
  if (!RUNTIME.has(name)) rmrf(path.join(serverDir, name));
}
// The .br / .gz twins of every client file: sirv serves the plain file when they're
// absent, and over 127.0.0.1 compression buys nothing.
const dropTwins = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const fp = path.join(dir, e.name);
    if (e.isDirectory()) dropTwins(fp);
    else if (/\.(br|gz)$/.test(e.name)) fs.rmSync(fp);
  }
};
dropTwins(path.join(buildDir, 'client'));
let files = 0;
const count = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) count(path.join(dir, e.name));
    else files++;
  }
};
count(serverDir);
console.log(`\n✓ server bundled: ${files} files in ./server`);

console.log('\n✓ server tree ready at', serverDir, '(server = Electron ABI prebuild; store untouched)');
