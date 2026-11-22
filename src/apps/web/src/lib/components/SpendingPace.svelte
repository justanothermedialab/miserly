<!-- Lazy wrapper: the chart ships as its own async chunk, off the page's hydration path (as the
     other charts; the 299 KB floor lesson). -->
<!-- The pending branch holds the chart's rendered height (server-rendered), so content below
     doesn't jump when the chunk arrives (HUNT §6). -->
<script lang="ts">
	let props: {
		thisMonth: number[];
		lastMonth: number[];
		thisLabel: string;
		lastLabel: string;
		average?: number[] | null;
		averageLabel?: string;
		height?: number;
	} = $props();
	let _c: Promise<typeof import('./charts/SpendingPaceLayer.svelte')> | undefined;
	const load = () => (_c ??= import('./charts/SpendingPaceLayer.svelte'));
</script>

{#await load()}
	<div class="chart-placeholder" aria-hidden="true" style="height: {(props.height ?? 120) + 20}px"></div>
{:then { default: Chart }}
	<Chart {...props} />
{/await}
