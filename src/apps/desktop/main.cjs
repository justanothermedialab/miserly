/**
 * main.cjs — Miserly desktop shell (Electron main process).
 * ============================================================================
 * Wraps the ONE SvelteKit adapter-node server (D2/D3): boots it in-process on
 * 127.0.0.1, then points a BrowserWindow at it. Fully offline — the server IS
 * the app; data is a local SQLite file in the OS userData dir (system of
 * record). No network needed for any operation.
 *
 * LOAD-BEARING ORDER: build/index.js starts listening the instant it's
 * imported and reads HOST/PORT/ORIGIN/MISERLY_DB_PATH from the environment at
 * import time. So every env var MUST be set BEFORE the dynamic import, or the
 * server binds the wrong address or (the classic packaging bug) rejects form
 * POSTs for a missing/mismatched ORIGIN. We choose a free port, derive ORIGIN
 * from it, then import.
 * ============================================================================
 */
const { app, BrowserWindow, Menu, nativeTheme, ipcMain, screen, session, shell, systemPreferences } = require('electron');
const windowState = require('./window-state.cjs');
const net = require('node:net');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// Native Windows 11 scrollbars. Chromium 130 ships them behind features: the overlay
// bar is a thin line that widens to a full bar with arrows when the pointer is on it. When
// Windows' "Always show scrollbars" is on (DynamicScrollbars = 0) use the always-visible
// Fluent bar instead. Must be set before the app is ready. The two main app panes draw a
// WinUI-style bar of their own (lib/fluent-scroll.ts); the renderer learns the setting via
// the --miserly-always-scrollbars argument (preload.cjs) and then leaves the native bar.
let alwaysShow = false;
if (process.platform === 'win32') {
  try {
    const out = require('node:child_process').execFileSync(
      'reg',
      ['query', String.raw`HKCU\Control Panel\Accessibility`, '/v', 'DynamicScrollbars'],
      { encoding: 'utf8', windowsHide: true, timeout: 2000 },
    );
    alwaysShow = /DynamicScrollbars\s+REG_DWORD\s+0x0/.test(out);
  } catch {
    // Value absent = Windows default (auto-hide).
  }
  app.commandLine.appendSwitch(
    'enable-features',
    alwaysShow ? 'FluentScrollbar' : 'FluentScrollbar,FluentOverlayScrollbar',
  );
}

// Portable copy ("portable for now"): when a `data` folder sits beside
// Miserly.exe, everything the app keeps (the database, window state, the browser profile) lives
// in it, so the folder can be unzipped, moved or copied whole. The portable zip ships that folder
// (scripts/portable-zip.mjs); an installed copy or a dev build has none and keeps the OS userData
// dir. Must run before the single-instance lock and any getPath('userData').
if (app.isPackaged && process.windowsStore) {
  // Microsoft Store (MSIX) copy: the install folder is read-only, and new files under AppData
  // are redirected into the package, hidden from Explorer and deleted on uninstall. Keep the
  // data in a real folder the person can see, back up and keep: `Miserly data` in their user
  // folder (not Documents, which OneDrive often syncs; a synced open SQLite file can corrupt).
  const storeData = path.join(app.getPath('home'), 'Miserly data');
  try {
    require('node:fs').mkdirSync(storeData, { recursive: true });
    app.setPath('userData', storeData);
  } catch {
    // A user folder we can't write: the redirected userData still works, for this launch.
  }
} else if (app.isPackaged) {
  const portableData = path.join(path.dirname(process.execPath), 'data');
  try {
    // A real write: on Windows accessSync(W_OK) only reads the read-only attribute, not the ACL.
    const probe = path.join(portableData, '.write-test');
    require('node:fs').writeFileSync(probe, '');
    require('node:fs').unlinkSync(probe);
    app.setPath('userData', portableData);
  } catch {
    // No data folder, or a read-only place (Program Files): the usual userData dir.
  }
}

// The self-contained server tree assembled by scripts/prepare-server.mjs
// (build/ + a node_modules whose better-sqlite3 is rebuilt for the Electron
// ABI). Unpacked outside the asar in packaged form (electron-builder.yml) so
// its native .node addons are loadable.
const serverDir = app.isPackaged
  ? path.join(process.resourcesPath, 'server')
  : path.join(__dirname, 'server');

/** @type {BrowserWindow | null} */
let mainWindow = null;
/** Saves window-state.json soon (the app's theme changed). */
let saveState = () => {};

/** Ask the OS for an ephemeral free port on the loopback interface. */
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/** Can the server listen on `port` (loopback)? */
function portIsFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}

/** The port the last launch used, while it's free; else a new free one, remembered in
 *  userData. The page's local storage belongs to its address, port included, so a new port every
 *  launch forgot the folded sidebar and its width, Quick Add's last account and "Add another", and
 *  the register's saved filters (cookies ignore the port, so the sign-in survived). */
async function stablePort() {
  const fs = require('node:fs');
  const file = path.join(app.getPath('userData'), 'port.json');
  let saved = 0;
  try {
    saved = Number(JSON.parse(fs.readFileSync(file, 'utf8')).port) || 0;
  } catch {
    // First launch, or an unreadable file: pick one below.
  }
  if (saved >= 1024 && saved <= 65535 && (await portIsFree(saved))) return saved;
  const port = await getFreePort();
  try {
    fs.writeFileSync(file, JSON.stringify({ port }));
  } catch {
    // A read-only data folder: this launch still works, the next picks again.
  }
  return port;
}

/** The person's Windows accent colour as #rrggbb (the "Windows accent" choice), or null. Windows
 *  keeps the accent's eight shades in Explorer\Accent\AccentPalette (RGBA each; the fourth is the
 *  accent itself, Settings' "Accent colour"). Electron 33's getAccentColor() returned the translucent
 *  glass colourisation instead (a translucent grey where the accent was #0078d4), so it is only the
 *  fallback. */
/** Is the Windows taskbar light? (Settings > Personalisation > Colours: "Choose your default
 *  Windows mode", which can differ from the apps' mode.) */
function taskbarIsLight() {
  try {
    const out = require('node:child_process').execFileSync(
      'reg',
      ['query', String.raw`HKCU\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize`, '/v', 'SystemUsesLightTheme'],
      { encoding: 'utf8', windowsHide: true, timeout: 2000 },
    );
    return /SystemUsesLightTheme\s+REG_DWORD\s+0x0*1\b/i.test(out);
  } catch {
    return false; // no value (older Windows): the dark taskbar, Windows 11's default
  }
}
/** The running window's icon follows the taskbar's theme: the deep gold on a
 *  light taskbar, the bright gold on a dark one (the launch page's pair). A classic installer has one
 *  icon set, so shortcuts, a pinned button and the Start menu keep the installer's deep gold; only an
 *  MSIX package gets per-theme icons there (with signing). */
function taskbarIcon(win) {
  if (process.platform !== 'win32' || !win || win.isDestroyed()) return;
  win.setIcon(path.join(__dirname, taskbarIsLight() ? 'taskbar-light.ico' : 'taskbar-dark.ico'));
}

function windowsAccent() {
  if (process.platform === 'win32') {
    try {
      const out = require('node:child_process').execFileSync(
        'reg',
        ['query', String.raw`HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\Accent`, '/v', 'AccentPalette'],
        { encoding: 'utf8', windowsHide: true, timeout: 2000 },
      );
      const hex = /AccentPalette\s+REG_BINARY\s+([0-9A-F]{64})/i.exec(out)?.[1];
      if (hex) return `#${hex.slice(24, 30).toLowerCase()}`;
    } catch {
      // No palette (older Windows): Electron's value.
    }
  }
  try {
    const c = systemPreferences.getAccentColor(); // RRGGBBAA
    return /^[0-9a-f]{6}/i.test(c) ? `#${c.slice(0, 6).toLowerCase()}` : null;
  } catch {
    return null;
  }
}
/** Hand it to the server as a cookie, so the first frame is already in it (hooks.server.ts). */
function accentCookie(url) {
  const hex = windowsAccent();
  if (!hex) return Promise.resolve();
  return session.defaultSession.cookies
    .set({ url, name: 'miserly_win_accent', value: hex.slice(1), expirationDate: Date.now() / 1000 + 365 * 24 * 3600, sameSite: 'lax' })
    .catch(() => {});
}

/** Resolve once the server accepts a TCP connection on `port`, or reject after `timeoutMs`. */
function waitForPort(port, host, timeoutMs = 20000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const sock = net.connect(port, host);
      sock.once('connect', () => {
        sock.destroy();
        resolve();
      });
      sock.once('error', () => {
        sock.destroy();
        if (Date.now() - start > timeoutMs) {
          reject(new Error(`server did not start listening on ${host}:${port}`));
        } else {
          setTimeout(attempt, 150);
        }
      });
    };
    attempt();
  });
}

/** Set the env contract, import (and thereby start) the server, wait for listen. Returns the ORIGIN. */
async function startServer() {
  const port = await stablePort();
  process.env.MISERLY_DB_PATH = path.join(app.getPath('userData'), 'miserly.db');
  // The bundled server can't resolve its own migrations dir — point at the copy
  // prepare-server.mjs placed alongside build/ (see migrate.ts).
  process.env.MISERLY_MIGRATIONS_DIR = path.join(serverDir, 'drizzle');
  // F4: Settings' Import takes Actual's export zip (up to 60 MB); adapter-node refuses bodies over 512 KB by default.
  process.env.BODY_SIZE_LIMIT = '64M';
  process.env.HOST = '127.0.0.1'; // loopback ONLY — never expose the desktop server on the network.
  process.env.PORT = String(port);
  process.env.ORIGIN = `http://127.0.0.1:${port}`;

  const entry = pathToFileURL(path.join(serverDir, 'build', 'index.js')).href;
  await import(entry); // ESM server; auto-listens using the env just set.
  await waitForPort(port, '127.0.0.1');
  return process.env.ORIGIN;
}

// Caption-button strip for the Window-Controls-Overlay title bar. Windows/Linux let
// Chromium + the OS DRAW the native min/□/✕ (so hover, the red close, Windows 11 Snap
// Layouts, DPI + high-contrast are all native and correct — the way the current Microsoft
// Teams shell does it). The TopBar is a translucent MICA GRADIENT, so a solid overlay
// `color` can never match it — we make the caption background fully TRANSPARENT
// (`rgba(0,0,0,0)`, which Electron's overlay accepts) so the gradient shows straight
// through and only the glyphs are OS-painted. `symbolColor` = --text so the glyphs stay
// legible on the gradient in each theme; height matches --topbar-h. macOS uses inset
// traffic-lights instead.
// Inactive window: Windows dims a caption's glyphs; the overlay doesn't on its own
// (seen in the real-window capture), so the inactive colours are the muted text.
let appDark = null; // the renderer's resolved theme, once it has reported one
let appBlack = false; // the Black theme: Dark on a true-black ground
let windowActive = true;
// The page's zoom: the title bar is 48 px of page, so at 125 % it's 60 px tall and the OS buttons'
// rect must grow with it, or they sit high in a taller bar. Windows draws the
// glyphs at its own size; only their backplates follow.
let appZoom = 1;
function overlayFor(isDark, active = windowActive) {
  const height = Math.round(48 * appZoom);
  if (isDark) return { color: 'rgba(0,0,0,0)', symbolColor: active ? '#ece8df' : '#8a857c', height };
  // Transparent WHITE in Light: Electron tints min / max on hover with a colour readable on `color`,
  // ignoring its alpha, so transparent black gave a white tint, invisible on the light bar (owner,
  // no hover on minimise or maximise). White gives Windows' dark 10 % tint.
  return { color: 'rgba(255,255,255,0)', symbolColor: active ? '#1c1813' : '#9a958c', height };
}
/** The window's ground before the page paints: the app's --bg in its theme. */
function groundFor(dark) {
  return dark ? (appBlack ? GROUND.black : GROUND.dark) : GROUND.light;
}
function overlayColors() {
  return overlayFor(appDark ?? nativeTheme.shouldUseDarkColors);
}

// Right-click menu. Electron shows none unless the app builds one. Text fields get
// the standard edit commands (and spelling suggestions); selected text elsewhere gets Copy.
// The title strip's right-click is the OS system menu, so it never reaches here.
function contextMenuFor(wc, params) {
  const items = [];
  if (params.isEditable) {
    if (params.misspelledWord) {
      for (const w of params.dictionarySuggestions.slice(0, 5)) {
        items.push({ label: w, click: () => wc.replaceMisspelling(w) });
      }
      items.push({
        label: 'Add to dictionary',
        click: () => wc.session.addWordToSpellCheckerDictionary(params.misspelledWord),
      });
      items.push({ type: 'separator' });
    }
    const f = params.editFlags;
    items.push(
      { role: 'undo', enabled: f.canUndo },
      { role: 'redo', enabled: f.canRedo },
      { type: 'separator' },
      { role: 'cut', enabled: f.canCut },
      { role: 'copy', enabled: f.canCopy },
      { role: 'paste', enabled: f.canPaste },
      { type: 'separator' },
      { role: 'selectAll', enabled: f.canSelectAll },
    );
  } else if (params.selectionText && params.selectionText.trim()) {
    items.push({ role: 'copy' });
  }
  return items.length ? Menu.buildFromTemplate(items) : null;
}

const MIN_W = 900; // below this the 48px rail + register still fit without clipping (B7)
const MIN_H = 600;

// The app's grounds (--bg in app.css) and the mark's gold per theme (the launch page's pair).
const GROUND = { light: '#f5f5f5', dark: '#171717', black: '#000000' };
const MARK = { light: '#a9822f', dark: '#c9a24b' };
const MUTED = { light: '#5c5c5c', dark: '#adadad' }; // --text-muted

/** The app's Inter (latin), embedded as the app names it ("Inter Variable") so the splash's name has
 *  the app's fallback face before the server that serves it is up; Windows 11 sets it in Segoe UI
 *  Variable, as the app and its cover do (the splash used Inter first, the cover and the app
 *  Segoe, so the name changed face at the hand-over). Absent (a dev tree without a build): ''. */
function splashFont() {
  try {
    const dir = path.join(serverDir, 'build', 'client', '_app', 'immutable', 'assets');
    const file = require('node:fs').readdirSync(dir).find((f) => /^inter-latin-wght-normal.*\.woff2$/.test(f));
    if (!file) return '';
    const b64 = require('node:fs').readFileSync(path.join(dir, file)).toString('base64');
    return `@font-face{font-family:'Inter Variable';font-weight:100 900;src:url(data:font/woff2;base64,${b64}) format('woff2')}`;
  } catch {
    return '';
  }
}

// The launch. Windows' own model (a store app's splash: "a composite of a splash screen
// image and a background color", dismissed when the app is ready) and Office's: the first thing
// on screen is already at its final size and in the app's colours, and changes once, to the
// finished app. So the window opens at once, before the server is up, at its final size (a
// maximised window is CREATED at the work area's size: maximize() on a smaller hidden window
// shows it small and grows it), in the theme the app last used (saved by window-state, not the
// OS theme), showing the splash page with the mark; then the app, which fades its own identical
// cover once it has drawn.
// The splash (the diamond's animation from the coming-soon page): the hollow diamond makes its first
// quarter turn, muted to gold, in 500 ms, so the gesture completes inside a normal ~1 s launch
// (Android's splash guidance: an icon animation under 1,000 ms, cut short when the app is ready,
// a loop for slower starts, never an artificial hold); then, if the app is still loading, it
// ratchets: a quarter turn on the coming-soon page's curve (cubic-bezier(.16,1,.3,1)), a pause,
// another. A diamond turned 90 degrees is the same shape, so at every pause it matches the app's
// cover. The name fades in under it, small and muted. Static when Windows' animations are off.
function splashHtml(dark, black = false) {
  const bg = black ? GROUND.black : dark ? GROUND.dark : GROUND.light;
  const mark = dark ? MARK.dark : MARK.light;
  const muted = dark ? MUTED.dark : MUTED.light;
  return `<!doctype html><html><head><meta charset="utf-8"><style>${splashFont()}
html,body{margin:0;height:100%;background:${bg};overflow:hidden}
body{display:grid;place-items:center;transition:opacity 150ms ease-out}
body.out{opacity:0}
main{display:flex;flex-direction:column;align-items:center;gap:14px}
svg{display:block;transform:rotate(-90deg);animation:first 500ms cubic-bezier(0.16,1,0.3,1) forwards,tick 1.4s cubic-bezier(0.16,1,0.3,1) 1.06s infinite}
path{stroke:${muted};animation:gold 500ms cubic-bezier(0.16,1,0.3,1) forwards}
p{margin:0;font:600 15px/20px 'Segoe UI Variable Text','Segoe UI Variable','Segoe UI','Inter Variable',sans-serif;letter-spacing:-0.01em;color:${muted};opacity:0;animation:fade 300ms ease-out 350ms forwards}
@keyframes first{to{transform:rotate(0deg)}}
@keyframes tick{0%{transform:rotate(0deg)}60%,100%{transform:rotate(90deg)}}
@keyframes gold{to{stroke:${mark}}}
@keyframes fade{to{opacity:1}}
@media (prefers-reduced-motion:reduce){svg{animation:none;transform:none}path{animation:none;stroke:${mark}}p{animation:none;opacity:1}}
</style></head><body><main><svg width="44" height="44" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 1.06 22.94 12 12 22.94 1.06 12Z" stroke-width="1.5" stroke-linejoin="miter"/></svg><p>Miserly</p></main></body></html>`;
}

/**
 * `cookieTheme`: the server's `miserly_theme` cookie (the last signed-in user's choice), read before
 * the window exists; the fallback when window-state has no saved theme yet (the first launch after
 * an update). "system" or none = the OS theme.
 */
function createWindow(cookieTheme) {
  const isMac = process.platform === 'darwin';
  // Reopen at the last size, place and maximised state (clamped to a current display).
  const saved = windowState.restore(app.getPath('userData'), {
    width: 1440,
    height: 900,
    minWidth: MIN_W,
    minHeight: MIN_H,
  });
  if (typeof saved.dark === 'boolean') {
    appDark = saved.dark;
    appBlack = saved.dark && saved.black;
  } else if (cookieTheme === 'dark' || cookieTheme === 'black' || cookieTheme === 'light') {
    appDark = cookieTheme !== 'light';
    appBlack = cookieTheme === 'black';
  }
  const startDark = appDark ?? nativeTheme.shouldUseDarkColors;
  // A maximised window starts at the work area's size, so the page is laid out once, at its
  // final width (it drew at the restored size, then grew).
  const startBounds = saved.maximized ? screen.getDisplayMatching(saved.bounds).workArea : saved.bounds;
  // Windows plays its open animation on the window's first, unpainted image, which Chromium leaves
  // white: every launch flashed a white rectangle (the corner one in the owner's report, then a
  // full-screen one; filmed with or without a splash). So the window is first shown OFF
  // screen, the animation plays there, and it moves on screen once the splash has painted; a move
  // isn't animated. (Windows only; macOS shows in place.)
  const offscreen = !isMac;
  // Filmed 2 of 21 launches: even so, the whole window sometimes arrived white. Chromium
  // may not draw an off-screen window (it counts as occluded), so on a slow launch it came on
  // screen with no frame yet. It is therefore created fully transparent (a layered window at
  // opacity 0) and turned opaque only once a frame has been drawn where it really is.
  const left = Math.min(...screen.getAllDisplays().map((d) => d.bounds.x));
  mainWindow = new BrowserWindow({
    ...startBounds,
    ...(offscreen ? { x: left - startBounds.width - 200, y: startBounds.y } : {}),
    minWidth: MIN_W,
    minHeight: MIN_H,
    // Until the page sets its own title, Electron would show the package name (@miserly/desktop)
    // in Alt+Tab and the taskbar. Renaming the app instead would move a non-portable copy's data.
    title: 'Miserly',
    show: false,
    ...(offscreen ? { opacity: 0 } : {}),
    backgroundColor: groundFor(startDark), // the app's grounds, in the app's theme
    // Title bar: hide the default frame and let the OS paint the caption buttons as a
    // Window-Controls-Overlay (Win/Linux). These are NATIVE controls that exist from the
    // instant the window does — on EVERY screen (login, loading, app), independent of the
    // renderer, the preload bridge, or which route is mounted — so they can never go
    // missing the way the hand-drawn HTML buttons did. The renderer extends its own
    // branded chrome (breadcrumb, search, Add) up into the rest of the strip and styles
    // it only under `.wco`, so the hosted/browser build is untouched. macOS keeps inset
    // traffic-lights.
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    ...(isMac ? {} : { titleBarOverlay: overlayColors() }),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.cjs'),
      additionalArguments: alwaysShow ? ['--miserly-always-scrollbars'] : [],
    },
  });
  saveState = windowState.track(mainWindow, app.getPath('userData'), {
    normal: saved.maximized ? saved.bounds : null,
    dark: () => appDark,
    black: () => appBlack,
  });
  taskbarIcon(mainWindow);
  // A link that opens a new window (About's Licence and Third-party notices, the User guide) goes
  // to the person's browser. Electron's default would open a bare app window that inherits this
  // one's settings, the preload bridge included (dataFile() returns the data path), with an
  // outside site in it. Only http(s) addresses leave; every new window is refused.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
  // The splash is the window's own first page (rebuilt): shown once it has
  // painted, in the saved maximised state (the window is already that size). A separate splash layer
  // (WebContentsView) was tried first and flashed white for 100-300 ms on every launch in Electron
  // 33 (filmed); the window's own page never does. When the server is up the window loads the app:
  // Chromium keeps the splash on screen until the app's first frame, and that frame carries an
  // identical cover (app.html) that fades once the page has drawn (+layout.svelte).
  let shown = false;
  const showWindow = () => {
    if (shown || mainWindow.isDestroyed()) return;
    shown = true;
    if (!offscreen) {
      if (saved.maximized) mainWindow.maximize();
      mainWindow.show();
      return;
    }
    mainWindow.show(); // off screen: the open animation plays where nobody sees it
    const reveal = () => {
      if (!mainWindow.isDestroyed()) mainWindow.setOpacity(1); // 1 drops the layered style again
    };
    const onScreen = () => {
      if (mainWindow.isDestroyed()) return;
      mainWindow.setBounds(startBounds);
      if (saved.maximized) mainWindow.maximize(); // same rectangle: nothing visible changes
      mainWindow.focus();
      // A frame drawn on screen (two animation frames now it's there), then opaque; 400 ms caps it.
      Promise.race([
        mainWindow.webContents
          .executeJavaScript('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))')
          .catch(() => {}),
        new Promise((r) => setTimeout(r, 400)),
      ]).then(reveal);
    };
    setTimeout(reveal, 3000); // never stay transparent, whatever happened above
    // Painted = two animation frames (they run now the window is shown); 500 ms caps the wait.
    Promise.race([
      mainWindow.webContents
        .executeJavaScript('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 60))))')
        .catch(() => {}),
      new Promise((r) => setTimeout(r, 500)),
    ]).then(onScreen);
  };
  mainWindow.once('ready-to-show', showWindow);
  setTimeout(showWindow, 1500); // never stay invisible if the splash fails to draw
  mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(splashHtml(startDark, startDark && appBlack)));
  const wc = mainWindow.webContents;
  wc.on('context-menu', (_e, params) => {
    const menu = contextMenuFor(wc, params);
    if (menu) menu.popup({ window: mainWindow });
  });
  // Zoom steps are Edge's and Chrome's presets (90, 100, 110, 125, 150 ...): Electron's half zoom
  // levels gave 110, 120, 131 (visual checks F9). The "…" menu's row and the keys share it.
  const ZOOMS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
  const zoomStep = (step) => {
    const f = wc.getZoomFactor();
    if (step === 0) wc.setZoomFactor(1);
    else if (step > 0) wc.setZoomFactor(ZOOMS.find((z) => z > f + 0.001) ?? ZOOMS[ZOOMS.length - 1]);
    else if (step < 0) wc.setZoomFactor([...ZOOMS].reverse().find((z) => z < f - 0.001) ?? ZOOMS[0]);
    const z = wc.getZoomFactor();
    if (z !== appZoom) {
      appZoom = z;
      if (!isMac && !mainWindow.isDestroyed()) mainWindow.setTitleBarOverlay(overlayColors());
    }
    return Math.round(z * 100);
  };
  ipcMain.removeAllListeners('miserly:zoom');
  ipcMain.on('miserly:zoom', (e, step) => {
    e.returnValue = zoomStep(step); // NaN only reads it
  });
  // The zoom keys went with the default menu. Ctrl+= / Ctrl++ zoom in, Ctrl+- out, Ctrl+0 resets.
  wc.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown' || !(input.control || input.meta) || input.alt) return;
    if (input.key === '=' || input.key === '+') zoomStep(1);
    else if (input.key === '-' || input.key === '_') zoomStep(-1);
    else if (input.key === '0' && !input.shift) zoomStep(0);
    else return;
    e.preventDefault();
  });
  // Tell the renderer when the window is active, so the title-strip content dims
  // while inactive (Microsoft Learn: make the inactive state obvious). The renderer can't
  // tell on its own: its document keeps focus when another app is activated.
  const sendActive = (active) => {
    windowActive = active;
    if (!wc.isDestroyed()) wc.send('miserly:window-active', active);
    if (!isMac && !mainWindow.isDestroyed()) mainWindow.setTitleBarOverlay(overlayColors());
  };
  mainWindow.on('focus', () => sendActive(true));
  mainWindow.on('blur', () => sendActive(false));
  // Chromium restores the page's zoom per host on a relaunch, so read it on each load and size the
  // OS buttons' rect to it (sendActive sets the overlay); zoomStep keeps it current after that.
  wc.on('did-finish-load', () => {
    if (!wc.isDestroyed()) appZoom = wc.getZoomFactor();
    sendActive(mainWindow.isFocused());
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// SQLite is a single-writer file — one instance owns it. A second launch just
// focuses the existing window.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    // Drop the default File/Edit/View menu (the boilerplate that reads "generic
    // Electron"). macOS keeps its menu bar — a Mac app with no menu is worse UX.
    if (process.platform !== 'darwin') Menu.setApplicationMenu(null);

    // Repaint the caption-button strip to match the APP's resolved theme — the renderer
    // sends this on load + whenever the in-app theme changes (System/Light/Dark toggle),
    // so a light app on a dark OS (or vice-versa) never shows a mismatched strip. Pure
    // progressive enhancement: if the preload bridge is ever absent, the OS still draws
    // the buttons in the nativeTheme colours set at window creation.
    ipcMain.on('miserly:titlebar-theme', (_e, isDark, isBlack) => {
      appDark = !!isDark;
      appBlack = !!isDark && !!isBlack;
      if (mainWindow) mainWindow.setBackgroundColor(groundFor(appDark));
      if (mainWindow && process.platform !== 'darwin') {
        mainWindow.setTitleBarOverlay(overlayColors());
      }
      saveState(); // the next launch opens in this theme
    });
    ipcMain.on('miserly:accent-color', (e) => {
      e.returnValue = windowsAccent();
    });
    // Settings' Your data card. The path is main's own (startServer's MISERLY_DB_PATH);
    // the renderer can only read it and open its folder, never name another path.
    ipcMain.on('miserly:data-file', (e) => {
      e.returnValue = process.env.MISERLY_DB_PATH ?? '';
    });
    ipcMain.on('miserly:open-data-folder', () => {
      if (process.env.MISERLY_DB_PATH) shell.showItemInFolder(process.env.MISERLY_DB_PATH);
    });

    // The window and its splash first, then the server (nothing was on screen while
    // the server started).
    // The server paints its first frame in the last signed-in theme (its `miserly_theme` cookie);
    // the window, its splash and the caption glyphs start in it too, not in the OS theme.
    const [themeCookie] = await session.defaultSession.cookies.get({ name: 'miserly_theme' }).catch(() => []);
    createWindow(themeCookie?.value);

    let url;
    try {
      url = await startServer();
    } catch (err) {
      console.error('[miserly] failed to start embedded server:', err);
      app.quit();
      return;
    }
    await accentCookie(url);
    mainWindow?.loadURL(url);
    // The Windows accent changed while open: the next page load and the open page follow it.
    systemPreferences.on('accent-color-changed', () => {
      taskbarIcon(mainWindow);
      void accentCookie(url);
      const hex = windowsAccent();
      if (hex && mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('miserly:accent-color', hex);
    });
    // System-default case: follow the OS theme flip while the app is on 'system'.
    // A Windows mode change (taskbar included) is expected here too; checked on the exe.
    nativeTheme.on('updated', () => {
      taskbarIcon(mainWindow);
      if (mainWindow && process.platform !== 'darwin') {
        mainWindow.setTitleBarOverlay(overlayColors());
      }
    });
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow(appDark === null ? undefined : appBlack ? 'black' : appDark ? 'dark' : 'light');
        mainWindow.loadURL(url);
      }
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
