import { afterEach, describe, expect, it, vi } from 'vitest';
import { globalAccelerator, isTyping } from '$lib/shortcuts';

// The app-wide accelerators (Ctrl+N, Ctrl+F, Ctrl+Z) act only outside text fields
// and open layers, and a page can claim Ctrl+N for its own "new".
const host = () => ({ quickAdd: vi.fn(), palette: vi.fn(), blocked: vi.fn(() => false) });
const key = (target: HTMLElement, k: string, init: KeyboardEventInit = {}) => {
	const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
	Object.defineProperty(e, 'target', { value: target });
	return e;
};
afterEach(() => {
	document.body.innerHTML = '';
});

describe('globalAccelerator', () => {
	it('a bare N does nothing (item 2.5: a payee typed with focus on the page opened Quick Add)', () => {
		document.body.innerHTML = '<main id="m" tabindex="-1"></main>';
		const h = host();
		expect(globalAccelerator(key(document.getElementById('m')!, 'n'), h)).toBe(false);
		expect(h.quickAdd).not.toHaveBeenCalled();
	});

	it('Ctrl+N goes to the page that claims it, else Quick Add', () => {
		document.body.innerHTML = '<main id="m"></main>';
		const m = document.getElementById('m')!;
		const h = host();
		globalAccelerator(key(m, 'n', { ctrlKey: true }), h);
		expect(h.quickAdd).toHaveBeenCalledTimes(1);
		const claim = (e: Event) => e.preventDefault();
		window.addEventListener('miserly:new', claim);
		globalAccelerator(key(m, 'n', { ctrlKey: true }), h);
		window.removeEventListener('miserly:new', claim);
		expect(h.quickAdd).toHaveBeenCalledTimes(1);
	});

	it("Ctrl+F focuses the page's search field, else opens the palette", () => {
		document.body.innerHTML = '<main id="m"></main>';
		const h = host();
		globalAccelerator(key(document.getElementById('m')!, 'f', { ctrlKey: true }), h);
		expect(h.palette).toHaveBeenCalledTimes(1);
		document.body.innerHTML = '<main id="m"></main><input id="s" data-page-search />';
		const e = key(document.getElementById('m')!, 'f', { ctrlKey: true });
		expect(globalAccelerator(e, h)).toBe(true);
		expect(e.defaultPrevented).toBe(true);
		expect(document.activeElement?.id).toBe('s');
		expect(h.palette).toHaveBeenCalledTimes(1);
	});

	it('Ctrl+Z presses the visible Undo, and leaves a text field its own undo', () => {
		document.body.innerHTML = '<main id="m"></main><input id="i" /><button id="u" data-undo>Undo</button>';
		const undo = vi.fn();
		document.getElementById('u')!.addEventListener('click', undo);
		const h = host();
		expect(globalAccelerator(key(document.getElementById('i')!, 'z', { ctrlKey: true }), h)).toBe(false);
		expect(globalAccelerator(key(document.getElementById('m')!, 'z', { ctrlKey: true }), h)).toBe(true);
		expect(undo).toHaveBeenCalledTimes(1);
		document.getElementById('u')!.remove();
		expect(globalAccelerator(key(document.getElementById('m')!, 'z', { ctrlKey: true }), h)).toBe(false);
	});
});

describe('isTyping', () => {
	it('treats text inputs, textareas and comboboxes as typing; checkboxes and buttons not', () => {
		document.body.innerHTML =
			'<input id="t" /><input id="c" type="checkbox" /><textarea id="a"></textarea><button id="b">b</button><div id="x" role="combobox"></div>';
		const el = (id: string) => document.getElementById(id);
		expect(isTyping(el('t'))).toBe(true);
		expect(isTyping(el('a'))).toBe(true);
		expect(isTyping(el('x'))).toBe(true);
		expect(isTyping(el('c'))).toBe(false);
		expect(isTyping(el('b'))).toBe(false);
	});
});
