import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { flushSync } from 'svelte';
import Harness from './StatusBarHarness.svelte';

// The close (X) on a status message must close it and keep it closed, even though
// hover/focus pause and resume the auto-dismiss timer around the click.
afterEach(cleanup);

const bar = () => document.querySelector('[data-slot="status-bar"]');
// It folds out (lib/motion): it leaves the DOM when its exit animation ends
// (test/components/setup.ts ends it on the next task).
async function settle() {
	for (let i = 0; i < 2; i++) {
		flushSync();
		if (vi.isFakeTimers()) vi.advanceTimersByTime(1);
		else await new Promise((r) => setTimeout(r, 0));
	}
	flushSync();
}

describe('StatusBar dismiss', () => {
	it('stays closed after X is clicked while hovered (mouseleave after removal)', async () => {
		const { getByRole } = render(Harness);
		const el = bar()!;
		await fireEvent.pointerMove(el, { movementX: 4, movementY: 1 });
		const x = getByRole('button', { name: 'Dismiss' });
		x.focus();
		await fireEvent.click(x);
		await settle();
		expect(bar()).toBeNull();
		// The browser fires focusout / mouseleave as the focused, hovered bar is removed.
		await fireEvent.focusOut(el);
		await fireEvent.pointerLeave(el);
		flushSync();
		await settle();
		expect(bar()).toBeNull();
	});

	it('closes by keyboard (Enter on the focused X) and stays closed', async () => {
		const { getByRole } = render(Harness);
		const el = bar()!;
		const x = getByRole('button', { name: 'Dismiss' });
		x.focus();
		await fireEvent.focusIn(el);
		// A native button turns Enter into a click; jsdom doesn't, so send the click it produces.
		await fireEvent.keyDown(x, { key: 'Enter' });
		await fireEvent.click(x);
		await fireEvent.focusOut(el);
		flushSync();
		await settle();
		expect(bar()).toBeNull();
	});

	it('shows again when a new result arrives', async () => {
		const { getByRole, rerender } = render(Harness, { trigger: { n: 1 } });
		await fireEvent.click(getByRole('button', { name: 'Dismiss' }));
		await settle();
		expect(bar()).toBeNull();
		await rerender({ trigger: { n: 2 } });
		expect(bar()).not.toBeNull();
	});

	it('auto-dismisses when it appears under a resting pointer (hunt H-msg-A)', async () => {
		vi.useFakeTimers();
		render(Harness);
		const el = bar()!;
		// Synthetic move after layout: no movement, so no pause.
		await fireEvent.pointerMove(el, { movementX: 0, movementY: 0 });
		vi.advanceTimersByTime(5100);
		flushSync();
		await settle();
		expect(bar()).toBeNull();
		vi.useRealTimers();
	});

	it('pauses while the pointer really moves over it, resumes on leave', async () => {
		vi.useFakeTimers();
		render(Harness);
		const el = bar()!;
		await fireEvent.pointerMove(el, { movementX: 3, movementY: 0 });
		vi.advanceTimersByTime(8000);
		flushSync();
		expect(bar()).not.toBeNull();
		await fireEvent.pointerLeave(el);
		vi.advanceTimersByTime(5100);
		flushSync();
		await settle();
		expect(bar()).toBeNull();
		vi.useRealTimers();
	});
});
