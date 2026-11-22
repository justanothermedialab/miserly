import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/svelte';

// LayerChart reads prefers-reduced-motion when it loads and measures its box; jsdom has neither.
vi.hoisted(() => {
	window.matchMedia ??= ((query: string) => ({
		matches: false,
		media: query,
		onchange: null,
		addEventListener: () => {},
		removeEventListener: () => {},
		addListener: () => {},
		removeListener: () => {},
		dispatchEvent: () => false
	})) as unknown as typeof window.matchMedia;
	globalThis.ResizeObserver ??= class {
		observe() {}
		unobserve() {}
		disconnect() {}
	} as unknown as typeof ResizeObserver;
});
import NetWorthLineLayer from '$lib/components/charts/NetWorthLineLayer.svelte';

afterEach(cleanup);

// Found in testing: the dashboard's net-worth axis read "1 Dec" beside "May '26" when the ledger
// starts mid-month. One format on the axis, as U2 gave the section chart; the day stays in the card.
describe('NetWorthLineLayer axis', () => {
	const points = [
		{ date: '2025-12-01', netWorthPaise: 1_00_000_00 },
		{ date: '2025-12-31', netWorthPaise: 1_10_000_00 },
		{ date: '2026-05-31', netWorthPaise: 1_20_000_00 },
		{ date: '2026-11-19', netWorthPaise: 1_30_000_00 }
	];

	it('labels every tick month and year, the mid-month start too', () => {
		const { container } = render(NetWorthLineLayer, { points });
		const ticks = [...container.querySelectorAll('.tick-x')].map((t) => t.textContent?.trim());
		expect(ticks.length).toBeGreaterThan(0);
		expect(ticks[0]).toBe("Dec '25");
		for (const t of ticks) expect(t).toMatch(/^[A-Z][a-z]{2} '\d{2}$/u);
	});
});
