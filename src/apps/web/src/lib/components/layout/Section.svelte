<!--
  Section (layout primitive): a titled block on the page, not a card. Sections are 24 px apart;
  the heading is Body Strong with optional actions on its right, 8 px above its content (skill
  Spacing: a section title to its content; AUDIT-S4 S1).
-->
<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		title,
		actions,
		children,
		class: cls = ''
	}: { title?: string; actions?: Snippet; children: Snippet; class?: string } = $props();
	const id = $props.id();
</script>

<section class="mt-section first:mt-0 {cls}" aria-labelledby={title ? `${id}-h` : undefined}>
	{#if title}
		<div class="mb-2 flex items-center justify-between gap-control {actions ? 'min-h-8' : ''}">
			<h2 id="{id}-h" class="text-body font-semibold">{title}</h2>
			{#if actions}<div class="flex items-center gap-control">{@render actions()}</div>{/if}
		</div>
	{/if}
	{@render children()}
</section>
