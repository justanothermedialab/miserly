/**
 * favicon.test.ts — a browser tab shows the diamond. `app.html` names `/favicon.svg`; a later
 * `<link rel="icon">` (the starter template's Svelte logo in `+layout.svelte`) won, so the page must
 * name no other icon.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const src = new URL('../src/', import.meta.url);

function files(dir: string): string[] {
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
		const p = path.join(dir, e.name);
		return e.isDirectory() ? files(p) : /\.(svelte|html|ts)$/u.test(e.name) ? [p] : [];
	});
}

describe('the tab icon', () => {
	it('app.html is the one place that names an icon, and it is the diamond', () => {
		const withIcon = files(fileURLToPath(src)).filter((f) =>
			/rel=["']icon["']/u.test(fs.readFileSync(f, 'utf8')),
		);
		expect(withIcon.map((f) => path.basename(f))).toEqual(['app.html']);
		const html = fs.readFileSync(new URL('app.html', src), 'utf8');
		expect(html).toMatch(/<link rel="icon" href="\/favicon\.svg"/u);
		const svg = fs.readFileSync(new URL('../static/favicon.svg', import.meta.url), 'utf8');
		expect(svg).toMatch(/<path d="M12 1\.59 22\.41 12 12 22\.41 1\.59 12Z"/u);
	});
});
