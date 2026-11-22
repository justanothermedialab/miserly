<script lang="ts">
	import StatusBar from '$lib/components/StatusBar.svelte';
	let { trigger = {}, intent = 'success' }: { trigger?: unknown; intent?: 'success' | 'error' } =
		$props();
</script>

<StatusBar {trigger} {intent}>Display preferences saved.</StatusBar>
