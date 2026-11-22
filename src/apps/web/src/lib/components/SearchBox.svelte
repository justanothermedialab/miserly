<!--
  SearchBox.svelte — the title bar's search (chrome B): a real field you
  type into at the window's centre (Windows' title-bar guidance: "a searchbox ... centered to the
  window"), its results in a list attached beneath it, as Outlook's search does. It searches
  transactions (All transactions' ?q=) and jumps to pages, accounts, account groups and payees, and
  runs the few app commands (Add transaction, New transfer, Add account, a theme, Sign out). WAI-ARIA
  combobox: the field keeps focus, the arrows move the active option (aria-activedescendant).
  Each row has its icon (a page or account its sidebar one, a command the menus' one) and, where it has
  one, its shortcut at the right, as Linear's and VS Code's palettes.
-->
<script lang="ts">
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { ArrowLeftRight, KeyRound, LogOut, Monitor, Moon, Plus, Search, Sun } from '@lucide/svelte';
	import ColourIcon from '$lib/components/ColourIcon.svelte';
	import { fade } from 'svelte/transition';
	import { linear } from 'svelte/easing';
	import { applyTheme, type Theme } from '$lib/theme';
	import { openAddAccount } from '$lib/add-account';
	import { MODULE_PROFILES, sectionLabel } from '$lib/modules';

	type Item = {
		id: string; group: string; label: string; words: string; href?: string; run?: () => void;
		/** A colour icon key (pages, accounts) or a menu glyph (commands); the shortcut, if any. */
		icon?: string; glyph?: typeof Search; keys?: string;
	};
	type QA = { accounts: { id: string; name: string; label: string; type: string }[]; payees: { id: string; displayName: string }[] } | null;

	let query = $state('');
	let open = $state(false);
	let active = $state(0);
	let field = $state<HTMLInputElement | null>(null);
	let signOutForm = $state<HTMLFormElement | null>(null);

	const qa = $derived((page.data as { quickAdd?: QA }).quickAdd ?? null);
	const fire = (name: string) => () => window.dispatchEvent(new CustomEvent(name));
	const theme = (t: Theme) => () => applyTheme(t);
	const ORDER = new Map(MODULE_PROFILES.map((p, i) => [p.type, i]));

	const COMMANDS: Item[] = [
		{ id: 'c-add', group: 'Actions', label: 'Add transaction', words: 'add transaction new expense income', run: fire('miserly:quickadd'), glyph: Plus, keys: 'Ctrl+Shift+N' },
		{ id: 'c-transfer', group: 'Actions', label: 'New transfer', words: 'new transfer move money', run: fire('miserly:transfer'), glyph: ArrowLeftRight },
		{ id: 'c-account', group: 'Actions', label: 'Add account', words: 'add account new', run: () => openAddAccount(), glyph: Plus },
		{ id: 'c-inbox', group: 'Actions', label: 'To categorize', words: 'categorize inbox uncategorized', href: '/inbox', icon: 'inbox' }
	];
	const PAGES: Item[] = ([
		['/', 'Dashboard', 'home net worth', 'home'],
		['/transactions', 'All transactions', 'register ledger', 'transactions'],
		['/reports', 'Reports', 'charts spending income', 'reports'],
		['/accounts', 'All accounts', 'sections instruments manage', 'accounts'],
		['/categories', 'Categories', 'groups manage', 'categories'],
		['/payees', 'Payees', 'merchants merge manage', 'payees'],
		['/settings', 'Settings', 'preferences members rates accent', 'settings'],
		['/change-password', 'Change password', 'security', '']
	] as [string, string, string, string][]).map(([href, label, words, icon]) => ({
		id: `p-${href}`, group: 'Go to', label, words, href, ...(icon ? { icon } : { glyph: KeyRound })
	}));
	const MORE: Item[] = [
		...(['light', 'dark', 'black', 'system'] as Theme[]).map((t) => ({
			id: `t-${t}`, group: 'Theme', label: `Theme: ${t.charAt(0).toUpperCase()}${t.slice(1)}`, words: `theme mode appearance ${t}`, run: theme(t),
			glyph: t === 'light' ? Sun : t === 'system' ? Monitor : Moon
		})),
		{ id: 'c-signout', group: 'Account', label: 'Sign out', words: 'sign out log out logout', run: () => signOutForm?.requestSubmit(), glyph: LogOut }
	];

	const PER_GROUP = 6;
	const items = $derived.by((): Item[] => {
		const q = query.trim().toLowerCase();
		if (!q) return [...COMMANDS, ...PAGES];
		const hit = (i: Item) => `${i.label} ${i.words}`.toLowerCase().includes(q);
		const accounts = qa?.accounts ?? [];
		const groups = [...new Set(accounts.map((a) => a.type))]
			.sort((x, y) => (ORDER.get(x) ?? 99) - (ORDER.get(y) ?? 99))
			.map((type): Item => ({ id: `g-${type}`, group: 'Account groups', label: sectionLabel(type), words: 'section group', href: `/sections/${type}`, icon: type }));
		const acc = accounts.map((a): Item => ({ id: `a-${a.id}`, group: 'Accounts', label: a.label, words: `account ${a.name}`, href: `/accounts/${a.id}`, icon: a.type }));
		const payees = (qa?.payees ?? []).map((p): Item => ({
			id: `y-${p.id}`, group: 'Payees', label: p.displayName, words: 'payee', href: `/transactions?q=${encodeURIComponent(p.displayName)}`, icon: 'payees'
		}));
		const out: Item[] = [{ id: 'search', group: 'Transactions', label: `Search transactions for “${query.trim()}”`, words: '', href: `/transactions?q=${encodeURIComponent(query.trim())}`, glyph: Search }];
		for (const list of [acc, payees, COMMANDS, PAGES, groups, MORE]) out.push(...list.filter(hit).slice(0, PER_GROUP));
		return out;
	});
	// The list in its groups, each option keeping its place in `items` for the arrow keys.
	const grouped = $derived.by(() => {
		const out: { group: string; rows: { item: Item; n: number }[] }[] = [];
		items.forEach((item, n) => {
			const last = out[out.length - 1];
			if (last && last.group === item.group) last.rows.push({ item, n });
			else out.push({ group: item.group, rows: [{ item, n }] });
		});
		return out;
	});

	// Short of room (its column under 200 px: heavy zoom at the minimum width) the field becomes a
	// search icon; focusing it (a click, Ctrl K) opens the field over the title bar's centre.
	let root = $state<HTMLElement | null>(null);
	let compact = $state(false);
	let focused = $state(false);
	$effect(() => {
		if (!root || typeof ResizeObserver === 'undefined') return;
		const el = root;
		const ro = new ResizeObserver(() => (compact = el.clientWidth < 200));
		ro.observe(el);
		return () => ro.disconnect();
	});
	const floating = $derived(compact && focused);
	// The list leaves with Windows' bare-minimum fade (83 ms, linear); it enters like a menu (CSS
	// classes, so reduced motion applies). Svelte's out transition is script-driven: check the media.
	const exitMs = () => (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 83);

	function choose(item: Item) {
		open = false;
		query = '';
		active = 0;
		if (item.href) {
			field?.blur();
			void goto(item.href);
		} else item.run?.();
	}
	function onKey(e: KeyboardEvent) {
		if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			e.preventDefault();
			open = true;
			const d = e.key === 'ArrowDown' ? 1 : -1;
			active = (active + d + items.length) % items.length;
			document.getElementById(`app-search-${items[active]?.id}`)?.scrollIntoView({ block: 'nearest' });
		} else if (e.key === 'Enter') {
			const item = items[active];
			if (open && item) {
				e.preventDefault();
				choose(item);
			}
		} else if (e.key === 'Escape') {
			// First Escape closes the list, a second clears the field (a search box's convention).
			if (open) open = false;
			else query = '';
			e.preventDefault();
		}
	}
</script>

<div
	bind:this={root}
	class="relative w-full min-w-0"
	onfocusin={() => (focused = true)}
	onfocusout={(e) => {
		if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)) {
			open = false;
			focused = false;
		}
	}}
>
	<div class={floating ? 'fixed left-1/2 top-2 z-50 -translate-x-1/2' : 'relative'} style={floating ? 'width:min(25rem,calc(100vw - 2rem))' : undefined}>
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="flex h-8 min-w-0 items-center gap-2 rounded-control border border-border bg-surface text-body focus-within:border-b-2 focus-within:border-b-brand-mark hover:border-border-strong {compact && !focused ? 'w-8 cursor-pointer justify-center px-0' : 'w-full px-3'}"
			onpointerdown={(e) => {
				if (compact && !focused) {
					e.preventDefault();
					field?.focus();
				}
			}}
		>
			<Search size={14} class="shrink-0 text-text-muted" aria-hidden="true" />
			<input
				bind:this={field}
				id="app-search"
				type="text"
				role="combobox"
				autocomplete="off"
				spellcheck="false"
				aria-label="Search or jump to"
				aria-expanded={open}
				aria-controls="app-search-list"
				aria-activedescendant={open && items[active] ? `app-search-${items[active]?.id}` : undefined}
				placeholder="Search or jump to…"
				bind:value={query}
				onfocus={() => (open = true)}
				onclick={() => (open = true)}
				oninput={() => {
					open = true;
					active = 0;
				}}
				onkeydown={onKey}
				class="h-full bg-transparent text-foreground outline-none placeholder:text-text-muted {compact && !focused ? 'w-0 flex-none' : 'min-w-0 flex-1'}"
			/>
			{#if !query && !compact}
				<span class="shrink-0 whitespace-nowrap rounded-control border border-border border-b-2 bg-surface-2 px-2 py-px text-caption text-text-muted" aria-hidden="true">Ctrl K</span>
			{/if}
		</div>
		{#if open}
			<div
				id="app-search-list"
				role="listbox"
				aria-label="Results"
				tabindex="-1"
				out:fade={{ duration: exitMs(), easing: linear }}
				class="absolute inset-x-0 top-full z-50 mt-1 animate-in overflow-y-auto rounded-overlay border border-border bg-popover p-1 text-popover-foreground shadow-[var(--shadow-pop)] fade-in-0 slide-in-from-top-2 motion-fast ease-decelerate"
				style="max-height:min(60vh,28rem)"
			>
				{#each grouped as g (g.group)}
					<div role="group" aria-label={g.group}>
						<div class="px-2 pb-0.5 pt-1.5 text-caption text-text-muted">{g.group}</div>
						{#each g.rows as { item, n } (item.id)}
							<div
								id={`app-search-${item.id}`}
								role="option"
								tabindex="-1"
								aria-selected={n === active}
								class="flex cursor-default items-center gap-2 rounded-control px-2 py-1.5 text-body {n === active ? 'bg-control-hover' : ''}"
								onpointermove={() => (active = n)}
								onpointerdown={(e) => e.preventDefault()}
								onclick={() => choose(item)}
								onkeydown={() => {}}
							>
								{#if item.icon}<ColourIcon name={item.icon} size={16} />{:else if item.glyph}<item.glyph size={16} class="flex-none" aria-hidden="true" />{/if}
								<span class="min-w-0 flex-1 truncate">{item.label}</span>
								{#if item.keys}<kbd class="flex-none font-sans text-caption text-text-muted">{item.keys}</kbd>{/if}
							</div>
						{/each}
					</div>
				{/each}
			</div>
		{/if}
	</div>
	<form bind:this={signOutForm} method="POST" action="/signout" hidden></form>
</div>
