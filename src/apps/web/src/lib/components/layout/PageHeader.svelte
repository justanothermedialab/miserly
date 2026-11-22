<!--
  Page header (layout primitive). Every signed-in route starts with one.
  The page's name is shown once, in the TopBar (one heading only); here it is an
  sr-only <h1> for screen readers. What shows is the page's badge, meta line, headline figure
  (the DIRECTION "headline" is the figure, not the name) and actions. With none of those the
  header is the sr-only <h1> alone and takes no space.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		title,
		badge,
		meta,
		headline,
		actions,
		tight = false,
		class: cls = ''
	}: {
		title: string;
		badge?: Snippet;
		meta?: Snippet;
		headline?: Snippet;
		actions?: Snippet;
		/** 12 px below instead of 24, when the header and the toolbar under it are one block (the
		 *  register: a one-line header over its table's toolbar; skill Spacing, a block's parts). */
		tight?: boolean;
		class?: string;
	} = $props();
	const visible = $derived(Boolean(badge || meta || headline || actions));
</script>

{#if visible}
	<header class="{tight ? 'mb-3' : 'mb-section'} flex flex-wrap items-end justify-between gap-x-section gap-y-content {cls}">
		<div class="min-w-0">
			<h1 class="sr-only">{title}</h1>
			{#if badge || meta}
				<div class="flex flex-wrap items-center gap-2 text-body text-text-muted">
					{@render badge?.()}{@render meta?.()}
				</div>
			{/if}
			{#if headline}<div class={badge || meta ? 'mt-1' : ''}>{@render headline()}</div>{/if}
		</div>
		{#if actions}<div class="flex shrink-0 flex-wrap items-end gap-control">{@render actions()}</div>{/if}
	</header>
{:else}
	<h1 class="sr-only">{title}</h1>
{/if}
