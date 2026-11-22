<!--
	SpendingPace (dashboard "Spending this month", D1 RD5, Q10 chart 5): cumulative spending by
	day this month (solid, --chart-this: blue) against last month (dashed, muted) and, when there is one, the
	average month of the three before (S6, a thin, light solid line, so it can't
	be taken for last month's dashed one). LayerChart. The legend sits above the plot, flush left
	(skill: Charts). Each day is a hover target with every figure.
-->
<script lang="ts">
	import { Chart } from 'layerchart';
	import { scaleLinear } from 'd3-scale';
	import { useMoney } from '$lib/format-context';
	import ChartTip from './ChartTip.svelte';

	let {
		thisMonth,
		lastMonth,
		thisLabel,
		lastLabel,
		average = null,
		averageLabel = '',
		height = 120
	}: {
		/** Cumulative spend, day 1…today. */
		thisMonth: number[];
		/** Cumulative spend, every day of last month. */
		lastMonth: number[];
		thisLabel: string;
		lastLabel: string;
		/** Cumulative spend of the average month, every day of this month (S6); null for none. */
		average?: number[] | null;
		averageLabel?: string;
		height?: number;
	} = $props();
	const m = useMoney();

	const days = $derived(Math.max(lastMonth.length, thisMonth.length, 28));
	const data = $derived(Array.from({ length: days }, (_, i) => ({ day: i + 1 })));
	const top = $derived(Math.max(1, ...thisMonth, ...lastMonth, ...(average ?? [])));

	// The day's figures under the pointer (ChartTip).
	let width = $state(0);
	let hover = $state<{ day: number; x: number } | null>(null);
	const at = (values: number[], day: number) => values[Math.min(day, values.length) - 1] ?? 0;
	const tipRows = $derived.by(() => {
		if (!hover) return [];
		const d = hover.day;
		return [
			{ label: thisLabel, value: d <= thisMonth.length ? m.money(thisMonth[d - 1] ?? 0) : 'Not yet', color: 'var(--chart-this)' },
			{ label: lastLabel, value: m.money(at(lastMonth, d)) },
			...(average ? [{ label: averageLabel, value: m.money(at(average, d)) }] : [])
		];
	});

	function path(values: number[], x: (d: number) => number, y: (v: number) => number): string {
		return values.map((v, i) => `${i ? 'L' : 'M'}${x(i + 1)},${y(v)}`).join('');
	}
</script>

<div class="pace">
	<ul class="legend">
		<li><span class="key this"></span>{thisLabel}</li>
		<li><span class="key last"></span>{lastLabel}</li>
		{#if average}<li><span class="key avg"></span>{averageLabel}</li>{/if}
	</ul>
	<div class="frame" style="height: {height}px" bind:clientWidth={width} role="presentation" onpointerleave={() => (hover = null)}>
		<Chart
			{data}
			x="day"
			xScale={scaleLinear()}
			xDomain={[1, days]}
			y={() => 0}
			yDomain={[0, top]}
			yNice={true}
			padding={{ top: 6, right: 8, bottom: 20, left: 44 }}
			grid={{ class: 'grid' }}
			rule={false}
			highlight={false}
			tooltipContext={false}
			props={{
				yAxis: {
					ticks: 3,
					tickMarks: false,
					format: (t: number) => m.money(t, { compact: true }),
					classes: { tickLabel: 'tick' }
				},
				xAxis: {
					ticks: [1, 10, 20, days],
					tickMarks: false,
					format: (d: number) => String(d),
					classes: { tickLabel: 'tick' }
				}
			}}
		>
			{#snippet marks({ context })}
				{@const x = (d: number) => context.xScale(d) ?? 0}
				{@const y = (v: number) => context.yScale(v) ?? 0}
				{#if average}<path d={path(average, x, y)} class="avg-line" />{/if}
				<path d={path(lastMonth, x, y)} class="last-line" />
				<path d={path(thisMonth, x, y)} class="this-line" />
				{#if hover}<line x1={x(hover.day)} x2={x(hover.day)} y1={0} y2={context.height} class="rule" />{/if}
				{#each data as d (d.day)}
					<rect
						x={x(d.day) - (x(2) - x(1)) / 2}
						y={0}
						width={Math.max(1, x(2) - x(1))}
						height={height}
						class="hit"
						role="presentation"
						onpointerenter={() => (hover = { day: d.day, x: x(d.day) + 44 })}
					/>
				{/each}
			{/snippet}
		</Chart>
		{#if hover}<ChartTip title={`Day ${hover.day}`} x={hover.x} top={4} {width} w={244} rows={tipRows} />{/if}
	</div>
</div>

<style>
	.legend {
		list-style: none;
		display: flex;
		gap: 16px;
		margin: 0 0 4px;
		padding: 0;
		font-size: 12px;
		line-height: 16px;
		color: var(--text-muted);
	}
	.legend li {
		display: flex;
		align-items: center;
		gap: 6px;
	}
	.key {
		display: inline-block;
		width: 12px;
		height: 0;
	}
	.key.this {
		border-top: 2px solid var(--chart-this);
	}
	.key.last {
		border-top: 2px dashed var(--text-muted);
	}
	.key.avg {
		border-top: 1.5px solid var(--text-muted);
		opacity: 0.55;
	}
	:global(.pace .grid) {
		stroke: var(--divider);
		stroke-width: 1;
	}
	:global(.pace .tick) {
		font-size: 12px;
		fill: var(--text-muted);
	}
	.this-line {
		fill: none;
		stroke: var(--chart-this);
		stroke-width: 2;
		stroke-linejoin: round;
	}
	.last-line {
		fill: none;
		stroke: var(--text-muted);
		stroke-width: 1.5;
		stroke-dasharray: 4 3;
	}
	.avg-line {
		fill: none;
		stroke: var(--text-muted);
		stroke-width: 1.25;
		stroke-linejoin: round;
		opacity: 0.55;
	}
	.frame {
		position: relative;
	}
	.rule {
		stroke: var(--text-muted);
		stroke-dasharray: 2 2;
	}
	.hit {
		fill: transparent;
	}
</style>
