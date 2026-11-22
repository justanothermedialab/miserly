<!--
  Table frame (layout primitive): a `.data-table` placed on the page, not inside a card. A
  divider above the header row separates it from the toolbar; a table wider than the pane scrolls
  sideways inside the frame (never the page); `empty` renders in its place when there are
  no rows. `emptyRule={false}` drops the divider for a page whose toolbar hides when it's empty
  (To categorize), where it was a stray line over the empty state.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		children,
		empty,
		isEmpty = false,
		emptyRule = true,
		class: cls = ''
	}: { children: Snippet; empty?: Snippet; isEmpty?: boolean; emptyRule?: boolean; class?: string } = $props();
</script>

<div class="min-w-0 overflow-x-auto {isEmpty && !emptyRule ? '' : 'border-t border-divider'} {cls}">
	{#if isEmpty && empty}
		{@render empty()}
	{:else}
		{@render children()}
	{/if}
</div>
