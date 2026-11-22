import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { focusRescue } from '$lib/focus-rescue';

// Focus fell to <body> when the focused element was removed (the bulk "Set category"
// toolbar unmounting, a Select's list items). Chrome sends no focusout for that case.
const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
const settle = async () => {
	await Promise.resolve();
	await frame();
	await frame();
};

let stop: () => void;
let content: HTMLElement;
beforeEach(() => {
	document.body.innerHTML = '<main id="app-content" tabindex="-1"><div id="bar"><button id="b">Set category</button></div><button id="other">Other</button></main>';
	content = document.getElementById('app-content')!;
	stop = focusRescue(() => document.getElementById('app-content'));
});
afterEach(() => {
	stop();
	document.body.innerHTML = '';
});

describe('focusRescue', () => {
	it('lands focus on the page when the focused element is removed', async () => {
		document.getElementById('b')!.focus();
		document.getElementById('bar')!.remove();
		await settle();
		expect(document.activeElement).toBe(content);
	});

	it('leaves focus alone when a component moved it itself', async () => {
		const other = document.getElementById('other')!;
		document.getElementById('b')!.focus();
		document.getElementById('bar')!.remove();
		other.focus();
		await settle();
		expect(document.activeElement).toBe(other);
	});

	it('ignores removals of elements that never had focus', async () => {
		const other = document.getElementById('other')!;
		other.focus();
		document.getElementById('bar')!.remove();
		await settle();
		expect(document.activeElement).toBe(other);
	});

	it('rescues after an outside click blurred the item before its list was removed', async () => {
		const b = document.getElementById('b')!;
		b.focus();
		b.blur(); // the click on a non-focusable row
		await settle();
		document.getElementById('bar')!.remove(); // the list, after its close animation
		await settle();
		expect(document.activeElement).toBe(content);
	});

	it('keeps focus on a Select trigger when an outside click dismisses its list', async () => {
		document.body.insertAdjacentHTML('beforeend', '<div data-slot="select-content" role="listbox"></div>');
		const trigger = document.getElementById('other')!;
		trigger.focus();
		document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
		trigger.blur(); // the click lands on a non-focusable row
		document.querySelector('[data-slot=select-content]')!.remove();
		await settle();
		expect(document.activeElement).toBe(trigger);
	});

	it('leaves a click on empty space alone when no popup is open', async () => {
		const b = document.getElementById('other')!;
		b.focus();
		document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
		b.blur();
		await settle();
		expect(document.activeElement).toBe(document.body);
	});
});
