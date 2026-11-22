/**
 * head-script.test.ts — `app.html`'s inline head scripts run before first paint. The desktop
 * window's caption buttons need `<html class="wco">` from that moment, not from hydration, or a
 * full page load draws Add under Windows' minimise until the page hydrates. A browser tab
 * reports the overlay as not visible and must stay without the class.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../src/app.html', import.meta.url), 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gu)].map((m) => m[1]!);

function runHead(navigator: Record<string, unknown>): Set<string> {
	const classes = new Set<string>();
	const root = {
		dataset: {} as Record<string, string>,
		style: { setProperty() {} },
		classList: { add: (c: string) => classes.add(c) },
		hasAttribute: () => false,
	};
	const context = vm.createContext({
		navigator,
		document: { documentElement: root, cookie: '' },
		localStorage: { getItem: () => null },
		sessionStorage: { getItem: () => null },
		matchMedia: () => ({ matches: false }),
		innerWidth: 1232,
		Intl,
		encodeURIComponent,
		parseInt,
		Math,
	});
	(context as { window: unknown }).window = context;
	for (const s of scripts) vm.runInContext(s, context);
	return classes;
}

describe('app.html head: the caption buttons reserve their space before first paint', () => {
	it('adds wco when the window has a visible controls overlay', () => {
		expect(runHead({ windowControlsOverlay: { visible: true } }).has('wco')).toBe(true);
	});
	it('adds wco while the overlay has not reported yet (visible undefined)', () => {
		expect(runHead({ windowControlsOverlay: {} }).has('wco')).toBe(true);
	});
	it('leaves a browser tab without it (overlay present, not visible)', () => {
		expect(runHead({ windowControlsOverlay: { visible: false } }).has('wco')).toBe(false);
	});
	it('leaves a browser without the API without it', () => {
		expect(runHead({}).has('wco')).toBe(false);
	});
});
