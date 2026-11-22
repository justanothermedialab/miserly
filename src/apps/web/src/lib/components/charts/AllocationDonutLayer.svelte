<!--
	AllocationDonut (D2): the "Other" rollup (D2 RD4, <2.5% threshold), slicePercents so the
	legend always reads 100.0% in total, a FIXED-order categorical palette + muted "Other" gray.
	Uses LayerChart's Chart/Pie/Arc primitives for the arc geometry
	(radii as fractions of the chart's own radius, so the donut stays crisp at
	whatever pixel size the flex layout gives it); the center total, legend and
	per-slice hover titles are plain markup layered on top. Hovering a slice or its legend row puts
	that slice's figure in the centre, fades the rest and marks the row (the figure under
	the pointer). With `hrefOf`, a slice and its legend row open the accounts in it (D2 drill-in).
	C9: a slice below zero (an overdrawn bank) can't be drawn; it is listed
	under the legend with "not drawn", the ring's shares are of what is drawn, and the centre is the
	sum of every slice (Assets), as the headline. It was dropped without a word, and the centre read
	the drawn slices only.
-->
<script lang="ts">
	import { Chart, Pie, Arc } from 'layerchart';
	import { slicePercents } from '$lib/format';
	import { useMoney } from '$lib/format-context';

	interface Slice {
		readonly key: string;
		readonly amountPaise: number;
	}

	let {
		slices,
		labelOf = (key: string) => key,
		colorOf,
		showBars = false,
		size = 'md',
		hrefOf
	}: {
		slices: Slice[];
		labelOf?: (key: string) => string;
		/** The slice's own colour (colour follows the entity, never its rank; $lib/swatches). */
		colorOf?: (key: string) => string;
		showBars?: boolean;
		/** 'sm': a 104 px donut that sits beside its legend in a narrow column (the dashboard). */
		size?: 'md' | 'sm';
		/** Where a slice and its legend row lead (the accounts in it); "Other" leads nowhere. */
		hrefOf?: (key: string) => string | null;
	} = $props();
	const m = useMoney();

	// Brand-neutral categorical palette (theme-aware CSS vars → app.css --cat-*,
	// the dataviz reference palette validated in BOTH modes). Brand gold is NOT
	// in this set — it's reserved for brand/CTA, never "category A".
	// Assigned by position, never by identity/rank.
	const CATEGORICAL = [
		'var(--cat-1)',
		'var(--cat-2)',
		'var(--cat-3)',
		'var(--cat-4)',
		'var(--cat-5)',
		'var(--cat-6)',
		'var(--cat-7)',
		'var(--cat-8)',
		'var(--cat-9)',
		'var(--cat-10)'
	];
	const OTHER_COLOR = 'var(--cat-other)'; // neutral residual bucket, not an identity
	const OTHER_KEY = '__other__';
	const OTHER_THRESHOLD = 0.025; // D2 RD4: roll slices below ~2.5% into "Other"

	// Radii as a fraction of the chart's own radius (min(width,height)/2) — the
	// same 58:90 ratio the D3 version drew fixed inside its 200x200 viewBox.
	const OUTER_R = 0.9;
	const INNER_R = 58 / 90;

	/** The slices below zero: listed under the legend, not drawn (C9). */
	const notDrawn = $derived(slices.filter((s) => s.amountPaise < 0));

	/** Roll small slices into one "Other" bucket; keeps the caller's desc order. Positive only. */
	const rolled = $derived.by((): Slice[] => {
		const drawn = slices.filter((s) => s.amountPaise > 0);
		const drawnTotal = drawn.reduce((sum, s) => sum + s.amountPaise, 0);
		if (drawnTotal <= 0) return [];
		const kept: Slice[] = [];
		let otherSum = 0;
		for (const s of drawn) {
			if (s.amountPaise / drawnTotal < OTHER_THRESHOLD) otherSum += s.amountPaise;
			else kept.push(s);
		}
		if (otherSum > 0) kept.push({ key: OTHER_KEY, amountPaise: otherSum });
		return kept;
	});

	// The centre: every slice, a negative one too, so it reads Assets as the headline does (C9).
	const total = $derived(slices.reduce((sum, s) => sum + s.amountPaise, 0));
	const percents = $derived(slicePercents(rolled.map((s) => s.amountPaise)));

	function colorFor(i: number, key: string): string {
		if (key === OTHER_KEY) return OTHER_COLOR;
		return colorOf ? colorOf(key) : CATEGORICAL[i % CATEGORICAL.length]!;
	}

	let hoverKey = $state<string | null>(null);
	const hovered = $derived(hoverKey === null ? null : rolled.findIndex((s) => s.key === hoverKey));

	function nameFor(key: string): string {
		return key === OTHER_KEY ? 'Other' : labelOf(key);
	}
	function linkFor(key: string): string | null {
		return key === OTHER_KEY || !hrefOf ? null : hrefOf(key);
	}
</script>

{#snippet arc(a: { startAngle: number; endAngle: number; data: Slice }, i: number)}
	<Arc
		startAngle={a.startAngle}
		endAngle={a.endAngle}
		innerRadius={INNER_R}
		outerRadius={OUTER_R}
		cornerRadius={2}
		padAngle={0.01}
		fill={colorFor(i, a.data.key)}
	/>
{/snippet}

{#if rolled.length === 0}
	<p class="empty">No assets to allocate.</p>
{:else}
	<div class="donut-wrap">
		<div class="donut-chart" class:sm={size === 'sm'}>
			<Chart
				data={rolled}
				x={(d: Slice) => d.amountPaise}
				radial={true}
				axis={false}
				grid={false}
				rule={false}
				highlight={false}
				tooltipContext={false}
			>
				{#snippet marks()}
					<Pie sort={null}>
						{#snippet children({ arcs })}
							{#each arcs as a, i (a.data.key)}
								{@const href = linkFor(a.data.key)}
								<g
									role="presentation"
									style="opacity: {hoverKey !== null && hoverKey !== a.data.key ? 0.35 : 1}; transition: opacity 120ms"
									onpointerenter={() => (hoverKey = a.data.key)}
									onpointerleave={() => (hoverKey = null)}
								>
									<title
										>{nameFor(a.data.key)}: {m.money(a.data.amountPaise, {
											compact: m.compact
										})} ({percents[i]}%)</title
									>
									{#if href}
										<a {href} class="slice-link" tabindex="-1" aria-label={nameFor(a.data.key)}>
											{@render arc(a, i)}
										</a>
									{:else}
										{@render arc(a, i)}
									{/if}
								</g>
							{/each}
						{/snippet}
					</Pie>
					<!-- The centre always takes the short form: a full crore figure is wider than the hole
					     (owner's exe test). The full figure is the hover title and the headline above. -->
					{#if hovered !== null && hovered >= 0}
						{@const h = rolled[hovered]!}
						<text x="0" y={size === 'sm' ? -1 : -4} text-anchor="middle" class="center-total">{m.money(h.amountPaise, { compact: true })}</text>
						<text x="0" y={size === 'sm' ? 13 : 16} text-anchor="middle" class="center-hover">{size === 'sm' ? `${percents[hovered]}%` : nameFor(h.key)}</text>
					{:else}
						<text x="0" y={size === 'sm' ? 5 : -4} text-anchor="middle" class="center-total"
							><title>{m.money(total)}</title>{m.money(total, { compact: true })}</text
						>
						{#if size !== 'sm'}<text x="0" y="16" text-anchor="middle" class="center-sub">Total</text>{/if}
					{/if}
				{/snippet}
			</Chart>
		</div>
		<ul class="legend" class:with-bars={showBars} class:sm={size === 'sm'}>
			{#each rolled as s, i (s.key)}
				{@const href = linkFor(s.key)}
				<li
					class:on={hoverKey === s.key}
					class:linked={href !== null}
					onpointerenter={() => (hoverKey = s.key)}
					onpointerleave={() => (hoverKey = null)}
				>
					<span class="swatch" style={`background:${colorFor(i, s.key)}`}></span>
					{#if href}
						<!-- The link's ::after covers the row, so a click anywhere on it opens the accounts. -->
						<a {href} class="label row-link">{nameFor(s.key)}</a>
					{:else}
						<span class="label">{nameFor(s.key)}</span>
					{/if}
					<span class="amt">{m.money(s.amountPaise, { compact: m.compact })}</span>
					<span class="pct">{percents[i]}%</span>
					{#if showBars}
						<span class="bar"
							><i style={`width:${percents[i]}%;background:${colorFor(i, s.key)}`}></i></span
						>
					{/if}
				</li>
			{/each}
			{#each notDrawn as s (s.key)}
				{@const href = linkFor(s.key)}
				<li class="not-drawn" class:linked={href !== null}>
					<span class="swatch hollow" style={`border-color:${colorFor(0, s.key)}`}></span>
					{#if href}
						<a {href} class="label row-link">{nameFor(s.key)}</a>
					{:else}
						<span class="label">{nameFor(s.key)}</span>
					{/if}
					<span class="amt">{m.money(s.amountPaise, { compact: m.compact })}</span>
					<span class="pct">Not drawn</span>
				</li>
			{/each}
		</ul>
	</div>
{/if}

<style>
	.empty {
		opacity: 0.7;
	}
	.donut-wrap {
		display: flex;
		gap: 1.4rem;
		align-items: center;
		flex-wrap: wrap;
	}
	.donut-chart {
		width: 11rem;
		height: 11rem;
		flex: 0 0 auto;
	}
	.donut-chart.sm {
		width: 6.5rem;
		height: 6.5rem;
	}
	.donut-chart.sm .center-sub {
		display: none;
	}
	.center-total {
		font-size: 14px;
		font-weight: 600;
		fill: currentColor;
	}
	.center-hover {
		font-size: 12px;
		fill: var(--text-muted);
	}
	.slice-link {
		cursor: pointer;
	}
	.legend li.linked {
		position: relative;
		cursor: pointer;
	}
	.legend li.linked:hover {
		background: var(--control);
		border-radius: var(--radius-control);
	}
	.row-link {
		color: inherit;
		text-decoration: none;
	}
	.row-link::after {
		content: '';
		position: absolute;
		inset: 0;
	}
	.legend li.on {
		background: var(--control);
		border-radius: var(--radius-control);
	}
	.center-sub {
		font-size: 12px;
		fill: var(--text-muted);
	}
	.legend {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
		flex: 1 1 12rem;
		min-width: 0;
	}
	.legend li {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 14px;
		white-space: nowrap; /* DL-12: a legend row never wraps */
	}
	.legend .label {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	/* The small (dashboard) donut's legend is too narrow for a name, a full amount and a share on
	   one line: the name and share lead, the amount sits under the name (owner's exe test). */
	.legend.sm li {
		display: grid;
		grid-template-columns: 0.7rem 1fr auto;
		column-gap: 0.5rem;
	}
	.legend.sm .amt {
		grid-row: 2;
		grid-column: 2 / -1;
		font-size: 12px;
		color: var(--text-muted);
		opacity: 1;
	}
	.legend.sm .pct {
		min-width: 0;
	}
	/* Mock `.lrow`: a colored share bar under each legend row (reports donut). */
	.legend.with-bars li {
		display: grid;
		grid-template-columns: 0.7rem 1fr auto 3rem;
		align-items: center;
		column-gap: 0.6rem;
		padding: 8px 8px;
		border-radius: var(--radius-control);
	}
	.legend.with-bars li:hover {
		background: var(--control);
	}
	.bar {
		grid-column: 1 / -1;
		height: 4px;
		border-radius: var(--radius-control);
		background: var(--surface-2);
		overflow: hidden;
		margin-top: 4px;
	}
	.bar i {
		display: block;
		height: 100%;
		border-radius: var(--radius-control);
	}
	/* A slice below zero has no arc: its swatch is an outline (C9). */
	.swatch.hollow {
		background: transparent;
		border: 1.5px solid;
	}
	.legend li.not-drawn .pct {
		font-size: 12px;
	}
	.swatch {
		width: 0.7rem;
		height: 0.7rem;
		border-radius: var(--radius-control);
		flex: 0 0 auto;
	}
	.label {
		flex: 1;
	}
	.amt {
		font-variant-numeric: tabular-nums;
		opacity: 0.85;
	}
	.pct {
		font-variant-numeric: tabular-nums;
		opacity: 0.65;
		min-width: 3.2rem;
		text-align: right;
	}
</style>
