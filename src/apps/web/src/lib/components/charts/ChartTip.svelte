<!--
	ChartTip: the figures under the pointer, one card for every chart. Sits beside the
	hovered point and flips to its left near the chart's right edge, so it never covers the point.
	Placed absolutely in the chart's own relative box; never takes the pointer.
-->
<script lang="ts">
	interface Row {
		readonly label: string;
		readonly value: string;
		/** A tone class for the value (`text-pos`, `text-neg`). */
		readonly tone?: string;
		/** A swatch before the label: the series' colour. */
		readonly color?: string;
		readonly strong?: boolean;
		/** A part of the row above it (what "Other" holds): indented, no swatch. */
		readonly sub?: boolean;
	}
	let {
		title,
		rows,
		x,
		top = 18,
		width,
		w = 208
	}: { title: string; rows: Row[]; x: number; top?: number; width: number; w?: number } = $props();
	const left = $derived(x + 12 + w > width ? Math.max(0, x - 12 - w) : x + 12);
</script>

<div
	class="pointer-events-none absolute z-10 rounded-overlay border border-border bg-popover p-3 text-body text-popover-foreground shadow-[var(--shadow-pop)]"
	style="left: {left}px; top: {top}px; width: {w}px"
>
	<div class="mb-1 font-semibold">{title}</div>
	{#each rows as r (r.label)}
		<div class="flex justify-between gap-3 {r.sub ? 'pl-4' : ''}">
			<span class="inline-flex min-w-0 items-center gap-1.5 text-text-muted"
				>{#if r.color}<span class="inline-block size-2.5 shrink-0 rounded-xs" style="background: {r.color}"></span>{/if}<span
					class="truncate {r.strong ? 'font-semibold text-foreground' : ''}">{r.label}</span
				></span
			>
			<span class="num shrink-0 {r.tone ?? ''} {r.strong ? 'font-semibold' : ''}">{r.value}</span>
		</div>
	{/each}
</div>
