<script lang="ts">
	import { cn, type WithElementRef } from "$lib/utils.js";
	import type { HTMLAttributes } from "svelte/elements";

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLDivElement>> = $props();
</script>

<div
	bind:this={ref}
	data-slot="card-header"
	class={cn(
		"flex flex-col gap-1 rounded-t-overlay px-(--card-spacing) [.border-b]:pb-(--card-spacing) group/card-header",
		className
	)}
	{...restProps}
>
	{@render children?.()}
</div>
