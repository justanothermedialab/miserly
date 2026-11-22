<script lang="ts">
	import { DropdownMenu as DropdownMenuPrimitive } from "bits-ui";
	import { cn, type WithoutChildrenOrChild } from "$lib/utils.js";
	import DropdownMenuPortal from "./dropdown-menu-portal.svelte";
	import type { ComponentProps } from "svelte";

	let {
		ref = $bindable(null),
		sideOffset = 4,
		align = "start",
		portalProps,
		class: className,
		...restProps
	}: DropdownMenuPrimitive.ContentProps & {
		portalProps?: WithoutChildrenOrChild<ComponentProps<typeof DropdownMenuPortal>>;
	} = $props();
</script>

<DropdownMenuPortal {...portalProps}>
	<DropdownMenuPrimitive.Content
		bind:ref
		data-slot="dropdown-menu-content"
		{sideOffset}
		{align}
		class={cn(
			"rounded-overlay border border-border bg-popover p-1 text-popover-foreground shadow-[var(--shadow-pop)] data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:motion-fast data-open:ease-decelerate data-closed:animate-out data-closed:fade-out-0 data-closed:motion-faster data-closed:ease-linear data-[side=inline-end]:slide-in-from-left-2 data-[side=inline-start]:slide-in-from-right-2 z-50 max-h-(--bits-dropdown-menu-content-available-height) w-max min-w-[max(8rem,var(--bits-dropdown-menu-anchor-width))] max-w-[min(20rem,calc(100vw-16px))] overflow-x-hidden overflow-y-auto outline-none data-closed:overflow-hidden",
			className
		)}
		{...restProps}
	/>
</DropdownMenuPortal>
