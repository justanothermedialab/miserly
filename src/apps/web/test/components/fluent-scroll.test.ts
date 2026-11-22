import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent } from '@testing-library/svelte';
import { fluentScroll } from '$lib/fluent-scroll';

// WinUI-style overlay scrollbar. jsdom has no layout, so the pane's geometry is stubbed.
type Destroyable = { destroy?: () => void } | void;

function pane(scrollHeight: number) {
	const parent = document.createElement('div');
	const node = document.createElement('div');
	parent.append(node);
	document.body.append(parent);
	let top = 0;
	Object.defineProperties(node, {
		scrollHeight: { get: () => scrollHeight },
		clientHeight: { get: () => 500 },
		clientWidth: { get: () => 800, configurable: true },
		scrollTop: { get: () => top, set: (v: number) => (top = Math.max(0, Math.min(v, scrollHeight - 500))) }
	});
	node.scrollBy = ((o: ScrollToOptions) => (node.scrollTop += o.top ?? 0)) as typeof node.scrollBy;
	node.getBoundingClientRect = () => ({ left: 0, right: 800, top: 0, bottom: 500, width: 800, height: 500 }) as DOMRect;
	return { parent, node, top: () => top };
}
const bar = () => document.querySelector<HTMLElement>('.fluent-scrollbar');

let handle: Destroyable;
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
	(handle as { destroy?: () => void })?.destroy?.();
	document.body.innerHTML = '';
	delete (window as unknown as { miserlyDesktop?: unknown }).miserlyDesktop;
	vi.useRealTimers();
});

describe('fluentScroll', () => {
	it('shows the thin indicator on pointer move and hides it 4s after the last move', async () => {
		const { node } = pane(2000);
		handle = fluentScroll(node);
		expect(node.classList.contains('fluent-scroll')).toBe(true);
		expect(bar()!.dataset.state).toBe('hidden');
		await fireEvent.pointerMove(node, { clientX: 300, pointerType: 'mouse' });
		expect(bar()!.dataset.state).toBe('indicator');
		vi.advanceTimersByTime(3900);
		expect(bar()!.dataset.state).toBe('indicator');
		vi.advanceTimersByTime(200);
		expect(bar()!.dataset.state).toBe('hidden');
	});

	it('widens into the full bar at the right edge and back to the indicator off it', async () => {
		const { node } = pane(2000);
		handle = fluentScroll(node);
		await fireEvent.pointerMove(node, { clientX: 795, pointerType: 'mouse' });
		expect(bar()!.dataset.state).toBe('expanded');
		await fireEvent.pointerEnter(bar()!);
		await fireEvent.pointerLeave(bar()!);
		expect(bar()!.dataset.state).toBe('indicator');
	});

	it('scrolling shows the indicator; arrows and thumb drag scroll the pane', async () => {
		const { node, top } = pane(2000);
		handle = fluentScroll(node);
		await fireEvent.scroll(node);
		expect(bar()!.dataset.state).toBe('indicator');
		await fireEvent.pointerDown(document.querySelector('.fs-down')!);
		expect(top()).toBe(48);
		const track = document.querySelector<HTMLElement>('.fs-track')!;
		const thumb = document.querySelector<HTMLElement>('.fs-thumb')!;
		Object.defineProperty(track, 'clientHeight', { get: () => 472 });
		Object.defineProperty(thumb, 'offsetHeight', { get: () => 118 });
		await fireEvent.pointerDown(thumb, { clientY: 100 });
		await fireEvent.pointerMove(thumb, { clientY: 154 }); // 54px of 354px travel = 1500 * 54/354
		expect(Math.round(top())).toBe(Math.round(48 + (54 * 1500) / 354));
		await fireEvent.pointerUp(thumb);
	});

	it('stays hidden when there is nothing to scroll', async () => {
		const { node } = pane(500);
		handle = fluentScroll(node);
		await fireEvent.pointerMove(node, { clientX: 300, pointerType: 'mouse' });
		expect(bar()!.dataset.state).toBe('hidden');
	});

	it('hides at once and re-places when the pane changes width without a window resize', async () => {
		const callbacks: ResizeObserverCallback[] = [];
		vi.stubGlobal(
			'ResizeObserver',
			class {
				constructor(cb: ResizeObserverCallback) {
					callbacks.push(cb);
				}
				observe() {}
				disconnect() {}
			}
		);
		const { node, parent } = pane(2000);
		parent.getBoundingClientRect = () => ({ left: 0, top: 0 }) as DOMRect;
		let width = 800;
		let left = 0;
		Object.defineProperty(node, 'clientWidth', { get: () => width });
		node.getBoundingClientRect = () => ({ left, right: left + width, top: 0, bottom: 500, width, height: 500 }) as DOMRect;
		handle = fluentScroll(node);
		const fire = () => callbacks.forEach((cb) => cb([], {} as ResizeObserver));
		fire(); // first observation records the size
		await fireEvent.pointerMove(node, { clientX: 300, pointerType: 'mouse' });
		expect(bar()!.dataset.state).toBe('indicator');
		expect(bar()!.style.left).toBe('784px');

		// The pane collapses: the content pane widens by 232px and its left edge moves.
		width = 1032;
		left = -232;
		fire();
		expect(bar()!.dataset.state).toBe('hidden');
		expect(bar()!.dataset.instant).toBe('');
		expect(bar()!.style.left).toBe(`${-232 + 1032 - 16}px`);
		vi.unstubAllGlobals();
	});

	it('leaves the native bar alone when Windows "Always show scrollbars" is on', () => {
		(window as unknown as { miserlyDesktop: unknown }).miserlyDesktop = { alwaysShowScrollbars: true };
		const { node } = pane(2000);
		handle = fluentScroll(node);
		expect(node.classList.contains('fluent-scroll')).toBe(false);
		expect(bar()).toBeNull();
	});
});
