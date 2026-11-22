<script lang="ts">
	import { cn, type WithElementRef } from "$lib/utils.js";
	import type { HTMLAttributes } from "svelte/elements";

	let {
		ref = $bindable(null),
		class: className,
		children,
		size = "default",
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLDivElement>> & { size?: "default" | "sm" } = $props();
</script>

<div
	bind:this={ref}
	data-slot="card"
	data-size={size}
	class={cn("gap-(--card-spacing) overflow-hidden rounded-overlay bg-card py-(--card-spacing) text-body text-card-foreground border border-border shadow-[var(--elevation-card)] [--card-spacing:--spacing(3)] has-data-[slot=card-footer]:pb-0 has-[>img:first-child]:pt-0 data-[size=sm]:[--card-spacing:--spacing(2.5)] data-[size=sm]:has-data-[slot=card-footer]:pb-0 *:[img:first-child]:rounded-t-overlay *:[img:last-child]:rounded-b-overlay group/card flex flex-col", className)}
	{...restProps}
>
	{@render children?.()}
</div>
