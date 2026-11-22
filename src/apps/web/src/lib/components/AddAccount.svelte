<!--
  AddAccount.svelte — the launcher for the Add account dialog. The dialog opens
  over whatever page you are on, like Quick Add, instead of sending you to All accounts first;
  after Save you land in the new account. Like QuickAdd.svelte, the dialog body is fetched on
  first use so it adds nothing to every page's first load.
-->
<script lang="ts">
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { ADD_ACCOUNT_EVENT } from '$lib/add-account';

	let mounted = $state(false);
	let request = $state<{ type: string | null; seq: number } | null>(null);
	let seq = 0;
	function fire(type: string | null) {
		mounted = true;
		request = { type, seq: ++seq };
	}

	$effect(() => {
		const onOpen = (e: Event) => fire((e as CustomEvent<{ type?: string }>).detail?.type ?? null);
		window.addEventListener(ADD_ACCOUNT_EVENT, onOpen);
		return () => window.removeEventListener(ADD_ACCOUNT_EVENT, onOpen);
	});

	// `?add=1[&type=…]` on any page opens the dialog, then leaves the URL so a reload doesn't.
	$effect(() => {
		const params = page.url.searchParams;
		if (params.get('add') !== '1') return;
		fire(params.get('type'));
		const url = new URL(page.url);
		url.searchParams.delete('add');
		url.searchParams.delete('type');
		void goto(url.pathname + url.search, { replaceState: true, keepFocus: true, noScroll: true });
	});

	const body = () => import('./AddAccountBody.svelte');
</script>

{#if mounted}
	{#await body() then { default: Body }}
		<Body {request} />
	{/await}
{/if}
