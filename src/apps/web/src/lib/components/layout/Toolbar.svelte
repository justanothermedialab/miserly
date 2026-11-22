<!--
  Toolbar (layout primitive): one row of controls above a table or list: search, a filter
  button, the primary action. Controls are 8 px apart (Fluent), the table 8 below (as every
  toolbar in the app, the register mock's value); `end` sits at the right edge.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		children,
		end,
		label,
		class: cls = ''
	}: { children?: Snippet; end?: Snippet; label?: string; class?: string } = $props();
</script>

<div class="mb-2 flex min-h-8 flex-wrap items-center gap-control {cls}" aria-label={label} role={label ? 'group' : undefined}>
	{@render children?.()}
	{#if end}<span class="flex-1"></span>{@render end()}{/if}
</div>
