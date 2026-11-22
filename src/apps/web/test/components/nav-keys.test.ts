import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { navKeys } from '$lib/nav-keys';

// Down and Space on a focused pane item scrolled the pane (browser defaults), so on a
// short window the item slid under the pane's header. NavigationView moves focus and invokes.
let list: HTMLElement;
let handle: { destroy: () => void };
const link = (href: string) => list.querySelector<HTMLAnchorElement>(`a[href="${href}"]`)!;
const section = () => list.querySelector<HTMLButtonElement>('button[data-section-toggle]')!;
const press = (el: HTMLElement, key: string, init: KeyboardEventInit = {}) => {
	const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
	el.dispatchEvent(e);
	return e;
};

beforeEach(() => {
	document.body.innerHTML = '<div id="list"><a href="/">Dashboard</a><a href="/inbox">To categorize</a><button type="button">Group</button><button type="button" data-section-toggle aria-expanded="true">Bank accounts</button><a href="/reports">Reports</a></div>';
	list = document.getElementById('list')!;
	handle = navKeys(list);
});
afterEach(() => {
	handle.destroy();
	document.body.innerHTML = '';
});

describe('navKeys', () => {
	it('moves focus to the next and previous item instead of scrolling', () => {
		link('/inbox').focus();
		const down = press(link('/inbox'), 'ArrowDown');
		expect(down.defaultPrevented).toBe(true);
		expect(document.activeElement).toBe(section());
		press(section(), 'ArrowDown');
		expect(document.activeElement).toBe(link('/reports'));
		press(link('/reports'), 'ArrowUp');
		expect(document.activeElement).toBe(section());
	});

	it('stays put at the ends', () => {
		link('/').focus();
		press(link('/'), 'ArrowUp');
		expect(document.activeElement).toBe(link('/'));
	});

	it('Space opens the focused item instead of scrolling', () => {
		const click = vi.fn((e: Event) => e.preventDefault());
		link('/inbox').addEventListener('click', click);
		const e = press(link('/inbox'), ' ');
		expect(e.defaultPrevented).toBe(true);
		expect(click).toHaveBeenCalledOnce();
	});

	it('Right unfolds and Left folds a section, and only when it changes something (P1)', () => {
		const click = vi.fn(() => section().setAttribute('aria-expanded', String(section().getAttribute('aria-expanded') !== 'true')));
		section().addEventListener('click', click);
		section().focus();
		press(section(), 'ArrowRight');
		expect(click).not.toHaveBeenCalled();
		expect(press(section(), 'ArrowLeft').defaultPrevented).toBe(true);
		expect(click).toHaveBeenCalledOnce();
		expect(section().getAttribute('aria-expanded')).toBe('false');
		press(section(), 'ArrowRight');
		expect(click).toHaveBeenCalledTimes(2);
	});

	it('leaves other controls and modified keys alone', () => {
		const btn = list.querySelector<HTMLButtonElement>('button:not([data-section-toggle])')!;
		btn.focus();
		expect(press(btn, 'ArrowDown').defaultPrevented).toBe(false);
		link('/inbox').focus();
		expect(press(link('/inbox'), 'ArrowDown', { shiftKey: true }).defaultPrevented).toBe(false);
	});
});
