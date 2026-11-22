<!--
	IncomeExpenseBars (R3): bar heights scale to the max of income/expense
	across ALL bins in the window (so months stay comparable to each other), a
	per-month net indicator dot, and the single-month in/out/net summary line.
	Uses LayerChart's Chart (band xScale) + Axis (via `props.xAxis`) for the
	month labels; the grouped income/expense bars and net dots are positioned
	via the chart's own xScale/yScale using the same BIN_W/BAR_W/BAR_GAP
	geometry. A value axis on the left with gridlines (the bars couldn't be
	read), and a month's income, spending and net under the pointer (ChartTip). With
	`hrefOf`, a bar opens that month's income or spending transactions (R3 RD10).
-->
<script lang="ts">
	import { Chart } from 'layerchart';
	import { scaleBand } from 'd3-scale';
	import { useMoney } from '$lib/format-context';
	import { toneClass } from '$lib/format';
	import ChartTip from './ChartTip.svelte';
	import { goto } from '$app/navigation';

	interface MonthBin {
		readonly month: string; // 'YYYY-MM'
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
	}: {
		cashflow: Cashflow;
		/** Where a month's income or spending bar leads (its transactions). */
		hrefOf?: (month: string, flow: 'income' | 'spending') => string;
	} = $props();
	const m = useMoney();

	const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
	/** 'YYYY-MM' -> 'Apr 26'. */
	function monthShort(ym: string): string {
		const [y, mo] = ym.split('-');
		return `${MONTH_ABBR[Number(mo) - 1]} ${y!.slice(2)}`;
	}

	// ── geometry (SVG user units == px) ────────────────────────────────────
	const BIN_W = 56;
	const BAR_W = 16;
	const BAR_GAP = 4;
	const CHART_H = 150;
	const PAD_TOP = 10;
	const PAD_BOTTOM = 26;
	const SVG_H = CHART_H + PAD_TOP + PAD_BOTTOM;

	const maxVal = $derived(
		Math.max(1, ...cashflow.bins.flatMap((b) => [b.incomePaise, b.expensePaise]))
	);
	// Fill the card (DL-12: no horizontal scrollbar at 1024); only a very long range
	// (more bins than fit at MIN_BIN each) scrolls. 12 months fit a half-width card at
	// 1232 px (418 px): bars narrow and month labels thin out instead of scrolling. The box width is floored: `clientWidth`
	// rounds, and at 150% scaling a box of 653.67px read as 654 made the chart 1px too wide,
	// so the card always showed a sideways scrollbar.
	let box = $state<DOMRectReadOnly | undefined>();
	const boxW = $derived(Math.floor(box?.width ?? 0));
	const MIN_BIN = 24;
	const LABEL_W = 44; // room for "Apr 26" at 12 px
	const AXIS_W = 52; // the value axis: room for "₹1.2Cr" at 12 px
	const minW = $derived(cashflow.bins.length * MIN_BIN + AXIS_W);
	const svgWidth = $derived(Math.max(minW, boxW > 0 ? boxW : cashflow.bins.length * BIN_W, BIN_W));
	const binW = $derived((svgWidth - AXIS_W) / Math.max(1, cashflow.bins.length));
	const barW = $derived(Math.max(4, Math.min(BAR_W, (binW - BAR_GAP - 6) / 2)));
	// Label every month when there's room, else every 2nd or 3rd.
	const labelStep = $derived(binW >= LABEL_W ? 1 : Math.ceil(LABEL_W / binW));
	const binIndex = $derived(new Map(cashflow.bins.map((b, i) => [b.month, i])));

	const MONTH_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
	let hover = $state<{ i: number; x: number } | null>(null);
	const hovered = $derived(hover ? cashflow.bins[hover.i] : undefined);
</script>

<div class="bars" role="presentation" onpointerleave={() => (hover = null)}>
	<!-- Legend above the plot, flush left (skill Charts; AUDIT-S4 S3). -->
	<ul class="legend">
		<li><span class="swatch income-bar"></span> Income</li>
		<li><span class="swatch expense-bar"></span> Spending</li>
	</ul>
	{#if cashflow.bins.length === 1}
		{@const b = cashflow.bins[0]!}
		<p class="single-summary">
			In <strong class="income">{m.money(b.incomePaise)}</strong>, out
			<strong class="expense">{m.money(b.expensePaise)}</strong>, net
			<strong class:income={b.netPaise >= 0} class:expense={b.netPaise < 0}>{m.signedMoney(b.netPaise)}</strong>
		</p>
	{/if}

	<div class="chart-scroll" class:scrolls={boxW > 0 && minW > boxW} bind:contentRect={box}>
		<Chart
			data={cashflow.bins}
			x="month"
			xScale={scaleBand<string>().paddingInner(0).paddingOuter(0)}
			xDomain={cashflow.bins.map((b) => b.month)}
			y="incomePaise"
			yDomain={[0, maxVal]}
			yBaseline={0}
			width={svgWidth}
			height={SVG_H}
			padding={{ top: PAD_TOP, bottom: PAD_BOTTOM, left: AXIS_W, right: 0 }}
			grid={{ class: 'grid' }}
			rule={false}
			highlight={false}
			tooltipContext={false}
			props={{
				yAxis: {
					ticks: 3,
					tickMarks: false,
					format: (t: number) => m.money(t, { compact: true }),
					classes: { tickLabel: 'month-label' }
				},
				xAxis: {
					tickMarks: false,
					format: (d: string) => ((binIndex.get(d) ?? 0) % labelStep === 0 ? monthShort(d) : ''),
					classes: { tickLabel: 'month-label' }
				}
			}}
		>
			{#snippet marks({ context })}
				<line x1="0" y1={context.yScale(0)} x2={context.width} y2={context.yScale(0)} class="baseline" />
				{#each cashflow.bins as b, i (b.month)}
					{@const bandX = context.xScale(b.month) ?? 0}
					{@const bw = context.xScale.bandwidth?.() ?? BIN_W}
					{@const incomeX = bandX + (bw - (barW * 2 + BAR_GAP)) / 2}
					{@const expenseX = incomeX + barW + BAR_GAP}
					<rect
						x={bandX}
						y={0}
						width={bw}
						height={CHART_H}
						class="hit {hover?.i === i ? 'on' : ''}"
						role="presentation"
						onpointerenter={() => (hover = { i, x: bandX + bw / 2 + AXIS_W })}
					/>
					<rect
						x={incomeX}
						y={context.yScale(b.incomePaise)}
						width={barW}
						height={(context.yScale(0) ?? 0) - (context.yScale(b.incomePaise) ?? 0)}
						rx="2.5"
						class="income-bar"
						class:link={hrefOf && b.incomePaise !== 0}
						pointer-events={hrefOf && b.incomePaise !== 0 ? 'auto' : 'none'}
						role={hrefOf && b.incomePaise !== 0 ? 'link' : 'presentation'}
						onpointerenter={() => (hover = { i, x: bandX + bw / 2 + AXIS_W })}
						onclick={() => hrefOf && b.incomePaise !== 0 && goto(hrefOf(b.month, 'income'))}
					>
						<title>{monthShort(b.month)} income: {m.money(b.incomePaise, { compact: m.compact })}</title>
					</rect>
					<rect
						x={expenseX}
						y={context.yScale(b.expensePaise)}
						width={barW}
						height={(context.yScale(0) ?? 0) - (context.yScale(b.expensePaise) ?? 0)}
						rx="2.5"
						class="expense-bar"
						class:link={hrefOf && b.expensePaise !== 0}
						pointer-events={hrefOf && b.expensePaise !== 0 ? 'auto' : 'none'}
						role={hrefOf && b.expensePaise !== 0 ? 'link' : 'presentation'}
						onpointerenter={() => (hover = { i, x: bandX + bw / 2 + AXIS_W })}
						onclick={() => hrefOf && b.expensePaise !== 0 && goto(hrefOf(b.month, 'spending'))}
					>
						<title>{monthShort(b.month)} spending: {m.money(b.expensePaise, { compact: m.compact })}</title>
					</rect>
				{/each}
			{/snippet}
		</Chart>
	</div>
	{#if hovered && hover}
		<ChartTip
			title={`${MONTH_LONG[Number(hovered.month.slice(5, 7)) - 1]} ${hovered.month.slice(0, 4)}`}
			x={hover.x}
			top={32}
			width={boxW}
			rows={[
				{ label: 'Income', value: m.money(hovered.incomePaise), color: 'var(--pos)' },
				{ label: 'Spending', value: m.money(hovered.expensePaise), color: 'var(--neg)' },
				{ label: 'Net', value: m.signedMoney(hovered.netPaise), tone: toneClass(hovered.netPaise), strong: true }
			]}
		/>
	{/if}

</div>

<style>
	.link {
		cursor: pointer;
	}
	.bars {
		position: relative;
	}
	.chart-scroll {
		overflow-x: hidden;
	}
	.hit {
		fill: transparent;
	}
	.hit.on {
		fill: var(--control);
	}
	:global(.bars .grid) {
		stroke: var(--divider);
		stroke-width: 1;
	}
	.chart-scroll.scrolls {
		overflow-x: auto;
	}
	.baseline {
		stroke: rgba(128, 128, 128, 0.35);
		stroke-width: 1;
	}
	/* semantic finance tokens (theme-aware: track the toggle AND the OS pref).
	   `fill` colors the SVG bars/dots; `background` colors the legend swatch spans. */
	.income-bar {
		fill: var(--pos);
		background: var(--pos);
	}
	.expense-bar {
		fill: var(--neg);
		background: var(--neg);
	}
	:global(.bars .month-label) {
		font-size: 12px;
		fill: currentColor;
		opacity: 0.7;
	}
	.legend {
		list-style: none;
		display: flex;
		gap: 1rem;
		flex-wrap: wrap;
		margin: 0 0 8px;
		padding: 0;
		font-size: 12px;
		color: var(--text-muted);
	}
	.legend li {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
	}
	.swatch {
		display: inline-block;
		width: 0.65rem;
		height: 0.65rem;
		border-radius: var(--radius-control);
	}
	.single-summary {
		margin: 0 0 0.6rem;
		font-size: 14px;
	}
	.single-summary strong {
		font-variant-numeric: tabular-nums;
	}
	.single-summary strong.income {
		color: var(--pos);
	}
	.single-summary strong.expense {
		color: var(--neg);
	}
</style>
