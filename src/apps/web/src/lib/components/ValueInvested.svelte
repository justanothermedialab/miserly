<!-- Lazy wrapper: the chart ships as its own async chunk, off the page's hydration path (as the
     other charts; the 299 KB floor lesson). The pending branch holds the chart's height so content
     below doesn't jump when the chunk arrives. -->
<script lang="ts">
	let props: {
		points: { date: string; valuePaise: number; investedPaise: number }[];
		currency?: string;
		height?: number;
	} = $props();
	let _c: Promise<typeof import('./charts/ValueInvestedLayer.svelte')> | undefined;
	const load = () => (_c ??= import('./charts/ValueInvestedLayer.svelte'));
</script>

{#await load()}
	<div class="chart-placeholder" aria-hidden="true" style="height: {(props.height ?? 208) + 20}px"></div>
{:then { default: Chart }}
	<Chart {...props} />
{/await}
