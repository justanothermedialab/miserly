<script lang="ts">
	import { cn, type WithElementRef } from "$lib/utils.js";
	import type { HTMLInputAttributes, HTMLInputTypeAttribute } from "svelte/elements";

	type InputType = Exclude<HTMLInputTypeAttribute, "file">;

	type Props = WithElementRef<
		Omit<HTMLInputAttributes, "type"> &
			({ type: "file"; files?: FileList } | { type?: InputType; files?: undefined })
	>;

	let {
		ref = $bindable(null),
		value = $bindable(),
		type,
		files = $bindable(),
		class: className,
		"data-slot": dataSlot = "input",
		...restProps
	}: Props = $props();
</script>

{#if type === "file"}
	<input
		bind:this={ref}
		data-slot={dataSlot}
		class={cn(
			"h-8 rounded-control border border-input border-b-border-strong bg-surface px-2.5 py-1 text-body transition-colors file:h-6 file:text-body file:font-normal focus:border-b-brand focus:shadow-[inset_0_-1px_0_var(--accent)] aria-invalid:border-b-neg aria-invalid:shadow-[inset_0_-1px_0_var(--neg)] w-full min-w-0 outline-none file:inline-flex file:border-0 file:bg-transparent file:text-foreground placeholder:text-text-muted disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
			className
		)}
		type="file"
		bind:files
		bind:value
		{...restProps}
	/>
{:else}
	<input
		bind:this={ref}
		data-slot={dataSlot}
		class={cn(
			"h-8 rounded-control border border-input border-b-border-strong bg-surface px-2.5 py-1 text-body transition-colors file:h-6 file:text-body file:font-normal focus:border-b-brand focus:shadow-[inset_0_-1px_0_var(--accent)] aria-invalid:border-b-neg aria-invalid:shadow-[inset_0_-1px_0_var(--neg)] w-full min-w-0 outline-none file:inline-flex file:border-0 file:bg-transparent file:text-foreground placeholder:text-text-muted disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
			className
		)}
		{type}
		bind:value
		{...restProps}
	/>
{/if}
