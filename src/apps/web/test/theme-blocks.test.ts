/**
 * theme-blocks.test.ts — `app.css` writes the dark tokens twice: for an explicit Dark or Black
 * (`:root:is([data-theme='dark'], [data-theme='black'])`) and for System on a dark OS
 * (`@media (prefers-color-scheme: dark) { :root:not([data-theme]) }`). Nothing generates one from
 * the other yet (deferred register), so this fails the day they drift: System-dark must look
 * exactly like Dark. The accents' dark overrides are held to the same rule.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

const css = fs.readFileSync(new URL('../src/app.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//gu, '');

/** The body of the `{ … }` that opens right after `at` (balanced braces). */
function body(at: number): string {
	const open = css.indexOf('{', at);
	let depth = 0;
	for (let i = open; i < css.length; i++) {
		if (css[i] === '{') depth++;
		else if (css[i] === '}' && --depth === 0) return css.slice(open + 1, i);
	}
	throw new Error('unbalanced braces');
}

/** Custom-property declarations as a name → value map (last one wins, as in CSS). */
function decls(block: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const m of block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/gu)) out[m[1]!] = m[2]!.trim().replace(/\s+/gu, ' ');
	return out;
}

function blockAfter(selector: string, from = 0): string {
	const at = css.indexOf(selector, from);
	expect(at, `${selector} not found`).toBeGreaterThanOrEqual(0);
	return body(at + selector.length - 1);
}

describe('app.css: System-dark matches Dark', () => {
	it('the theme token blocks declare the same tokens with the same values', () => {
		const dark = decls(blockAfter(":root:is([data-theme='dark'], [data-theme='black']) {"));
		const media = css.search(/@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme\]\) \{/u);
		expect(media).toBeGreaterThanOrEqual(0);
		const system = decls(blockAfter(':root:not([data-theme]) {', media));
		expect(Object.keys(dark).length).toBeGreaterThan(40);
		expect(system).toEqual(dark);
	});

	it("each accent's dark override is the same for Dark and System-dark", () => {
		const accents = [...css.matchAll(/:root\[data-accent='([\w-]+)'\]:is\(\[data-theme='dark'\], \[data-theme='black'\]\)/gu)].map((m) => m[1]!);
		expect(accents.length).toBeGreaterThan(0);
		for (const a of accents) {
			const dark = decls(blockAfter(`:root[data-accent='${a}']:is([data-theme='dark'], [data-theme='black']) {`));
			const system = decls(blockAfter(`:root[data-accent='${a}']:not([data-theme]) {`));
			expect(system, a).toEqual(dark);
		}
	});
});
