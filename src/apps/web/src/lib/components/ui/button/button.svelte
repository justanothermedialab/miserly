<script lang="ts" module>
	import { type VariantProps } from "tailwind-variants";
	import { tv } from "$lib/utils.js";
	import { cn, type WithElementRef } from "$lib/utils.js";
	import type { HTMLAnchorAttributes, HTMLButtonAttributes } from "svelte/elements";

	export const buttonVariants = tv({
		// Fluent 2 Button (miserly-desktop-shell): 4px radius, 14/600, no press translate.
		base: "rounded-control border border-transparent text-body font-semibold aria-invalid:border-neg [&_svg:not([class*='size-'])]:size-4 group/button inline-flex shrink-0 items-center justify-center whitespace-nowrap transition-colors select-none disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0",
		variants: {
			variant: {
				// Accent — gold fill, dark label. One per view.
				default: "bg-primary text-primary-foreground hover:brightness-[1.06] active:brightness-95",
				// Standard — surface + stroke.
				outline: "border-border-strong bg-surface text-text hover:bg-surface-2 active:bg-surface-3 aria-expanded:bg-surface-2",
				secondary: "border-border-strong bg-surface text-text hover:bg-surface-2 active:bg-surface-3 aria-expanded:bg-surface-2",
				// Subtle — transparent until hover.
				ghost: "text-text hover:bg-control-hover active:bg-surface-3 aria-expanded:bg-control-hover",
				// Destructive — subtle with a red label (fill only inside a confirm dialog via class).
				destructive: "text-neg hover:bg-neg-weak active:bg-neg-weak",
				link: "text-brand-ink underline-offset-4 hover:underline",
			},
			size: {
				default: "h-8 gap-1.5 px-3",
				sm: "h-8 gap-1.5 px-3",
				lg: "h-8 gap-1.5 px-4",
				xs: "h-6 gap-1 px-2 text-caption [&_svg:not([class*='size-'])]:size-3.5",
				icon: "size-8",
				"icon-lg": "size-8",
				"icon-sm": "size-6",
				"icon-xs": "size-6 [&_svg:not([class*='size-'])]:size-3.5",
			},
		},
		defaultVariants: {
			variant: "default",
			size: "default",
		},
	});

	export type ButtonVariant = VariantProps<typeof buttonVariants>["variant"];
	export type ButtonSize = VariantProps<typeof buttonVariants>["size"];

	export type ButtonProps = WithElementRef<HTMLButtonAttributes> &
		WithElementRef<HTMLAnchorAttributes> & {
			variant?: ButtonVariant;
			size?: ButtonSize;
		};
</script>

<script lang="ts">
	let {
		class: className,
		variant = "default",
		size = "default",
		ref = $bindable(null),
		href = undefined,
		type = "button",
		disabled,
		children,
		...restProps
	}: ButtonProps = $props();
</script>

{#if href}
	<a
		bind:this={ref}
		data-slot="button"
		class={cn(buttonVariants({ variant, size }), className)}
		href={disabled ? undefined : href}
		aria-disabled={disabled}
		role={disabled ? "link" : undefined}
		tabindex={disabled ? -1 : undefined}
		{...restProps}
	>
		{@render children?.()}
	</a>
{:else}
	<button
		bind:this={ref}
		data-slot="button"
		class={cn(buttonVariants({ variant, size }), className)}
		{type}
		{disabled}
		{...restProps}
	>
		{@render children?.()}
	</button>
{/if}
