<!--
  QuickAdd.svelte — the LAUNCHER shell (kept intentionally tiny + dependency-free).
  ============================================================================
  The heavy quick-add surface (the Add transaction dialog, laid out like a register row, and its
  pickers) lives in QuickAddBody.svelte and is DYNAMICALLY IMPORTED on the first activation, so
  it doesn't ship in every authenticated page's first-load / hydration bundle (the old command
  palette there dominated the per-page floor and delayed interactivity).

  This launcher owns only: the global keyboard shortcut (<svelte:window>), the
  TopBar window events (miserly:quickadd / miserly:transfer), and a monotonic
  `request` it hands the body. Once activated, the body stays mounted (so the
  dialog opens instantly thereafter); before that, none of its code is on the page's
  synchronous path.
-->
<script lang="ts">
	import { globalAccelerator, trackAltKey } from '$lib/shortcuts';
	interface Account { id: string; name: string; label: string; type: string; currency: string }
	interface Group { id: string; name: string; categories: { id: string; name: string }[] }
	interface Payee { id: string; displayName: string; nameNormalized: string; rememberedCategoryId: string | null }

	let {
		accounts,
		categoryGroups,
		payees,
		transferCategories
	}: { accounts: Account[]; categoryGroups: Group[]; payees: Payee[]; transferCategories: Record<string, string> } = $props();

	// Once the user first activates quick-add, mount (and thereby fetch) the body.
	let mounted = $state(false);
	// A fresh object per fire (monotonic seq) so the body's reacting $effect re-runs
	// even for a repeated same-kind activation.
	type QuickAddRequest = { kind: 'transaction' | 'transfer' | 'close'; seq: number };
	let request = $state<QuickAddRequest | null>(null);
	let seq = 0;
	function fire(kind: QuickAddRequest['kind']): void {
		mounted = true;
		request = { kind, seq: ++seq };
	}
	/** Ctrl K: the title bar's search field (chrome B), typed into in place. */
	function focusSearch(): void {
		const field = document.getElementById('app-search') as HTMLInputElement | null;
		field?.focus();
		field?.select();
	}

	/** Another app dialog (a confirm, the member form...) is open: it keeps the keyboard, so
	 *  the global shortcuts must not stack Quick Add or the palette on top of it (hunt H-modal-A).
	 *  Quick Add's own dialogs hold its capture form or the command list. */
	function foreignDialogOpen(): boolean {
		// An open menu or list holds the keyboard too (Windows doesn't run accelerators while a
		// menu is open); otherwise the palette opened under a still-open account menu.
		if (document.querySelector('[data-slot=dropdown-menu-content], [data-slot=select-content]')) return true;
		return [...document.querySelectorAll('[data-slot=dialog-content][data-state=open], [role=alertdialog]')].some(
			(d) => !d.querySelector('[data-command-root], form[action^="/capture"]')
		);
	}

	function onGlobalKeydown(e: KeyboardEvent): void {
		// N, Ctrl+N, Ctrl+F, Ctrl+Z (Q17): $lib/shortcuts.
		if (globalAccelerator(e, { quickAdd: () => fire('transaction'), palette: focusSearch, blocked: foreignDialogOpen })) return;
		const mod = e.metaKey || e.ctrlKey;
		if (mod && (e.key === 'N' || e.key === 'n' || e.key === 'k' || e.key === 'K') && foreignDialogOpen()) return;
		if (mod && e.shiftKey && (e.key === 'N' || e.key === 'n')) {
			e.preventDefault();
			fire('transaction');
		} else if (mod && !e.shiftKey && (e.key === 'k' || e.key === 'K')) {
			e.preventDefault();
			focusSearch();
		} else if (e.key === 'Escape' && mounted && !e.defaultPrevented) {
			// A Bits layer (select list, calendar, dialog) that handled this Escape has already
			// called preventDefault; closing everything here would also shut Quick Add.
			fire('close');
		}
	}

	// Access-key letters show while Alt is held (Windows convention).
	$effect(() => trackAltKey());

	// The persistent chrome (TopBar) hosts the "+ Add" button and the Ctrl-K search;
	// they reach this globally-mounted surface via window events (the FAB is gone).
	$effect(() => {
		const openQA = () => fire('transaction');
		const openTr = () => fire('transfer');
		window.addEventListener('miserly:quickadd', openQA);
		window.addEventListener('miserly:transfer', openTr);
		return () => {
			window.removeEventListener('miserly:quickadd', openQA);
			window.removeEventListener('miserly:transfer', openTr);
		};
	});

	// Memoized dynamic import: fetch the body chunk once, on first activation.
	let _body: Promise<typeof import('./QuickAddBody.svelte')> | undefined;
	const body = () => (_body ??= import('./QuickAddBody.svelte'));
</script>

<svelte:window onkeydown={onGlobalKeydown} />

{#if mounted}
	{#await body() then { default: Body }}
		<Body {accounts} {categoryGroups} {payees} {transferCategories} {request} />
	{/await}
{/if}
