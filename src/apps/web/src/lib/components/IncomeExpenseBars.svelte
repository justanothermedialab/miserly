<!-- The chart is LAZY-LOADED (dynamic import) so it doesn't ship in the page's synchronous
     hydration bundle; it arrives as its own async chunk, off the critical interactive path. -->
<!-- The pending branch holds the chart's rendered height (server-rendered), so content below
     doesn't jump when the chunk arrives (HUNT §6). -->
<script lang="ts">
	interface MonthBin {
		readonly month: string;
		readonly incomePaise: number;
		readonly expensePaise: number;
		readonly netPaise: number;
	}
	interface Cashflow {
		readonly baseCurrency: string;
		readonly bins: MonthBin[];
		readonly totalIncomePaise: number;
		readonly totalExpensePaise: number;
		readonly netPaise: number;
		readonly rateNeededCurrencies: string[];
	}
	let {
		cashflow,
		hrefOf
	}: { cashflow: Cashflow; hrefOf?: (month: string, flow: 'income' | 'spending') => string } = $props();

	let _layer: Promise<typeof import('./charts/IncomeExpenseBarsLayer.svelte')> | undefined;
	const layer = () => (_layer ??= import('./charts/IncomeExpenseBarsLayer.svelte'));
</script>

{#await layer()}
	<div class="chart-placeholder" aria-hidden="true" style="height: 211px"></div>
{:then { default: Chart }}
	<Chart {cashflow} {hrefOf} />
{/await}
