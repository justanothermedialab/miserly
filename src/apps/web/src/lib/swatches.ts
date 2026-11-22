/**
 * Category and class colours (F2 RD6, R2 RD8; DECISIONS-S4 D4).
 *
 * Ten swatches from the dataviz categorical method, validated in both themes with its
 * script (adjacent CVD and normal-vision separation, chroma, lightness band): no red, no
 * green, no gold, because red and green mean money out and in and gold is the accent. A
 * category stores the LIGHT hex of its swatch (the `colour` column stays a plain #RRGGBB, so
 * nothing in the schema or validation changes); the UI maps a known swatch to its CSS token
 * (`var(--cat-N)`), so the dark step follows the theme. A colour that is not a swatch (picked
 * before the swatch set existed) is shown as stored.
 *
 * A class (module type) keeps one swatch everywhere ($lib/modules CLASS_COLOUR). Categories in the
 * one chart that colours them (Reports' Spending) are coloured by rank in that chart (`rankCss`),
 * as Simplifi and YNAB do: 19 categories over 10 swatches made the top 7 repeat a colour
 * (R2 RD8 amended). A category still stores a swatch; nothing reads it for colour.
 */

export interface Swatch {
	/** 1-based slot; the CSS token is `--cat-{n}`. */
	readonly n: number;
	readonly name: string;
	/** The stored value (it names the slot; the token's light colour may have moved since). */
	readonly hex: string;
}

export const SWATCHES: readonly Swatch[] = [
	{ n: 1, name: 'Cyan', hex: '#0f8fa8' },
	{ n: 2, name: 'Violet', hex: '#4a3aa7' },
	{ n: 3, name: 'Pink', hex: '#e87ba4' },
	{ n: 4, name: 'Purple', hex: '#8e4ec6' },
	{ n: 5, name: 'Orange', hex: '#eb6834' },
	{ n: 6, name: 'Sky', hex: '#4aa3df' },
	{ n: 7, name: 'Magenta', hex: '#c2389a' },
	{ n: 8, name: 'Blue', hex: '#2a78d6' },
	{ n: 9, name: 'Brown', hex: '#a0612c' },
	{ n: 10, name: 'Indigo', hex: '#5c6bc0' }
];

/**
 * The order the ranked series of one chart take the swatches: the first seven well apart in hue
 * (cyan, orange, violet, pink, blue, brown, magenta), so the biggest categories never look alike.
 */
export const RANK_SLOTS: readonly number[] = [1, 5, 2, 3, 8, 9, 7, 4, 6, 10];

/** The CSS colour of the series at `rank` (0-based) in a ranked chart. */
export function rankCss(rank: number): string {
	return `var(--cat-${RANK_SLOTS[((rank % RANK_SLOTS.length) + RANK_SLOTS.length) % RANK_SLOTS.length]})`;
}

/** The neutral residual bucket ("Other"); never an identity. */
export const OTHER_COLOUR = 'var(--cat-other)';

const BY_HEX = new Map(SWATCHES.map((s) => [s.hex.toLowerCase(), s]));

/** The swatch a stored colour is, or undefined for a custom or empty colour. */
export function swatchOf(colour: string | null | undefined): Swatch | undefined {
	return colour ? BY_HEX.get(colour.toLowerCase()) : undefined;
}

/** A CSS colour for a stored category colour: the theme token for a swatch, else the value. */
export function colourCss(colour: string | null | undefined): string | null {
	if (!colour) return null;
	const s = swatchOf(colour);
	return s ? `var(--cat-${s.n})` : colour;
}

/** The CSS colour of swatch slot `i` (0-based, wraps), for entities with a fixed order. */
export function slotCss(i: number): string {
	return `var(--cat-${(((i % SWATCHES.length) + SWATCHES.length) % SWATCHES.length) + 1})`;
}

/**
 * The swatch for a new category: the first one no existing category uses; when all ten are
 * taken, the least used (earliest on a tie), so colours spread evenly.
 */
export function nextSwatch(existing: readonly (string | null)[]): string {
	const counts = new Map(SWATCHES.map((s) => [s.hex, 0]));
	for (const c of existing) {
		const s = swatchOf(c);
		if (s) counts.set(s.hex, (counts.get(s.hex) ?? 0) + 1);
	}
	let best = SWATCHES[0]!;
	for (const s of SWATCHES) if ((counts.get(s.hex) ?? 0) < (counts.get(best.hex) ?? 0)) best = s;
	return best.hex;
}
