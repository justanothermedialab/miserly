<!-- Lazy wrapper: the chart ships as its own async chunk, off the page's hydration path. -->
<!-- The pending branch holds the chart's rendered height (server-rendered), so content below
     doesn't jump when the chunk arrives (HUNT §6). -->
<script lang="ts">
	let props: {
		keys: string[];
		labels: string[];
		series: {
			readonly name: string;
			readonly color: string;
			readonly values: readonly number[];
			readonly parts?: readonly { readonly name: string; readonly values: readonly number[] }[];
		}[];
		line?: number[];
		lineName?: string;
		height?: number;
		hrefOf?: (series: number, key: number) => string | null;
	} = $props();
	let _c: Promise<typeof import('./charts/StackedBarsLayer.svelte')> | undefined;
	const load = () => (_c ??= import('./charts/StackedBarsLayer.svelte'));
</script>

{#await load()}
	<div class="chart-placeholder" aria-hidden="true" style="height: {(props.height ?? 220) + 24}px"></div>
{:then { default: Chart }}
	<Chart {...props} />
{/await}
