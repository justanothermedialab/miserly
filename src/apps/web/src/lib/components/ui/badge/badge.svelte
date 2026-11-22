<script lang="ts" module>
	import { type VariantProps } from "tailwind-variants";
	import { tv } from "$lib/utils.js";

	export const badgeVariants = tv({
		// One tinted pill (FL-08): Caption 12/600, tinted fill + matching text.
		base: "h-5 gap-1 rounded-full px-2 text-caption font-semibold [&>svg]:size-3! inline-flex w-fit shrink-0 items-center justify-center overflow-hidden whitespace-nowrap [&>svg]:pointer-events-none",
		variants: {
			variant: {
				default: "bg-brand-weak text-text", // brand-ink on the gold tint was 4.47:1
				secondary: "bg-control-hover text-text",
				outline: "bg-control-hover text-text",
				ghost: "bg-control-hover text-text",
				destructive: "bg-neg-weak text-neg",
				positive: "bg-pos-weak text-pos",
				warning: "bg-warn-weak text-warn",
				link: "text-brand-ink underline-offset-4 hover:underline",
			},
		},
		defaultVariants: {
			variant: "default",
		},
	});

	export type BadgeVariant = VariantProps<typeof badgeVariants>["variant"];
</script>

<script lang="ts">
	import { cn, type WithElementRef } from "$lib/utils.js";
	import type { HTMLAnchorAttributes } from "svelte/elements";

	let {
		ref = $bindable(null),
		href,
		class: className,
		variant = "default",
		children,
		...restProps
	}: WithElementRef<HTMLAnchorAttributes> & {
		variant?: BadgeVariant;
	} = $props();
</script>

<svelte:element
	this={href ? "a" : "span"}
	bind:this={ref}
	data-slot="badge"
	{href}
	class={cn(badgeVariants({ variant }), className)}
	{...restProps}
>
	{@render children?.()}
</svelte:element>
