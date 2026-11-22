// Minimal, sandboxed preload: the ONLY bridge between the web app and the Electron main
// process. The window's min/□/✕ are drawn NATIVELY by the OS as a Window-Controls-Overlay
// (see main.cjs) — they need no bridge and are present on every screen regardless of this
// file. This exposes a call so the renderer can tell main the app's resolved theme
// (light/dark), which main uses to repaint the overlay caption strip to match — fixing the
// "dark caption strip over a light app" mismatch when the in-app theme differs from the OS
// theme — plus one read-only flag for the scrollbar setting and a window-activation
// listener. contextIsolation stays on.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('miserlyDesktop', {
  // The title bar's "…" menu zoom: +1 / -1 a half step, 0 resets, NaN reads;
  // returns the zoom as a whole percent.
  zoom: (step) => ipcRenderer.sendSync('miserly:zoom', Number(step)),
  setTitleBarTheme: (isDark, isBlack) => ipcRenderer.send('miserly:titlebar-theme', !!isDark, !!isBlack),
  // The person's Windows accent colour, for the "Windows accent" choice.
  accentColor: () => ipcRenderer.sendSync('miserly:accent-color'),
  onAccentColor: (cb) => {
    const h = (_e, hex) => cb(String(hex));
    ipcRenderer.on('miserly:accent-color', h);
    return () => ipcRenderer.removeListener('miserly:accent-color', h);
  },
  // The database file's path (Settings, Your data) and a way to show it in Explorer.
  dataFile: () => ipcRenderer.sendSync('miserly:data-file'),
  openDataFolder: () => ipcRenderer.send('miserly:open-data-folder'),
  // Windows "Always show scrollbars" (main.cjs reads it): the app panes then keep the
  // native always-visible bar instead of drawing their own auto-hiding one.
  alwaysShowScrollbars: process.argv.includes('--miserly-always-scrollbars'),
  // Window activation (main sends it on focus / blur), so the title strip can dim.
  onWindowActive: (cb) => {
    const h = (_e, active) => cb(!!active);
    ipcRenderer.on('miserly:window-active', h);
    return () => ipcRenderer.removeListener('miserly:window-active', h);
  },
});
