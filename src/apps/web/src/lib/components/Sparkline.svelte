<!--
	A 12-month trend line in a list row (chart N1): the balance at each month
	end and today, on the row's own scale, so it shows direction, not size (the Balance column beside
	it gives the size). A debt's balance is negative, so paying it down rises: up is always better for
	net worth. No hover on a line this small; the row opens the account. Plain SVG, server-rendered.
-->
<script lang="ts">
	// 96 px on an investment section, where five figure columns leave less room.
	let { values, width = 120 }: { values: number[]; width?: number } = $props();
	const W = $derived(width);
	const H = 22;
	const pts = $derived.by(() => {
		const lo = Math.min(...values);
		const hi = Math.max(...values);
		return values.map((v, i): [number, number] => [
			1 + (i * (W - 4)) / Math.max(1, values.length - 1),
			hi === lo ? H / 2 : H - 3 - ((v - lo) * (H - 6)) / (hi - lo)
		]);
	});
	const end = $derived(pts[pts.length - 1]);
</script>

{#if values.length >= 2 && end}
	<svg width={W} height={H} class="block" aria-hidden="true">
		<polyline
			points={pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')}
			fill="none"
			stroke="var(--text-muted)"
			stroke-width="1.5"
			stroke-linejoin="round"
		/>
		<circle cx={end[0]} cy={end[1]} r="2.5" fill="var(--text)" />
	</svg>
{/if}
