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
import AllocationDonutLayer from '$lib/components/charts/AllocationDonutLayer.svelte';

afterEach(cleanup);

// C9: a bank account below zero was dropped from the ring and the legend without a word, and the
// centre read the drawn slices, the overdraft's size above Assets.
describe('AllocationDonutLayer with a slice below zero', () => {
	const slices = [
		{ key: 'property', amountPaise: 2_00_00_000_00 },
		{ key: 'mutualFunds', amountPaise: 3_00_000_00 },
		{ key: 'bank', amountPaise: -20_000_00 }
	];
	const labels: Record<string, string> = { property: 'Property', mutualFunds: 'Mutual funds', bank: 'Bank accounts' };

	it('lists it under the legend as "not drawn" and the centre reads Assets (fixed 2026-11-06)', () => {
		const { container } = render(AllocationDonutLayer, { slices, labelOf: (k: string) => labels[k] ?? k });
		const rows = [...container.querySelectorAll('.legend li')].map((li) =>
			[...li.querySelectorAll('.label, .pct')].map((e) => e.textContent?.trim())
		);
		// Shares of the drawn ring (the fund, under 2.5 %, rolls into Other, D2 RD4); the bank last.
		expect(rows).toEqual([
			['Property', '98.5%'],
			['Other', '1.5%'],
			['Bank accounts', 'Not drawn']
		]);
		// The centre's full figure (its hover title) is the sum of every slice: Assets.
		const assets = 2_00_00_000_00 + 3_00_000_00 - 20_000_00;
		expect(container.querySelector('.center-total title')?.textContent).toBe('₹2,02,80,000.00');
		expect(assets).toBe(2_02_80_000_00);
	});
});
