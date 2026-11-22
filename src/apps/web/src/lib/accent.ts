/**
 * accent.ts: an accent colour's token set from one seed colour (SET1 RD6).
 * Pure: no DOM, no server imports.
 * ============================================================================
 * The rule every accent follows (COLOUR-AUDIT.md §8, Fluent's ~5:1): the fill carries a WHITE label
 * at >= 4.5:1; accent text on the page ground reads at >= 5.3:1 in Light and in Dark; a weak tint
 * for selected backgrounds. The seed's hue and chroma are kept (OKLCH); only lightness moves, and
 * only as far as the targets need, so a saturated seed stays saturated (Palmer and Schloss: people
 * prefer saturated colours). Used for the curated Teal (its CSS in app.css is checked against this
 * by test; Coral is hand-set, see app.css) and at run time for "Windows accent", whose seed is the colour the person
 * chose in Windows (the desktop shell reads it).
 * ============================================================================
 */

type Rgb = [number, number, number];
type Lch = [number, number, number];

const GROUND_LIGHT = '#f5f5f5';
const GROUND_DARK = '#171717';
const LABEL = '#ffffff';
const FILL_MIN = 4.5;
const TEXT_MIN = 5.3;

const toLin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGam = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

export function parseHex(hex: string): Rgb | null {
	const m = /^#?([0-9a-f]{6})(?:[0-9a-f]{2})?$/iu.exec(hex.trim());
	if (!m) return null;
	const n = Number.parseInt(m[1]!, 16);
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const hex = ([r, g, b]: Rgb): string =>
	'#' + [r, g, b].map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('');

function luminance([r, g, b]: Rgb): number {
	return 0.2126 * toLin(r / 255) + 0.7152 * toLin(g / 255) + 0.0722 * toLin(b / 255);
}

/** WCAG 2 contrast ratio of two colours. */
export function contrast(a: string, b: string): number {
	const x = luminance(parseHex(a)!);
	const y = luminance(parseHex(b)!);
	return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

function toOklch([r, g, b]: Rgb): Lch {
	const [lr, lg, lb] = [toLin(r / 255), toLin(g / 255), toLin(b / 255)];
	const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
	const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
	const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
	const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
	const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
	const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
	return [L, Math.hypot(A, B), Math.atan2(B, A)];
}

function inGamut([L, C, H]: Lch): Rgb | null {
	const A = C * Math.cos(H);
	const B = C * Math.sin(H);
	const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
	const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
	const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
	const lin = [
		4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
		-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
		-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
	];
	if (lin.some((v) => v < -0.0005 || v > 1.0005)) return null;
	return lin.map((v) => toGam(Math.min(1, Math.max(0, v))) * 255) as Rgb;
}

/** The colour at lightness L with the seed's hue, its chroma reduced only if it leaves sRGB. */
function at(L: number, C: number, H: number): string {
	for (let c = C; c >= 0; c -= 0.002) {
		const rgb = inGamut([L, c, H]);
		if (rgb) return hex(rgb);
	}
	return hex(inGamut([L, 0, H])!);
}

/** Walk lightness from the seed's in `step` until `ok` holds (the nearest passing lightness). */
function solve(seed: Lch, step: number, ok: (c: string) => boolean): string {
	const [L0, C, H] = seed;
	for (let L = L0; L >= 0 && L <= 1; L += step) {
		const c = at(L, C, H);
		if (ok(c)) return c;
	}
	return step < 0 ? '#000000' : '#ffffff';
}

export interface AccentTokens {
	/** The fill (buttons, the selected marker), with a white label; the same in both themes. */
	readonly fill: string;
	readonly textLight: string;
	readonly textDark: string;
	readonly weakLight: string;
	readonly weakDark: string;
}

/** The token set for a seed colour, or null if the seed isn't a hex colour. */
export function accentTokens(seedHex: string): AccentTokens | null {
	const rgb = parseHex(seedHex);
	if (!rgb) return null;
	const seed = toOklch(rgb);
	const [, C, H] = seed;
	return {
		fill: solve(seed, -0.005, (c) => contrast(c, LABEL) >= FILL_MIN),
		textLight: solve(seed, -0.005, (c) => contrast(c, GROUND_LIGHT) >= TEXT_MIN),
		textDark: solve(seed, +0.005, (c) => contrast(c, GROUND_DARK) >= TEXT_MIN),
		weakLight: at(0.955, Math.min(C, 0.035), H),
		weakDark: at(0.3, Math.min(C, 0.045), H),
	};
}

/** The CSS rules for `<html data-accent="name">` in Light, Dark (and Black) and System-dark (app.css's shape). */
export function accentCss(name: string, t: AccentTokens): string {
	const light = `--accent: ${t.fill}; --accent-2: ${t.textLight}; --accent-ink: ${t.textLight}; --accent-weak: ${t.weakLight}; --primary-foreground: #ffffff;`;
	const dark = `--accent-2: ${t.textDark}; --accent-ink: ${t.textDark}; --accent-weak: ${t.weakDark};`;
	return (
		`:root[data-accent='${name}'] { ${light} }\n` +
		`:root[data-accent='${name}']:is([data-theme='dark'], [data-theme='black']) { ${dark} }\n` +
		`@media (prefers-color-scheme: dark) { :root[data-accent='${name}']:not([data-theme]) { ${dark} } }`
	);
}

/** The cookie the desktop shell sets with the Windows accent (RRGGBB), read by hooks.server.ts. */
export const WINDOWS_ACCENT_COOKIE = 'miserly_win_accent';
