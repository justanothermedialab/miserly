/**
 * portable-zip.mjs — the portable Windows build: dist/Miserly-preview-<version>-portable.zip.
 * ============================================================================
 * Releases ship a zip, not an installer: the 0.1.0 installer failed on one test machine and
 * took over 15 minutes on another. Hyphens, not spaces, in the name, since a GitHub Release
 * turns spaces in an asset's name into dots. Run after `pnpm exe` (win-unpacked). The zip
 * holds:
 *   Miserly/             the app (win-unpacked), Miserly.exe at the top
 *   Miserly/data/        empty but for a note; its presence makes main.cjs keep all data here
 *   Miserly/THIRD-PARTY-NOTICES.txt   from apps/web/static/
 *   Miserly guide.html   the user guide (docs/user-guide/build_html.py; needs Python with
 *                        the `markdown` package)
 * ============================================================================
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const desktopDir = path.dirname(fileURLToPath(import.meta.url)).replace(/[/\\]scripts$/, '');
const dist = path.join(desktopDir, 'dist');
const unpacked = path.join(dist, 'win-unpacked');
const stage = path.join(dist, 'portable');
const appDir = path.join(stage, 'Miserly');
const { version } = JSON.parse(fs.readFileSync(path.join(desktopDir, 'package.json'), 'utf8'));
const zip = path.join(dist, `Miserly-preview-${version}-portable.zip`);
const guideScript = path.resolve(desktopDir, '..', '..', '..', 'docs', 'user-guide', 'build_html.py');

if (!fs.existsSync(path.join(unpacked, 'Miserly.exe'))) {
  throw new Error(`No ${unpacked}\\Miserly.exe: run \`pnpm exe\` first.`);
}

fs.rmSync(stage, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
fs.cpSync(unpacked, appDir, { recursive: true });
// A dev run of the unpacked exe may have left a data folder; ship an empty one.
fs.rmSync(path.join(appDir, 'data'), { recursive: true, force: true });
fs.mkdirSync(path.join(appDir, 'data'));
fs.writeFileSync(
  path.join(appDir, 'data', 'About this folder.txt'),
  [
    'Miserly keeps everything you type in this folder (miserly.db).',
    '',
    'Keep it next to Miserly.exe. Moving or copying the whole Miserly folder takes your',
    'data with it. Deleting this folder deletes your data.',
    '',
    'To back up: close Miserly, then copy miserly.db somewhere safe.',
    '',
  ].join('\r\n'),
);

// The third-party notices beside the exe too (the app also serves them from its About dialog).
fs.copyFileSync(path.resolve(desktopDir, '..', 'web', 'static', 'THIRD-PARTY-NOTICES.txt'), path.join(appDir, 'THIRD-PARTY-NOTICES.txt'));

execFileSync('python', [guideScript, path.join(stage, 'Miserly guide.html')], { stdio: 'inherit' });

// 7-Zip from electron-builder's own dependencies (Windows' Compress-Archive is slow and
// cross-platform tar can't be relied on to write a zip).
const builderRequire = createRequire(createRequire(pathToFileURL(path.join(desktopDir, 'package.json'))).resolve('electron-builder'));
const appBuilderRequire = createRequire(builderRequire.resolve('app-builder-lib'));
const { path7za } = appBuilderRequire('7zip-bin');
fs.rmSync(zip, { force: true });
execFileSync(path7za, ['a', '-tzip', '-mx=7', zip, 'Miserly', 'Miserly guide.html'], { cwd: stage, stdio: 'ignore' });

let files = 0;
const count = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) count(path.join(dir, e.name));
    else files++;
  }
};
count(stage);
console.log(`\n✓ ${zip} (${Math.round(fs.statSync(zip).size / 1048576)} MB, ${files} files)`);
