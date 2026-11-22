<!--
	The error page (visual checks F7): SvelteKit's bare "404 / Not Found" had no message
	and no way back. Like an empty state: a line, a sentence, one action (Teams and Outlook's error
	pages). A missing page goes to the Dashboard; anything else offers to try again.
-->
<script lang="ts">
	import { page } from '$app/state';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import { Button } from '$lib/components/ui/button';

	const missing = $derived(page.status === 404);
</script>

<h1 class="sr-only">{missing ? 'Page not found' : 'Something went wrong'}</h1>
{#if missing}
	<EmptyState title="Page not found" text="It may have been deleted, or the link is wrong.">
		{#snippet action()}<Button href="/" variant="outline">Go to Dashboard</Button>{/snippet}
	</EmptyState>
{:else}
	<EmptyState title="Something went wrong" text="Try again. If it keeps happening, restart Miserly.">
		{#snippet action()}<Button variant="outline" onclick={() => location.reload()}>Try again</Button>{/snippet}
	</EmptyState>
{/if}
