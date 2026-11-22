/**
 * window-state.cjs — remember the window's size, position and maximised state.
 *
 * Electron 33 has no built-in persistence (windowStatePersistence arrived in v45), so this
 * mirrors that API's rules: store the NORMAL (restored) bounds and the maximised flag
 * separately; on launch never restore out of reach (the saved rect must overlap a current
 * display's work area by a usable amount, else fall back to the default size centred on the
 * primary display); clamp to the work area and the minimum size; write atomically
 * (tmp + rename), debounced while moving/resizing and flushed on close.
 *
 * Also remembered: the app's own resolved theme (`dark`, and `black` for the Black theme),
 * so the next launch opens its window in the app's colours before the page exists, not in the OS
 * theme's.
 */
const fs = require('node:fs');
const path = require('node:path');
const { screen } = require('electron');

const FILE = 'window-state.json';

/** Saved state → BrowserWindow options ({ x?, y?, width, height }) + whether to maximise. */
function restore(userData, { width, height, minWidth, minHeight }) {
  // Default size, shrunk to fit the primary display's work area (a 1366x768 laptop at 150%
  // scaling has a 1232x720 work area: a fixed 1440x900 window would overhang it) and
  // centred on it.
  const wa = screen.getPrimaryDisplay().workArea;
  const dw = Math.max(minWidth, Math.min(width, wa.width));
  const dh = Math.max(minHeight, Math.min(height, wa.height));
  const def = {
    x: wa.x + Math.round((wa.width - dw) / 2),
    y: wa.y + Math.round((wa.height - dh) / 2),
    width: dw,
    height: dh,
  };
  const fallback = { bounds: def, maximized: false, dark: null, black: false };
  let saved;
  try {
    saved = JSON.parse(fs.readFileSync(path.join(userData, FILE), 'utf8'));
  } catch {
    return fallback;
  }
  const b = saved && saved.bounds;
  const dark = typeof saved?.dark === 'boolean' ? saved.dark : null;
  const black = saved?.black === true;
  if (!b || ![b.x, b.y, b.width, b.height].every(Number.isFinite)) return { ...fallback, dark, black };
  // Find the display whose work area overlaps the saved rect the most.
  let best = null;
  let bestArea = 0;
  for (const d of screen.getAllDisplays()) {
    const w = d.workArea;
    const ox = Math.max(0, Math.min(b.x + b.width, w.x + w.width) - Math.max(b.x, w.x));
    const oy = Math.max(0, Math.min(b.y + b.height, w.y + w.height) - Math.max(b.y, w.y));
    if (ox * oy > bestArea) {
      bestArea = ox * oy;
      best = w;
    }
  }
  // Less than a 200×100 grab area on screen counts as out of reach.
  if (!best || bestArea < 200 * 100) return { bounds: def, maximized: !!saved.maximized, dark, black };
  const w2 = Math.max(minWidth, Math.min(b.width, best.width));
  const h2 = Math.max(minHeight, Math.min(b.height, best.height));
  const x2 = Math.min(Math.max(b.x, best.x), best.x + best.width - w2);
  const y2 = Math.min(Math.max(b.y, best.y), best.y + best.height - h2);
  return { bounds: { x: x2, y: y2, width: w2, height: h2 }, maximized: !!saved.maximized, dark, black };
}

/**
 * Keep the file up to date for `win`. `opts.normal`: the restored bounds to keep while the window
 * was created maximised at the work area's size (it has no other normal bounds until the user
 * restores it once). `opts.dark()`, `opts.black()`: the app's theme to remember. Returns `save()` for changes
 * that aren't window events (the theme).
 */
function track(win, userData, opts = {}) {
  let normal = opts.normal ?? null;
  win.once('unmaximize', () => {
    if (normal && !win.isDestroyed()) win.setBounds(normal);
    normal = null;
  });
  const file = path.join(userData, FILE);
  let timer = null;
  const write = () => {
    clearTimeout(timer);
    timer = null;
    if (win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return;
    const dark = opts.dark ? opts.dark() : null;
    const state = {
      bounds: normal ?? win.getNormalBounds(),
      maximized: win.isMaximized(),
      ...(typeof dark === 'boolean' ? { dark } : {}),
      ...(opts.black && opts.black() ? { black: true } : {}),
    };
    try {
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state));
      fs.renameSync(tmp, file);
    } catch {
      // Unwritable userData: the window just opens at the default size next time.
    }
  };
  const soon = () => {
    clearTimeout(timer);
    timer = setTimeout(write, 500);
  };
  for (const ev of ['resize', 'move', 'maximize', 'unmaximize']) win.on(ev, soon);
  win.on('close', write);
  return soon;
}

module.exports = { restore, track };
