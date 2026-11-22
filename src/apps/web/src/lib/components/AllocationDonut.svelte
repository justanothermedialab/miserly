<!-- The chart is LAZY-LOADED (dynamic import) so it doesn't ship in the page's synchronous
     hydration bundle; it arrives as its own async chunk, off the critical interactive path. -->
<!-- The pending branch holds the chart's rendered height (server-rendered), so content below
     doesn't jump when the chunk arrives (HUNT §6). -->
<script lang="ts">
	interface Slice {
		readonly key: string;
		readonly amountPaise: number;
	}
	let {
		slices,
		labelOf,
		colorOf,
		hrefOf,
		showBars = false,
		size = 'md'
	}: {
		slices: Slice[];
		labelOf?: (key: string) => string;
		colorOf?: (key: string) => string;
		hrefOf?: (key: string) => string | null;
		showBars?: boolean;
		size?: 'md' | 'sm';
	} = $props();

	// Memoized import: fetched once (a stable promise, so prop changes re-render, never re-fetch).
	let _layer: Promise<typeof import('./charts/AllocationDonutLayer.svelte')> | undefined;
	const layer = () => (_layer ??= import('./charts/AllocationDonutLayer.svelte'));
</script>

{#await layer()}
	<div class="chart-placeholder" aria-hidden="true" style="height: {size === 'sm' ? '6.5rem' : '11rem'}"></div>
{:then { default: Chart }}
	<Chart {slices} {labelOf} {colorOf} {hrefOf} {showBars} {size} />
{/await}
