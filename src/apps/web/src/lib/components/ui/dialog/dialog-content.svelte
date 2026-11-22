<script lang="ts">
	import { Dialog as DialogPrimitive } from "bits-ui";
	import XIcon from '@lucide/svelte/icons/x';
	import { Button } from "$lib/components/ui/button/index.js";
	import { cn, type WithoutChildrenOrChild } from "$lib/utils.js";
	import * as Dialog from "./index.js";
	import DialogPortal from "./dialog-portal.svelte";
	import type { Snippet } from "svelte";
	import type { ComponentProps } from "svelte";

	let {
		ref = $bindable(null),
		class: className,
		portalProps,
		children,
		showCloseButton = true,
		...restProps
	}: WithoutChildrenOrChild<DialogPrimitive.ContentProps> & {
		portalProps?: WithoutChildrenOrChild<ComponentProps<typeof DialogPortal>>;
		children: Snippet;
		showCloseButton?: boolean;
	} = $props();
</script>

<DialogPortal {...portalProps}>
	<Dialog.Overlay />
	<DialogPrimitive.Content
		bind:ref
		data-slot="dialog-content"
		class={cn(
			"grid max-w-[calc(100%-2rem)] gap-4 rounded-overlay border border-border bg-popover p-6 text-body text-popover-foreground shadow-[var(--elevation-dialog)] sm:max-w-md data-open:animate-in data-open:fade-in-0 data-open:zoom-in-105 data-open:motion-normal data-open:ease-decelerate data-closed:animate-out data-closed:fade-out-0 data-closed:motion-fast data-closed:zoom-out-105 data-closed:ease-accelerate fixed top-1/2 left-1/2 z-50 w-full -translate-x-1/2 -translate-y-1/2 outline-none",
			className
		)}
		{...restProps}
	>
		{@render children?.()}
		{#if showCloseButton}
			<!-- No Tooltip here: a Bits tooltip's content mounts its own focus scope, which becomes the
			     active scope while it shows, so the dialog stopped looping Tab and focus left the
			     dialog from this (its last) control (hunt kb-qa-tab-loop). -->
			<DialogPrimitive.Close data-slot="dialog-close">
				{#snippet child({ props })}
					<Button variant="ghost" class="absolute top-3 right-3" size="icon" aria-label="Close" {...props}>
						<XIcon />
					</Button>
				{/snippet}
			</DialogPrimitive.Close>
		{/if}
	</DialogPrimitive.Content>
</DialogPortal>
