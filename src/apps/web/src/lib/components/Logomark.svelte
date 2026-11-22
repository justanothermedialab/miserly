<!--
	Logomark — the Miserly brand mark: the launch page's hollow diamond: a square turned 45° with a gold
	border, its outer diagonal the full box. Drawn in --mark (#a9822f Light, #c9a24b Dark), so it
	stays gold whatever accent the viewer picks. Unplated, as Windows' icon guidance prefers.
	`stroke` is in 24ths of the box: 1.5 as drawn; the app icon uses 2.25 at 24 and 16 px, where
	the drawn stroke fades.
-->
<script lang="ts">
	let { size = 22, stroke = 1.5 }: { size?: number; stroke?: number } = $props();
	const inset = $derived((stroke / 2) * Math.SQRT2);
</script>

<svg
	class="flex-none"
	viewBox="0 0 24 24"
	width={size}
	height={size}
	fill="none"
	aria-hidden="true"
>
	<path
		d="M12 {inset} {24 - inset} 12 12 {24 - inset} {inset} 12Z"
		stroke="var(--mark)"
		stroke-width={stroke}
		stroke-linejoin="miter"
	/>
</svg>
