<!--
	StackedBars (R2 RD5 spending by category by month; D3 RD6 net worth by class): one bar per
	month, stacked by series, negatives stacked below zero, an optional line (net worth) over the
	bars. LayerChart Chart for the scales and axes; the bars are drawn from its scales. Dataviz
	marks: a 2 px surface gap between stacked segments, the legend above the plot flush left
	(skill Charts), colour from the series (never its rank). Hover a month for every series' figure
	and the total or the line's (ChartTip); with `hrefOf`, a segment opens its drill.
-->
<script lang="ts">
	import { Chart } from 'layerchart';
	import { scaleBand } from 'd3-scale';
	import { useMoney } from '$lib/format-context';
	import { goto } from '$app/navigation';
	import ChartTip from './ChartTip.svelte';

	interface Series {
		readonly name: string;
		readonly color: string;
		readonly values: readonly number[];
		/** What a lumped series holds ("Other"), named under it in the hover card (U9). */
		readonly parts?: readonly { readonly name: string; readonly values: readonly number[] }[];
	}
	/** The parts named under a lumped series in the hover card; the rest are one "N more" line. */
	const PARTS_SHOWN = 4;
	let {
		keys,
		labels,
		series,
		line,
		lineName = 'Net worth',
		height = 220,
		hrefOf
	}: {
		/** One x key per bar (e.g. 'YYYY-MM'). */
		keys: string[];
		/** The tick label for each key. */
		labels: string[];
		series: Series[];
		/** An optional line over the bars, one value per key. */
		line?: number[];
		lineName?: string;
		height?: number;
		/** A segment's drill (series index, key index), or null: the segment is then a link. */
		hrefOf?: (series: number, key: number) => string | null;
	} = $props();
	const m = useMoney();

	const domain = $derived.by((): [number, number] => {
		let lo = 0;
		let hi = 0;
		keys.forEach((_, i) => {
			let up = 0;
			let dn = 0;
			for (const s of series) {
				const v = s.values[i] ?? 0;
				if (v >= 0) up += v;
				else dn += v;
			}
			hi = Math.max(hi, up, line?.[i] ?? 0);
			lo = Math.min(lo, dn, line?.[i] ?? 0);
		});
		return hi === lo ? [lo, lo + 1] : [lo, hi];
	});
	const labelOf = $derived(new Map(keys.map((k, i) => [k, labels[i] ?? k])));
	// Sparse ticks when there are many months, so labels never collide.
	const PAD_LEFT = 52;
	let width = $state(0);
	let hover = $state<{ i: number; x: number } | null>(null);
	const tipRows = $derived.by(() => {
		if (!hover) return [];
		const i = hover.i;
		const parts = series
			.filter((s) => (s.values[i] ?? 0) !== 0)
			.flatMap((s) => {
				const row = { label: s.name, value: m.money(s.values[i] ?? 0), color: s.color };
				if (!s.parts) return [row];
				const held = s.parts
					.map((p) => ({ name: p.name, v: p.values[i] ?? 0 }))
					.filter((p) => p.v !== 0)
					.sort((a, b) => b.v - a.v);
				const shown = held.slice(0, PARTS_SHOWN).map((p) => ({ label: p.name, value: m.money(p.v), sub: true }));
				const rest = held.slice(PARTS_SHOWN);
				if (rest.length > 0)
					shown.push({ label: `${rest.length} more`, value: m.money(rest.reduce((t, p) => t + p.v, 0)), sub: true });
				return [row, ...shown];
			});
		const total = line
			? { label: lineName, value: m.money(line[i] ?? 0), strong: true }
			: { label: 'Total', value: m.money(series.reduce((t, s) => t + (s.values[i] ?? 0), 0)), strong: true };
		return [total, ...parts];
	});
	const ticks = $derived(keys.length <= 12 ? keys : keys.filter((_, i) => i % Math.ceil(keys.length / 12) === 0));
</script>

<div class="bars">
	<ul class="legend">
		{#each series as s (s.name)}
			<li><span class="key" style="background:{s.color}"></span>{s.name}</li>
		{/each}
		{#if line}<li><span class="key line"></span>{lineName}</li>{/if}
	</ul>
	<div class="frame" style="height: {height}px" bind:clientWidth={width} role="presentation" onpointerleave={() => (hover = null)}>
		<Chart
			data={keys.map((k) => ({ k }))}
			x="k"
			xScale={scaleBand<string>().paddingInner(0.35).paddingOuter(0.2)}
			xDomain={keys}
			y={() => 0}
			yDomain={domain}
			yNice={true}
			padding={{ top: 8, right: 8, bottom: 22, left: PAD_LEFT }}
			grid={{ class: 'grid' }}
			rule={false}
			highlight={false}
			tooltipContext={false}
			props={{
				yAxis: { ticks: 4, tickMarks: false, format: (t: number) => m.money(t, { compact: true }), classes: { tickLabel: 'tick' } },
				xAxis: { ticks, tickMarks: false, format: (k: string) => labelOf.get(k) ?? k, classes: { tickLabel: 'tick' } }
			}}
		>
			{#snippet marks({ context })}
				{@const band = (context.xScale as unknown as { bandwidth: () => number }).bandwidth()}
				<!-- Each month's hover area is its whole step, so the gaps between bars aren't dead. -->
				{@const step = (context.xScale as unknown as { step: () => number }).step()}
				<!-- U12: six months or fewer get wider bars (40 px across a 170 px step read as sticks). -->
				{@const w = Math.min(keys.length <= 6 ? 64 : 40, band)}
				{@const y = (v: number) => context.yScale(v) ?? 0}
				<line x1={0} x2={context.width} y1={y(0)} y2={y(0)} class="zero" />
				{#each keys as k, i (k)}
					{@const x0 = (context.xScale(k) ?? 0) + (band - w) / 2}
					{@const enter = () => (hover = { i, x: (context.xScale(k) ?? 0) + band / 2 + PAD_LEFT })}
					<rect x={(context.xScale(k) ?? 0) - (step - band) / 2} y={0} width={step} height={context.height} class="hit {hover?.i === i ? 'on' : ''}" role="presentation" onpointerenter={enter} />
					{@const stacks = (() => {
						let up = 0;
						let dn = 0;
						return series.map((s) => {
							const v = s.values[i] ?? 0;
							const [a, b] = v >= 0 ? [up, (up += v)] : [dn, (dn += v)];
							return { s, v, top: Math.min(y(a), y(b)), h: Math.abs(y(a) - y(b)) };
						});
					})()}
					{#each stacks as st, si (st.s.name)}
						{@const to = hrefOf?.(si, i) ?? null}
						{#if st.v !== 0 && st.h > 0}
							<rect
								x={x0}
								y={st.top + (st.h > 3 ? 1 : 0)}
								width={w}
								height={st.h > 3 ? st.h - 2 : st.h}
								rx="2"
								fill={st.s.color}
								class:link={to}
								role={to ? 'link' : 'presentation'}
								aria-label={to ? `${st.s.name}, ${labelOf.get(k)}: ${m.money(st.v)}` : undefined}
								onpointerenter={enter}
								onclick={() => to && goto(to)}
							/>
						{/if}
					{/each}
				{/each}
				{#if line}
					{@const cx = (k: string) => (context.xScale(k) ?? 0) + band / 2}
					<path d={keys.map((k, i) => `${i ? 'L' : 'M'}${cx(k)},${y(line[i] ?? 0)}`).join('')} class="net" />
					{#each keys as k, i (k)}
						<circle cx={cx(k)} cy={y(line[i] ?? 0)} r="3.5" class="dot" pointer-events="none" />
					{/each}
				{/if}
			{/snippet}
		</Chart>
		{#if hover}<ChartTip title={labelOf.get(keys[hover.i] ?? '') ?? ''} x={hover.x} top={4} {width} w={232} rows={tipRows} />{/if}
	</div>
</div>

<style>
	.legend {
		list-style: none;
		display: flex;
		flex-wrap: wrap;
		gap: 4px 16px;
		margin: 0 0 8px;
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
		width: 10px;
		height: 10px;
		border-radius: 2px;
	}
	.key.line {
		height: 2px;
		width: 12px;
		background: var(--text);
	}
	:global(.bars .grid) {
		stroke: var(--divider);
		stroke-width: 1;
	}
	:global(.bars .tick) {
		font-size: 12px;
		fill: var(--text-muted);
	}
	.frame {
		position: relative;
	}
	.hit {
		fill: transparent;
	}
	.hit.on {
		fill: var(--control);
	}
	.link {
		cursor: pointer;
	}
	.zero {
		stroke: var(--border-strong);
		stroke-width: 1;
	}
	.net {
		fill: none;
		stroke: var(--text);
		stroke-width: 2;
		stroke-linejoin: round;
	}
	.dot {
		fill: var(--text);
		stroke: var(--surface);
		stroke-width: 2;
	}
</style>
