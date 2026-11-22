/**
 * afterPack.cjs — electron-builder post-package guard.
 * ============================================================================
 * Fails the build if any file main.cjs loads at runtime (itself + the preload)
 * didn't actually make it into app.asar. This is the guard for the exact defect
 * that shipped once: the `files` allowlist in electron-builder.yml contains
 * positive patterns, which makes electron-builder drop the default include-all
 * glob, so `preload.cjs` was silently excluded and window.miserlyDesktop never
 * loaded.
 *
 * A raw string search isn't enough — main.cjs itself contains the literal
 * 'preload.cjs' — so we parse the asar DIRECTORY header and check the real file
 * table. Dependency-free (no @electron/asar resolve): the asar format is a small
 * pickle header, [uint32 x4] sizes then a JSON directory tree.
 * ============================================================================
 */
const fs = require('node:fs');
const path = require('node:path');

/** Files that must be inside app.asar for the app to boot with working chrome. */
const REQUIRED = ['main.cjs', 'preload.cjs', 'window-state.cjs', 'package.json', 'taskbar-light.ico', 'taskbar-dark.ico'];

/** Top-level entries in an asar's directory header (enough for our flat REQUIRED set). */
function asarTopLevelFiles(asarPath) {
  const fd = fs.openSync(asarPath, 'r');
  try {
    // pickle: [0..3]=4, [4..7]=hdrStr+8, [8..11]=hdrStr+4, [12..15]=hdrStr length.
    const sizes = Buffer.alloc(16);
    fs.readSync(fd, sizes, 0, 16, 0);
    const headerStrSize = sizes.readUInt32LE(12);
    const header = Buffer.alloc(headerStrSize);
    fs.readSync(fd, header, 0, headerStrSize, 16);
    const parsed = JSON.parse(header.toString('utf8'));
    return parsed.files ? Object.keys(parsed.files) : [];
  } finally {
    fs.closeSync(fd);
  }
}

exports.default = async function afterPack(context) {
  const asarPath = path.join(context.appOutDir, 'resources', 'app.asar');

  // asar can be disabled (asar:false) → files sit unpacked under resources/app.
  if (!fs.existsSync(asarPath)) {
    const appDir = path.join(context.appOutDir, 'resources', 'app');
    const missing = REQUIRED.filter((f) => !fs.existsSync(path.join(appDir, f)));
    if (missing.length) {
      throw new Error(`[afterPack] packaged app is missing required file(s): ${missing.join(', ')}`);
    }
    console.log(`[afterPack] ✓ resources/app contains ${REQUIRED.join(', ')}`);
    return;
  }

  const present = new Set(asarTopLevelFiles(asarPath));
  const missing = REQUIRED.filter((f) => !present.has(f));
  if (missing.length) {
    throw new Error(
      `[afterPack] app.asar is missing required file(s): ${missing.join(', ')}\n` +
        '  → check the `files` allowlist in electron-builder.yml: it contains positive\n' +
        '    patterns, so the default **/* is dropped and anything not listed is excluded.',
    );
  }
  console.log(`[afterPack] ✓ app.asar contains ${REQUIRED.join(', ')}`);
};
