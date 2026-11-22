<!-- The chart is LAZY-LOADED (dynamic import) so it doesn't ship in the page's synchronous
     hydration bundle; it arrives as its own async chunk, off the critical interactive path. -->
<!-- The pending branch holds the chart's rendered height (server-rendered), so content below
     doesn't jump when the chunk arrives (HUNT §6). -->
<script lang="ts">
	interface Point {
		readonly date: string;
		readonly netWorthPaise: number;
		readonly assetsPaise?: number;
		readonly liabilitiesPaise?: number;
	}
	let { points }: { points: Point[] } = $props();

	let _layer: Promise<typeof import('./charts/NetWorthLineLayer.svelte')> | undefined;
	const layer = () => (_layer ??= import('./charts/NetWorthLineLayer.svelte'));
</script>

{#await layer()}
	<div class="chart-placeholder" aria-hidden="true" style="height: 235px"></div>
{:then { default: Chart }}
	<Chart {points} />
{/await}
