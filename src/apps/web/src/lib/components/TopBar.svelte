<script lang="ts">
	import { onMount, tick, flushSync } from 'svelte';
	import Tooltip from '$lib/components/Tooltip.svelte';
	import Logomark from '$lib/components/Logomark.svelte';
	import SearchBox from '$lib/components/SearchBox.svelte';
	import AccountMenu from '$lib/components/AccountMenu.svelte';
	import MoreMenu from '$lib/components/MoreMenu.svelte';
	import { page } from '$app/state';
	import { trailFor } from '$lib/page-title';
	import { ArrowLeft, Menu, Plus } from '@lucide/svelte';
	import { Button } from '$lib/components/ui/button';

	// One title bar across the window (chrome B, Windows' title-bar guidance): the
	// mark in the corner, the pane toggle, Back and the page's path; the search at the window's exact
	// centre (three columns, the outer two equal); Add, you (AccountMenu), then the OS buttons' rect.
	// The page's one visible heading is its name in the path; a nested page puts the pages
	// above it first, each a link, and a Back arrow to the one just above. The page keeps an
	// sr-only <h1>.
	// Columns: the right one never narrower than its content (Add, "…", you and the OS buttons'
	// rect), so the search can't cover Add at 900 px (visual checks F1); the left one
	// keeps the mark, the pane toggle, Back and ~100 px of the page's name (224 px). While both sides have room they're equal and the search is
	// at the window's centre; short of room the search moves left, then shrinks, then becomes an icon
	// (SearchBox). It grows with the window like VS Code's command centre (36 % of it, 400 to 576 px).
	type Crumbs = { crumb?: string; crumbSection?: { label: string; href: string } };
	// An error page names itself, not the missing page's slug ("no-such-page"; F7).
	const trail = $derived(
		page.error
			? { name: page.status === 404 ? 'Page not found' : 'Error', parent: null, ancestors: [] }
			: trailFor(page.url.pathname, (page.data as Crumbs).crumb, (page.data as Crumbs).crumbSection)
	);

	const openQuickAdd = () => window.dispatchEvent(new CustomEvent('miserly:quickadd'));

	// The pane toggle sits here; Sidebar owns the pane and listens (it stamps <html data-pane>).
	let pane = $state('expanded');
	onMount(() => {
		const root = document.documentElement;
		const read = () => (pane = root.dataset.pane ?? 'expanded');
		read();
		const mo = new MutationObserver(read);
		mo.observe(root, { attributes: true, attributeFilter: ['data-pane'] });
		return () => mo.disconnect();
	});
	const paneLabel = $derived(
		pane === 'overlay' ? 'Close navigation' : pane === 'rail' ? 'Open navigation' : 'Collapse navigation'
	);
	const togglePane = () => window.dispatchEvent(new CustomEvent('miserly:pane-toggle'));

	// The path never wraps (Fluent 2's breadcrumb): short of room, the pages nearest the root fold
	// into "…" and the one just above stays ("… / Fixed deposits / SBI FD", the section says
	// more than "All accounts"), then only the current page shows. Measured, so it folds only when
	// it must.
	let fold = $state<'full' | 'mid' | 'cur'>('full');
	let pathEl = $state<HTMLElement | null>(null);
	function refit() {
		const el = pathEl;
		if (!el) return;
		// Over when the path overflows or the current page's name is cut: the name shrinks first
		// (it truncates), so overflow alone never fired and the middle never folded (F2).
		const over = () => {
			const cur = el.querySelector<HTMLElement>('[aria-current="page"]');
			return el.scrollWidth > el.clientWidth + 1 || (!!cur && cur.scrollWidth > cur.clientWidth + 1);
		};
		flushSync(() => (fold = 'full'));
		if (!over()) return;
		if (trail.ancestors.length > 1) {
			flushSync(() => (fold = 'mid'));
			if (!over()) return;
		}
		flushSync(() => (fold = 'cur'));
	}
	$effect(() => {
		if (!pathEl) return;
		const ro = new ResizeObserver(() => refit());
		ro.observe(pathEl);
		// The column too: a folded path is narrower than its room, so widening the window
		// left the path's own box unchanged and it never unfolded; the column follows the window.
		if (pathEl.parentElement) ro.observe(pathEl.parentElement);
		return () => ro.disconnect();
	});
	$effect(() => {
		void trail;
		void tick().then(refit);
	});
	const hidden = $derived(trail.ancestors.slice(0, -1));
</script>

<header
	id="app-topbar"
	tabindex="-1"
	data-region
	class="app-titlebar z-20 grid min-w-0 shrink-0 items-center gap-3 outline-none"
	style="height:var(--topbar-h);grid-template-columns:minmax(14rem,1fr) minmax(2rem,clamp(25rem,36vw,36rem)) minmax(min-content,1fr)"
>
	<div class="flex h-full min-w-0 items-center">
		<!-- The mark in the corner, over the rail's icon column; inert, so it drags the window and
		     right-click gives the system menu like the rest of the bar. -->
		<span class="grid h-full w-12 shrink-0 place-items-center" aria-hidden="true"><Logomark size={20} /></span>
		<Tooltip label={paneLabel} side="bottom">
			{#snippet child({ props })}
				<button
					{...props}
					id="app-pane-toggle"
					type="button"
					onclick={togglePane}
					aria-label={paneLabel}
					aria-controls="app-sidebar"
					aria-expanded={pane !== 'rail'}
					class="grid size-8 flex-none place-items-center rounded-control text-text-muted hover:bg-control-hover hover:text-text"
				>
					<Menu size={16} />
				</button>
			{/snippet}
		</Tooltip>
		<nav bind:this={pathEl} aria-label="Breadcrumb" class="ml-2 flex min-w-0 items-center overflow-hidden whitespace-nowrap">
			{#if trail.parent}
				<!-- Back is Up here (to the page above), so it sits with the path, as File Explorer's Up does. -->
				<a
					href={trail.parent.href}
					aria-label={`Back to ${trail.parent.label}`}
					class="inline-grid size-8 shrink-0 place-items-center rounded-control text-text-muted hover:bg-control-hover hover:text-text"
				>
					<ArrowLeft size={16} aria-hidden="true" />
				</a>
				{#if fold !== 'cur'}
					{#each trail.ancestors as c, i (c.href)}
						{#if fold === 'full' || i === trail.ancestors.length - 1}
							<a href={c.href} class="shrink-0 rounded-control px-1 py-1 text-body text-text-muted hover:bg-control-hover hover:text-text">{c.label}</a>
							<span class="mx-1.5 shrink-0 text-caption text-text-muted" aria-hidden="true">/</span>
						{:else if i === 0}
							<a
								href={hidden[hidden.length - 1]?.href}
								title={hidden.map((h) => h.label).join(' / ')}
								aria-label={hidden.map((h) => h.label).join(' / ')}
								class="shrink-0 rounded-control px-1.5 py-1 text-body text-text-muted hover:bg-control-hover hover:text-text">…</a
							>
							<span class="mx-1.5 shrink-0 text-caption text-text-muted" aria-hidden="true">/</span>
						{/if}
					{/each}
				{/if}
			{/if}
			<span class="min-w-0 truncate font-display text-body font-semibold tracking-[-0.01em] text-foreground" aria-current="page"
				>{trail.name}</span
			>
		</nav>
	</div>

	<SearchBox />

	<div class="flex h-full min-w-0 items-center justify-end gap-3">
		<Tooltip label="Add a transaction" shortcut="Ctrl+Shift+N">
			{#snippet child({ props })}
				<Button {...props} onclick={openQuickAdd} class="shrink-0">
					<Plus size={16} />
					Add
				</Button>
			{/snippet}
		</Tooltip>
		<MoreMenu />
		<AccountMenu />
		<!-- The OS draws min / max / close here (Window Controls Overlay, main.cjs); this keeps their
		     rect free inside the right column, so the search stays at the window's centre. -->
		<span class="wco-reserve" aria-hidden="true"></span>
	</div>
</header>
