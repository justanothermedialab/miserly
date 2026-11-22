<!--
	EmptyState — what an empty screen or table shows ("do what's optimal"; the
	register's own, item 3): an icon, a line saying what goes here, a sentence on why it's empty, and
	one action only when there is a real next step (Fluent, Material and Apple's empty-state guidance;
	Monarch, Copilot, the Microsoft Store). Good news ("All caught up") gets no button.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import ColourIcon from '$lib/components/ColourIcon.svelte';

	let {
		icon,
		title,
		text,
		action
	}: { icon?: string; title: string; text?: string; action?: Snippet } = $props();
</script>

<div class="flex flex-col items-center gap-2 px-4 py-12 text-center">
	{#if icon}<ColourIcon name={icon} size={32} />{/if}
	<div class="text-body-lg font-semibold text-foreground">{title}</div>
	{#if text}<div class="max-w-md text-body text-text-muted">{text}</div>{/if}
	{#if action}<div class="mt-1">{@render action()}</div>{/if}
</div>
