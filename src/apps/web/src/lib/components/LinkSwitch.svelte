<!--
	A row of links that reads as one switch: the Dashboard's range buttons, reused for the holdings
	chart's ranges and a fund page's Transactions / Chart (same thing, same
	look). Links, so the choice is in the URL and the page's load re-runs on the server.
-->
<script lang="ts">
	let {
		label,
		items
	}: {
		/** What the switch chooses, for screen readers ("Range", "View"). */
		label: string;
		items: { href: string; label: string; current: boolean }[];
	} = $props();
</script>

<nav aria-label={label} class="inline-flex gap-0.5 rounded-control border border-border bg-card-2 p-0.75">
	{#each items as item (item.href)}
		<a
			href={item.href}
			aria-current={item.current ? 'true' : undefined}
			data-sveltekit-noscroll
			class="rounded-control px-3 py-1 text-body {item.current
				? 'bg-card font-normal text-foreground shadow-[0_1px_2px_rgba(0,0,0,0.06)] dark:bg-control-hover dark:shadow-none'
				: 'text-text-muted hover:bg-control hover:text-foreground'}">{item.label}</a
		>
	{/each}
</nav>
