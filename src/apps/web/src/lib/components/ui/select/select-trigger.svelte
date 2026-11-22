<script lang="ts">
	import { Select as SelectPrimitive } from "bits-ui";
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import { cn, type WithoutChild } from "$lib/utils.js";

	let {
		ref = $bindable(null),
		class: className,
		children,
		size = "default",
		onkeydown,
		...restProps
	}: WithoutChild<SelectPrimitive.TriggerProps> & {
		size?: "sm" | "default";
	} = $props();

	// A Windows ComboBox brings itself into view when it opens. Without this, Space on a focused
	// trigger that had been scrolled out of view opened the list off-screen (hunt walk
	// part 2). Runs before Bits opens and positions the list.
	const OPEN_KEYS = new Set([' ', 'Enter', 'ArrowDown', 'ArrowUp']);
	function bringIntoView(e: KeyboardEvent & { currentTarget: EventTarget & HTMLButtonElement }) {
		if (OPEN_KEYS.has(e.key)) e.currentTarget.scrollIntoView({ block: 'nearest', inline: 'nearest' });
		(onkeydown as ((ev: typeof e) => void) | undefined)?.(e);
	}
</script>

<SelectPrimitive.Trigger
	bind:ref
	data-slot="select-trigger"
	data-size={size}
	class={cn(
		"gap-1.5 rounded-control border border-input border-b-border-strong bg-surface py-1 pr-2 pl-2.5 text-body transition-colors select-none hover:bg-surface-2 focus-visible:border-b-brand focus-visible:shadow-[inset_0_-1px_0_var(--accent)] focus-visible:outline-none aria-invalid:border-b-neg data-placeholder:text-text-muted data-[size=default]:h-8 data-[size=sm]:h-6 *:data-[slot=select-value]:flex *:data-[slot=select-value]:gap-1.5 [&_svg:not([class*='size-'])]:size-4 flex w-fit items-center justify-between whitespace-nowrap outline-none disabled:cursor-not-allowed disabled:opacity-50 *:data-[slot=select-value]:line-clamp-1 *:data-[slot=select-value]:flex *:data-[slot=select-value]:items-center [&_svg]:pointer-events-none [&_svg]:shrink-0",
		className
	)}
	{...restProps}
	onkeydown={bringIntoView}
>
	{@render children?.()}
	<ChevronDownIcon class="size-4 text-muted-foreground pointer-events-none" />
</SelectPrimitive.Trigger>
