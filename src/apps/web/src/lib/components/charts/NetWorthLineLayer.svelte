<!--
	NetWorthLine (D3) — LayerChart implementation. Mirrors NetWorthLineD3.svelte:
	straight-line (linear) interpolation over evenly-spaced points (D3 RD5, no
	smoothing that would invent values between recorded marks), the assets/
	liabilities composition toggle (fixed diverging blue/red pair), sparse
	x-tick labels (first/mid/last), and the end-point value callout. Uses
	LayerChart's Chart (point xScale) + Area/Spline for the drawn paths and
	Axis (via Chart's `props.xAxis`/`props.yAxis`) for ticks; the per-point hit
	targets and end-point label are plain SVG positioned via the chart's own
	xScale/yScale so they land exactly on the drawn lines.

	The PAGE is responsible for not rendering this component with < 2 points.
-->
<script lang="ts">
	import { Chart, Area, Spline } from 'layerchart';
	import { scalePoint } from 'd3-scale';
	import { curveLinear } from 'd3-shape';
	import { useMoney } from '$lib/format-context';
	import ChartTip from './ChartTip.svelte';

	interface Point {
		readonly date: string;
		readonly netWorthPaise: number;
		readonly assetsPaise?: number;
		readonly liabilitiesPaise?: number;
	}

	let { points }: { points: Point[] } = $props();
	const m = useMoney();

	const hasComposition = $derived(
		points.every((p) => p.assetsPaise !== undefined && p.liabilitiesPaise !== undefined)
	);
	let showComposition = $state(false);

	const yDomain = $derived.by((): [number, number] => {
		const vals =
			showComposition && hasComposition
				? points.flatMap((p) => [p.netWorthPaise, p.assetsPaise!, p.liabilitiesPaise!])
				: points.map((p) => p.netWorthPaise);
		let min = Math.min(0, ...vals);
		let max = Math.max(0, ...vals);
		if (min === max) {
			min -= 1;
			max += 1;
		}
		return [min, max];
	});

	// Sparse x labels — first, mid, last — so months don't collide when ALL
	// spans years of data.
	const xTickPoints = $derived.by(() => {
		if (points.length <= 5) return points;
		const idxs = new Set([0, Math.floor((points.length - 1) / 2), points.length - 1]);
		return points.filter((_, i) => idxs.has(i));
	});

	// Points are month ends and today; the first may be the ledger's first day, labelled by its day.
	function isStart(iso: string): boolean {
		const [y, m, d] = iso.split('-').map(Number);
		return iso === points[0]?.date && iso !== points[points.length - 1]?.date && d !== new Date(y!, m!, 0).getDate();
	}
	// One format on the axis (as U2 on the section chart): the start day is in the hover card, not
	// the tick ("1 Dec" beside "May '26").
	function monthLabel(iso: string): string {
		const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
		const [y4, mo] = iso.split('-');
		return `${MONTHS[Number(mo) - 1] ?? ''} '${(y4 ?? '').slice(2)}`;
	}

	const last = $derived(points[points.length - 1]);

	// The figures under the pointer, in one card (ChartTip), as every chart now does.
	const PAD_LEFT = 44;
	let width = $state(0);
	let hover = $state<{ i: number; x: number } | null>(null);
	const hovered = $derived(hover ? points[hover.i] : undefined);
	function monthLong(iso: string): string {
		const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
		const month = `${MONTHS[Number(iso.slice(5, 7)) - 1] ?? ''} ${iso.slice(0, 4)}`;
		return isStart(iso) ? `${Number(iso.slice(8))} ${month}` : month;
	}
</script>

<div class="line-wrap">
	{#if hasComposition}
		<label class="toggle">
			<input type="checkbox" bind:checked={showComposition} /> Show assets and liabilities
		</label>
	{/if}

	{#if showComposition && hasComposition}
		<ul class="legend">
			<li><span class="swatch nw"></span> Net worth</li>
			<li><span class="swatch assets"></span> Assets</li>
			<li><span class="swatch liab"></span> Liabilities</li>
		</ul>
	{/if}

	<div class="chart-frame" bind:clientWidth={width} role="presentation" onpointerleave={() => (hover = null)}>
		<Chart
			data={points}
			x="date"
			xScale={scalePoint<string>().padding(0.5)}
			xDomain={points.map((p) => p.date)}
			y="netWorthPaise"
			yDomain={yDomain}
			yNice={true}
			yBaseline={0}
			padding={{ top: 14, right: 8, bottom: 22, left: PAD_LEFT }}
			grid={{ class: 'grid' }}
			rule={false}
			highlight={false}
			tooltipContext={false}
			props={{
				yAxis: {
					ticks: 4,
					tickMarks: false,
					// Axis ticks are ALWAYS compact (₹5L / -₹10L …) regardless of the
					// user's long/compact preference: the long form (-₹15,00,000.00)
					// overflows the left margin and gets clipped to a garbled, sign-less
					// "5,00,000.00". Compact keeps the sign and stays legible.
					format: (t: number) => m.money(t, { compact: true }),
					classes: { tickLabel: 'tick-y' }
				},
				xAxis: {
					ticks: xTickPoints.map((p) => p.date),
					tickMarks: false,
					format: (d: string) => monthLabel(d),
					classes: { tickLabel: 'tick-x' }
				}
			}}
		>
			{#snippet marks({ context })}
				{#if !showComposition}
					<Area y0={() => 0} curve={curveLinear} fill="var(--chart-area)" stroke="none" />
				{/if}
				{#if showComposition && hasComposition}
					<Spline y="assetsPaise" curve={curveLinear} stroke="var(--pos)" class="line" />
					<Spline y="liabilitiesPaise" curve={curveLinear} stroke="var(--neg)" class="line" />
				{/if}
				<Spline y="netWorthPaise" curve={curveLinear} stroke="currentColor" class="line" />

				{@const band = points.length > 1 ? (context.xScale(points[1]!.date) ?? 0) - (context.xScale(points[0]!.date) ?? 0) : 40}
				{#if hovered}
					<line x1={context.xScale(hovered.date)} x2={context.xScale(hovered.date)} y1={0} y2={context.height} class="rule" />
					<circle cx={context.xScale(hovered.date)} cy={context.yScale(hovered.netWorthPaise)} r="4" class="hover-dot" />
				{/if}
				{#each points as p, i (p.date)}
					<rect
						x={(context.xScale(p.date) ?? 0) - band / 2}
						y={0}
						width={Math.max(1, band)}
						height={context.height}
						class="hit"
						role="presentation"
						onpointerenter={() => (hover = { i, x: (context.xScale(p.date) ?? 0) + PAD_LEFT })}
					/>
				{/each}

				{#if last}
					<circle
						cx={context.xScale(last.date)}
						cy={context.yScale(last.netWorthPaise)}
						r="4"
						class="end-ring"
					></circle>
					<circle
						cx={context.xScale(last.date)}
						cy={context.yScale(last.netWorthPaise)}
						r="3"
						class="end-dot"
					></circle>
					<text
						x={(context.xScale(last.date) ?? 0) - 4}
						y={(context.yScale(last.netWorthPaise) ?? 0) - 8}
						text-anchor="end"
						class="end-label"
					>
						{m.money(last.netWorthPaise, { compact: m.compact })}
					</text>
				{/if}
			{/snippet}
		</Chart>
		{#if hovered && hover}
			<ChartTip
				title={monthLong(hovered.date)}
				x={hover.x}
				{width}
				rows={[
					{ label: 'Net worth', value: m.money(hovered.netWorthPaise), strong: showComposition },
					...(showComposition && hasComposition
						? [
								{ label: 'Assets', value: m.money(hovered.assetsPaise ?? 0), color: 'var(--pos)' },
								{ label: 'Liabilities', value: m.money(hovered.liabilitiesPaise ?? 0), color: 'var(--neg)' }
							]
						: [])
				]}
			/>
		{/if}
	</div>
</div>

<style>
	.line-wrap {
		width: 100%;
	}
	.chart-frame {
		position: relative;
		width: 100%;
		height: 13rem;
	}
	.toggle {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		font-size: 14px;
		opacity: 0.85;
		margin-bottom: 0.4rem;
	}
	.legend {
		list-style: none;
		display: flex;
		gap: 1rem;
		margin: 0 0 0.4rem;
		padding: 0;
		font-size: 12px;
	}
	.legend li {
		display: flex;
		align-items: center;
		gap: 0.35rem;
	}
	.swatch {
		display: inline-block;
		width: 0.65rem;
		height: 0.65rem;
		border-radius: var(--radius-control);
	}
	.swatch.nw {
		background: currentColor;
	}
	.swatch.assets {
		background: var(--pos);
	}
	.swatch.liab {
		background: var(--neg);
	}
	:global(.line-wrap .grid) {
		stroke: rgba(128, 128, 128, 0.2);
		stroke-width: 1;
	}
	:global(.line-wrap .tick-y),
	:global(.line-wrap .tick-x) {
		font-size: 12px;
		fill: currentColor;
		opacity: 0.7;
	}
	:global(.line-wrap .line) {
		fill: none;
		stroke-width: 2;
		stroke-linejoin: round;
		stroke-linecap: round;
	}
	.hit {
		fill: transparent;
		stroke: none;
	}
	.rule {
		stroke: var(--text-muted);
		stroke-dasharray: 2 2;
	}
	.hover-dot {
		fill: currentColor;
		stroke: var(--surface);
		stroke-width: 2;
	}
	.end-ring {
		/* halo behind the end dot = the card surface; theme-aware token so it
		   tracks BOTH the explicit theme toggle and the OS preference. */
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
