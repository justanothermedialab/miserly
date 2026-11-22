/**
 * theme.ts — the ONE client-side theme helper (SET1), shared by the Settings
 * theme control and the Ctrl K theme commands (the top-bar toggle is gone). A theme choice is an
 * INSTANT view-switch: it stamps `data-theme` on <html> (or removes it for
 * 'system', letting `prefers-color-scheme` decide) and persists the preference
 * via the same `/prefs/theme` endpoint so it survives reload + other devices.
 */
import { accentCss, accentTokens } from '$lib/accent';

export type Theme = 'system' | 'light' | 'dark' | 'black';

/** Switch with every transition held for two frames (app.css `.theme-switching`), so the new
 *  colours land at once as Windows' do, not ~120 controls fading over the old surfaces (M5). */
export function withoutTransitions(change: () => void): void {
	const root = document.documentElement;
	root.classList.add('theme-switching');
	change();
	requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove('theme-switching')));
}

/** Apply a theme immediately (CSS-only, no reload) and persist it. */
export function applyTheme(theme: Theme): void {
	const root = document.documentElement;
	withoutTransitions(() => {
		if (theme === 'system') delete root.dataset.theme;
		else root.dataset.theme = theme;
	});
	void fetch('/prefs/theme', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ theme })
	});
}

/** The theme currently stamped on <html> ('system' when no attribute is set). */
export function currentTheme(): Theme {
	const t = document.documentElement.dataset.theme;
	return t === 'dark' || t === 'light' || t === 'black' ? t : 'system';
}

/** The viewer's accent colour (SET1): stamped on <html> at once (Ink is the CSS
 *  default, so it needs no attribute) and persisted like the theme. */
export function applyAccent(accent: import('$lib/prefs').Accent): void {
	if (accent === 'windows') installWindowsAccent();
	const root = document.documentElement;
	withoutTransitions(() => {
		if (accent === 'ink') delete root.dataset.accent;
		else root.dataset.accent = accent;
	});
	void fetch('/prefs/accent', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ accent })
	});
}

/** The desktop shell's bridge to the person's Windows accent colour (RRGGBB); absent in a browser. */
type AccentBridge = { accentColor?: () => string | null; onAccentColor?: (cb: (hex: string) => void) => () => void };
export function accentBridge(): AccentBridge | undefined {
	return (window as unknown as { miserlyDesktop?: AccentBridge }).miserlyDesktop;
}

/** Write (or rewrite) the "windows" accent's tokens from the Windows colour, as the server does in
 *  the first byte (hooks.server.ts), for a choice made or a colour changed while the app is open. */
export function installWindowsAccent(hex = accentBridge()?.accentColor?.() ?? null): void {
	const t = hex ? accentTokens(hex) : null;
	if (!t) return;
	let el = document.getElementById('win-accent');
	if (!el) {
		el = document.createElement('style');
		el.id = 'win-accent';
		document.head.append(el);
	}
	el.textContent = accentCss('windows', t);
}
