<!--
	ValueInvested (chart I1): what holdings were worth (solid line over the
	area, as the Dashboard draws net worth) against the money put in (dashed, a step: it moves only
	when money goes in or out). Hover a month for Value, Invested and Gain (the figure under
	the pointer). Straight segments between month ends, no smoothing (D3 RD5).

	The PAGE is responsible for not rendering this component with < 2 points.
-->
<script lang="ts">
	import { Chart, Area, Spline } from 'layerchart';
	import { scalePoint } from 'd3-scale';
	import { curveLinear, curveStepAfter } from 'd3-shape';
	import { useMoney } from '$lib/format-context';
	import { toneClass } from '$lib/format';
	import ChartTip from './ChartTip.svelte';

	interface Point {
		readonly date: string;
		readonly valuePaise: number;
		readonly investedPaise: number;
	}

	let { points, currency, height = 208 }: { points: Point[]; currency?: string; height?: number } = $props();
	const m = useMoney();

	const PAD = { top: 14, right: 8, bottom: 22, left: 44 };
	const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
	// Points are month ends and today; the first may be the day tracking began, labelled by its day.
	const isStart = (iso: string) => {
		const [y, m, d] = iso.split('-').map(Number);
		return iso === points[0]?.date && iso !== points[points.length - 1]?.date && d !== new Date(y!, m!, 0).getDate();
	};
	const mon = (iso: string) => MONTHS[Number(iso.slice(5, 7)) - 1] ?? '';
	// One format on the axis (U2): the start day is in the hover card, not the tick ("1 Oct" beside "Oct '24").
	const monthLabel = (iso: string) => `${mon(iso)} '${iso.slice(2, 4)}`;
	const monthLong = (iso: string) => (isStart(iso) ? `${Number(iso.slice(8))} ${mon(iso)} ${iso.slice(0, 4)}` : `${mon(iso)} ${iso.slice(0, 4)}`);

	const yDomain = $derived.by((): [number, number] => {
		const vals = points.flatMap((p) => [p.valuePaise, p.investedPaise]);
		const min = Math.min(0, ...vals);
		const max = Math.max(0, ...vals);
		return min === max ? [min - 1, max + 1] : [min, max];
	});
	const xTicks = $derived.by(() => {
		if (points.length <= 5) return points.map((p) => p.date);
		const idx = new Set([0, Math.floor((points.length - 1) / 2), points.length - 1]);
		return points.filter((_, i) => idx.has(i)).map((p) => p.date);
	});
	const last = $derived(points[points.length - 1]);

	let width = $state(0);
	let hover = $state<{ i: number; x: number } | null>(null);
	const hovered = $derived(hover ? points[hover.i] : undefined);
	const money = (paise: number) => m.money(paise, { currency });
</script>

<div class="vi" role="presentation" onpointerleave={() => (hover = null)}>
	<ul class="legend">
		<li><span class="key value"></span>Value</li>
		<li><span class="key invested"></span>Invested</li>
	</ul>
	<div class="frame" style="height: {height}px" bind:clientWidth={width}>
		<Chart
			data={points}
			x="date"
			xScale={scalePoint<string>().padding(0.5)}
			xDomain={points.map((p) => p.date)}
			y="valuePaise"
			{yDomain}
			yNice={true}
			yBaseline={0}
			padding={PAD}
			grid={{ class: 'grid' }}
			rule={false}
			highlight={false}
			tooltipContext={false}
			props={{
				yAxis: {
					ticks: 4,
					tickMarks: false,
					// Axis ticks are always compact (the long form overflows the margin).
					format: (t: number) => m.money(t, { compact: true, currency }),
					classes: { tickLabel: 'tick' }
				},
				xAxis: {
					ticks: xTicks,
					tickMarks: false,
					format: (d: string) => monthLabel(d),
					classes: { tickLabel: 'tick' }
				}
			}}
		>
			{#snippet marks({ context })}
				{@const x = (d: string) => context.xScale(d) ?? 0}
				{@const y = (v: number) => context.yScale(v) ?? 0}
				{@const band = points.length > 1 ? x(points[1]!.date) - x(points[0]!.date) : 40}
				<Area y0={() => 0} curve={curveLinear} fill="var(--chart-area)" stroke="none" />
				<Spline y="investedPaise" curve={curveStepAfter} class="invested-line" />
				<Spline y="valuePaise" curve={curveLinear} stroke="currentColor" class="value-line" />
				{#if hovered && hover}
					<line x1={x(hovered.date)} x2={x(hovered.date)} y1={0} y2={y(yDomain[0])} class="rule" />
					<circle cx={x(hovered.date)} cy={y(hovered.investedPaise)} r="3.5" class="dot-invested" />
					<circle cx={x(hovered.date)} cy={y(hovered.valuePaise)} r="4" class="dot-value" />
				{/if}
				{#if last}
					<circle cx={x(last.date)} cy={y(last.valuePaise)} r="4" class="end-ring" />
					<circle cx={x(last.date)} cy={y(last.valuePaise)} r="3" class="end-dot" />
					<text x={x(last.date) - 4} y={y(last.valuePaise) - 8} text-anchor="end" class="end-label"
						>{m.money(last.valuePaise, { compact: true, currency })}</text
					>
				{/if}
				{#each points as p, i (p.date)}
					<rect
						x={x(p.date) - band / 2}
						y={0}
						width={Math.max(1, band)}
						height={height}
						class="hit"
						role="presentation"
						onpointerenter={() => (hover = { i, x: x(p.date) + PAD.left })}
					/>
				{/each}
			{/snippet}
		</Chart>
		{#if hovered && hover}
			{@const gain = hovered.valuePaise - hovered.investedPaise}
			<ChartTip
				title={monthLong(hovered.date)}
				x={hover.x}
				top={PAD.top + 4}
				{width}
				rows={[
					{ label: 'Value', value: money(hovered.valuePaise) },
					{ label: 'Invested', value: money(hovered.investedPaise) },
					{ label: 'Gain', value: m.signedMoney(gain, { currency }), tone: toneClass(gain) }
				]}
			/>
		{/if}
	</div>
</div>

<style>
	.vi {
		width: 100%;
	}
	.frame {
		position: relative;
		width: 100%;
	}
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
		width: 16px;
		height: 0;
	}
	.key.value {
		border-top: 2px solid var(--text);
	}
	.key.invested {
		border-top: 1.5px dashed var(--text-muted);
	}
	:global(.vi .grid) {
		stroke: rgba(128, 128, 128, 0.2);
		stroke-width: 1;
	}
	:global(.vi .tick) {
		font-size: 12px;
		fill: var(--text-muted);
	}
	:global(.vi .value-line) {
		fill: none;
		stroke-width: 2;
		stroke-linejoin: round;
		stroke-linecap: round;
	}
	:global(.vi .invested-line) {
		fill: none;
		stroke: var(--text-muted);
		stroke-width: 1.5;
		stroke-dasharray: 5 3;
	}
	.rule {
		stroke: var(--text-muted);
		stroke-dasharray: 2 2;
	}
	.dot-value {
		fill: currentColor;
		stroke: var(--surface);
		stroke-width: 2;
	}
	.dot-invested {
		fill: var(--surface);
		stroke: var(--text-muted);
		stroke-width: 2;
	}
	.hit {
		fill: transparent;
	}
	.end-ring {
		fill: var(--surface, #fcfcfb);
	}
	.end-dot {
		fill: currentColor;
	}
	.end-label {
		font-size: 12px;
		font-weight: 600;
		fill: currentColor;
	}
</style>
