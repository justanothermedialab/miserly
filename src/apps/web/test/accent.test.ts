import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { accentCss, accentTokens, contrast } from '$lib/accent';
import { normalizeAccent } from '$lib/prefs';

// SET1 RD6: every accent, curated or the person's own
// Windows colour, carries a white label at >= 4.5:1 and reads at >= 5.3:1 on both grounds.
describe('accentTokens', () => {
	it('meets the contrast rule for any seed colour', () => {
		fc.assert(
			fc.property(fc.integer({ min: 0, max: 0xffffff }), (n) => {
				const t = accentTokens('#' + n.toString(16).padStart(6, '0'))!;
				expect(contrast(t.fill, '#ffffff')).toBeGreaterThanOrEqual(4.5);
				expect(contrast(t.textLight, '#f5f5f5')).toBeGreaterThanOrEqual(5.3);
				expect(contrast(t.textDark, '#171717')).toBeGreaterThanOrEqual(5.3);
			}),
			{ numRuns: 300 }
		);
	});

	// A selected row takes the weak tint: money and text still read on it.
	it('keeps green and red amounts readable on the selection tint for any seed', () => {
		fc.assert(
			fc.property(fc.integer({ min: 0, max: 0xffffff }), (n) => {
				const t = accentTokens('#' + n.toString(16).padStart(6, '0'))!;
				for (const money of ['#376e3e', '#b03e37', '#7a5214']) expect(contrast(money, t.weakLight)).toBeGreaterThanOrEqual(4.5);
				for (const money of ['#78b483', '#e28d8d']) expect(contrast(money, t.weakDark)).toBeGreaterThanOrEqual(4.5);
			}),
			{ numRuns: 300 }
		);
	});

	it('keeps a seed that already passes (Fluent blue stays itself)', () => {
		expect(accentTokens('#0f6cbd')!.fill).toBe('#0f6cbd');
	});

	it('reads Windows accent values with alpha, or none', () => {
		expect(accentTokens('0078d4ff')).not.toBeNull();
		expect(accentTokens('not a colour')).toBeNull();
		expect(accentTokens('')).toBeNull();
	});
});

describe('the curated CSS', () => {
	const css = readFileSync(new URL('../src/app.css', import.meta.url), 'utf8');
	it.each([['teal', '#038387']])('%s in app.css is the solver output for its seed', (name, seed) => {
		for (const line of accentCss(name, accentTokens(seed)!).split('\n')) expect(css).toContain(line);
	});

	it('lime stays bright with a dark label; its text and marks pass in both themes', () => {
		const light = css.match(/:root\[data-accent='lime'\] \{([^}]*)\}/)![1]!;
		const dark = css.match(/:root\[data-accent='lime'\]:is\(\[data-theme='dark'\][^{]*\{([^}]*)\}/)![1]!;
		const tok = (block: string, name: string) => block.match(new RegExp(`--${name}: (#[0-9a-f]{6})`))![1]!;
		expect(tok(light, 'accent')).toBe('#bdee63');
		expect(contrast(tok(light, 'primary-foreground'), tok(light, 'accent'))).toBeGreaterThanOrEqual(4.5);
		expect(contrast(tok(light, 'accent-ink'), '#f5f5f5')).toBeGreaterThanOrEqual(5.3);
		expect(contrast(tok(dark, 'accent-ink'), '#171717')).toBeGreaterThanOrEqual(5.3);
		expect(contrast(tok(light, 'accent-mark'), '#f5f5f5')).toBeGreaterThanOrEqual(3);
		expect(contrast(tok(dark, 'accent-mark'), '#171717')).toBeGreaterThanOrEqual(3);
	});
});

describe('normalizeAccent', () => {
	it('maps the retired trial choices and rejects unknowns', () => {
		expect(normalizeAccent('teal')).toBe('teal');
		expect(normalizeAccent('lime')).toBe('lime');
		expect(normalizeAccent('coral')).toBe('lime');
		expect(normalizeAccent('blue')).toBe('teal');
		expect(normalizeAccent('indigo')).toBe('teal');
		expect(normalizeAccent('purple')).toBe('lime');
		expect(normalizeAccent('plum')).toBe('lime');
		expect(normalizeAccent('gold')).toBe('gold');
		expect(normalizeAccent('windows')).toBe('windows');
		expect(normalizeAccent('mauve')).toBe('ink');
		expect(normalizeAccent(null)).toBe('ink');
	});
});
