<!--
	ColourIcon — one of the Fluent colour icons ($lib/icons/colour) at a given size. Decorative: the
	control around it carries the name. Unknown keys render nothing.

	Each instance gets its own gradient ids. The icons paint with url(#id) gradients, and the same icon
	appears twice in the sidebar (the folding row and its rail link, one of them display:none): with
	shared ids the reference resolved to the hidden copy and the visible icon painted nothing (the
	collapsed rail showed no icons). $props.id() matches between server and client.
-->
<script lang="ts">
	import { COLOUR_ICONS } from '$lib/icons/colour';

	let { name, size = 18, class: cls = '' }: { name: string; size?: number; class?: string } = $props();
	const uid = $props.id();
	const svg = $derived(
		(COLOUR_ICONS[name] ?? '')
			.replace('width="24" height="24"', `width="${size}" height="${size}" aria-hidden="true" focusable="false"`)
			.replace(/id="([^"]+)"/g, `id="$1_${uid}"`)
			.replace(/url\(#([^)]+)\)/g, `url(#$1_${uid})`)
	);
</script>

{#if svg}<span class="inline-flex flex-none {cls}">{@html svg}</span>{/if}
