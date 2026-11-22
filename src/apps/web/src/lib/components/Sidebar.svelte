<script lang="ts">
	import { foldIn, foldOut } from '$lib/motion';
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { afterNavigate } from '$app/navigation';
	import { useMoney } from '$lib/format-context';
	import { levelToneClass, formatShare } from '$lib/format';
	import Tooltip from '$lib/components/Tooltip.svelte';
	import { fluentScroll } from '$lib/fluent-scroll';
	import { navKeys } from '$lib/nav-keys';
	import { openAddAccount } from '$lib/add-account';
	import { ChevronDown, Menu, Plus } from '@lucide/svelte';
	import ColourIcon from '$lib/components/ColourIcon.svelte';
	import Logomark from '$lib/components/Logomark.svelte';
	import Figure from '$lib/components/Figure.svelte';

	type NavAccount = { id: string; name: string; sharePaise: number; shareBp: number | null; currency: string };
	type NavSection = {
		type: string;
		label: string;
		subtotalPaise: number;
		rateNeeded: boolean;
		collapsed: boolean;
		accounts: NavAccount[];
	};
	type Nav = {
		hasOpenAccounts: boolean;
		netWorthPaise: number;
		rateNeededCurrencies: string[];
		monthChange: { absPaise: number; pct: number | null } | null;
		sections: NavSection[];
	};

	let {
		nav,
		user,
		inboxCount,
		baseCurrency
	}: {
		nav: Nav | null;
		user: { username: string; displayName?: string; role?: string } | null;
		inboxCount: number;
		baseCurrency: string;
	} = $props();

	const m = useMoney();
	// The sidebar is a summary (SET1 RD5): whole rupees on its rows, rounded to the nearest rupee, so
	// no label truncates at 280 px (DESIGN-360 §11.2: 2 labels cut with paise, 0 without). Registers
	// and pages keep the exact amount.
	const wholeMoney = (paise: number, opts?: { compact?: boolean; currency?: string }): string =>
		m.money(Math.round(paise / 100) * 100, opts).replace(/\.00(?!\d)/, '');

	// Nav and module icons are Fluent's colour set (item 3 direction B): colour on
	// identity, never on money ($lib/icons/colour). A module type is its own icon key.

	const PRIMARY = [
		{ id: 'dashboard', label: 'Dashboard', href: '/', icon: 'home' },
		{ id: 'transactions', label: 'All transactions', href: '/transactions', icon: 'transactions' },
		{ id: 'reports', label: 'Reports', href: '/reports', icon: 'reports' },
		{ id: 'inbox', label: 'To categorize', href: '/inbox', icon: 'inbox' }
	];

	// Categories and Payees live in the account menu (they are visited rarely and
	// free two rows at the pane's foot). Every destination must stay linked somewhere: the desktop
	// app has no address bar.
	const MANAGE = [
		{ id: 'categories', label: 'Categories', href: '/categories', icon: 'categories' },
		{ id: 'payees', label: 'Payees', href: '/payees', icon: 'payees' }
	];
	// Settings has ONE entry: the account menu at the bottom of the pane,
	// plus the Ctrl K palette.

	const path = $derived(page.url.pathname);
	function primaryActive(href: string): boolean {
		return href === '/' ? path === '/' : path.startsWith(href);
	}
	const sectionActive = (type: string): boolean => path === `/sections/${type}`;
	const accountActive = (id: string): boolean => path === `/accounts/${id}`;

	// Collapsed sections (S1 RD7): the server renders them from a cookie (derived from `nav`,
	// not set in an effect, which never runs on the server), so nothing flashes open on load.
	// A toggle overrides the server's value here and updates the cookie for the next load.
	let toggled = $state<Record<string, boolean>>({});
	const isCollapsed = (s: NavSection): boolean => toggled[s.type] ?? s.collapsed;
	function toggleSection(s: NavSection) {
		toggled = { ...toggled, [s.type]: !isCollapsed(s) };
		const opened = (nav?.sections ?? []).filter((x) => !isCollapsed(x)).map((x) => x.type);
		// A session cookie (no max-age): every launch starts with the groups folded.
		document.cookie = `miserly_nav_open=${opened.join('.')}; path=/; samesite=lax`;
	}
	// /accounts/<id> is a register (reached from a section), not the Accounts list.
	const manageActive = (href: string): boolean => path === href;

	// Fluent NavigationView item: neutral veil on hover, a subtle fill + a 3px gold
	// indicator pill in the gutter (left:-4px) when selected — the accent is the
	// indicator, never a gold-tinted row.
	// 36 px in the rail too (its rows were 32, so every icon moved between the two states).
	const navItem =
		'group relative flex items-center gap-3 rounded-control px-3 py-2 text-body font-normal text-text-muted transition-colors hover:bg-control hover:text-foreground rail:min-h-9 rail:justify-center rail:px-0';
	// Rail mode (<1100px): text stays in the accessibility tree, off screen. It fades as the pane
	// narrows and once it has mostly opened (`.pane-text`).
	const railText = 'pane-text rail:sr-only';
	const navItemActive =
		"bg-control-hover text-foreground before:absolute before:-left-1 before:top-2.25 before:bottom-2.25 before:w-0.75 before:rounded-full before:bg-brand-mark before:content-['']";

	const groupLabel =
		'px-3 pb-2 pt-4 text-caption font-normal text-text-muted';

	// NavigationView pane. One attribute on <html> drives it: `expanded` (full pane),
	// `rail` (48px icons) or `overlay` (full pane floating over the content). app.html sets it
	// before first paint from the saved choice; the `rail:` variant in app.css keys off it.
	// Wide windows: the menu button collapses / expands the pane and the choice persists.
	// Below 1100px the pane is a rail and the button opens the full pane as an overlay.
	type Pane = 'expanded' | 'rail' | 'overlay';
	const PANE_KEY = 'miserly:pane';
	const NARROW = '(max-width: 1099px)';
	let pane = $state<Pane>('expanded');
	let railTimer: ReturnType<typeof setTimeout> | undefined;
	function setPane(p: Pane) {
		clearTimeout(railTimer);
		clearTimeout(closeTimer);
		closing = false;
		pane = p;
		const root = document.documentElement;
		root.dataset.pane = p;
		delete root.dataset.paneW;
		delete root.dataset.paneClosing;
	}
	/** The overlay pane leaves as it came (it opened with the slide and closed in one
	 *  frame): it slides back into the rail over 167 ms on the docked collapse's curve, then the rail layout
	 *  applies. Opening again mid-slide cancels it (setPane). */
	let closing = $state(false);
	let closeTimer: ReturnType<typeof setTimeout> | undefined;
	function slideOverlayShut() {
		if (closing) return;
		if (matchMedia('(prefers-reduced-motion: reduce)').matches) return setPane('rail');
		closing = true;
		document.documentElement.dataset.paneClosing = '';
		closeTimer = setTimeout(() => setPane('rail'), 167);
	}
	/** Narrow the column now (it glides 167 ms, the pane clipped with it), switch to the
	 *  rail layout when the slide ends, so labels are cut off by the edge, not removed first. */
	function slideToRail() {
		if (matchMedia('(prefers-reduced-motion: reduce)').matches) return setPane('rail');
		document.documentElement.dataset.paneW = 'rail';
		clearTimeout(railTimer);
		railTimer = setTimeout(() => setPane('rail'), 167);
	}
	// The page resizes with the pane on every frame. M9's width freeze laid
	// it out once at the slide's start instead, which made right-aligned figures and full-width content
	// jump 232 px in one frame; drawing only the rows in view made per-frame layout cheap (17 ms frames
	// on a 2,452-row register, the same as frozen; tests/benchmark/pane-frames.mjs NOFREEZE=1).
	function collapsedPref(): boolean {
		try {
			return localStorage.getItem(PANE_KEY) === 'collapsed';
		} catch {
			return false;
		}
	}
	function settle() {
		const to = collapsedPref() || matchMedia(NARROW).matches ? 'rail' : 'expanded';
		// An open overlay closing to the rail slides shut; widening past 1,100 px docks it at once.
		if (pane === 'overlay' && to === 'rail') return slideOverlayShut();
		setPane(to);
	}
	function togglePane() {
		if (matchMedia(NARROW).matches) {
			if (pane === 'overlay' && !closing) return settle();
			setPane('overlay');
			// WinUI moves focus into an opened overlay pane: if it's still in the covered page
			// (the pane opened without its menu button taking focus), land it on the selected
			// item, else the first one.
			const aside = document.getElementById('app-sidebar');
			if (pane === 'overlay' && aside && !aside.contains(document.activeElement)) {
				(aside.querySelector<HTMLElement>('a[aria-current=page]') ?? aside.querySelector<HTMLElement>('a[href]'))?.focus();
			}
			return;
		}
		const collapse = pane === 'expanded';
		try {
			localStorage.setItem(PANE_KEY, collapse ? 'collapsed' : 'expanded');
		} catch {
			// Storage unavailable: the choice lasts for this session only.
		}
		if (collapse) slideToRail();
		else setPane('expanded');
	}

	// The open pane's width (DESIGN-360 §7 (d)): drag the edge from 240 px to a third
	// of the window (Actual's range, its 240 default kept at our 280), remembered on this device;
	// double-click resets. Figures show on every row or on none: see
	// `figuresAllOrNone`.
	const PANE_W_KEY = 'miserly:pane-w';
	const MIN_W = 240;
	const DEFAULT_W = 280;
	// `innerWidth` exists only in the browser: the server renders the handle too (it crashed every
	// signed-in page with a 500 when this read it unguarded).
	const maxW = () => Math.max(MIN_W, Math.floor((typeof window === 'undefined' ? 3 * 480 : window.innerWidth) / 3));
	const clampW = (w: number) => Math.round(Math.max(MIN_W, Math.min(w, maxW())));
	let openW = $state(DEFAULT_W);
	function applyW(w: number, save = false) {
		openW = clampW(w);
		document.documentElement.style.setProperty('--sidebar-open', `${openW}px`);
		if (save) {
			try {
				localStorage.setItem(PANE_W_KEY, String(openW));
			} catch {
				// Storage unavailable: the width lasts for this session.
			}
		}
	}
	let drag: { x: number; w: number } | null = null;
	function dragStart(e: PointerEvent) {
		if (e.button !== 0) return;
		e.preventDefault();
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		drag = { x: e.clientX, w: openW };
		document.documentElement.dataset.resizing = '';
	}
	function dragMove(e: PointerEvent) {
		if (drag) applyW(drag.w + e.clientX - drag.x);
	}
	function dragEnd() {
		if (!drag) return;
		drag = null;
		delete document.documentElement.dataset.resizing;
		applyW(openW, true);
	}
	function sizeKey(e: KeyboardEvent) {
		const to = e.key === 'ArrowLeft' ? openW - 16 : e.key === 'ArrowRight' ? openW + 16 : e.key === 'Home' ? MIN_W : e.key === 'End' ? maxW() : null;
		if (to === null) return;
		e.preventDefault();
		applyW(to, true);
	}
	onMount(() => {
		const saved = Number.parseInt(document.documentElement.style.getPropertyValue('--sidebar-open'), 10);
		if (saved) openW = saved;
		settle();
		const mq = matchMedia(NARROW);
		mq.addEventListener('change', settle);
		// The pane toggle is in the title bar now (TopBar, chrome B); it asks by event.
		window.addEventListener('miserly:pane-toggle', togglePane);
		return () => {
			mq.removeEventListener('change', settle);
			window.removeEventListener('miserly:pane-toggle', togglePane);
		};
	});
	afterNavigate(() => {
		if (pane === 'overlay') settle();
	});
	function onPaneKey(e: KeyboardEvent) {
		if (e.key === 'Escape' && pane === 'overlay' && !e.defaultPrevented) {
			e.preventDefault();
			settle();
		}
	}
	/** Closes the overlay pane and hands focus to the title bar's menu button, as the pane's own
	 *  button and the page beside it are gone or covered once it closes (hunt H-ov-B). */
	function closeOverlay() {
		settle();
		document.getElementById('app-pane-toggle')?.focus();
	}
	/** Light dismiss in the title bar: a press there, right of the pane, closes the pane and
	 *  still does its own thing at once (search, Add, the menus). A drag of the bar never reaches the
	 *  page, so moving the window keeps the pane open. */
	function onWindowPointerDown(e: PointerEvent) {
		if (pane !== 'overlay') return;
		const t = e.target as Node | null;
		if (t && document.getElementById('app-topbar')?.contains(t)) settle();
	}

	/** Figures on every row or on none. Each `.fit-row` wraps its figure
	 *  out of sight when it would cut the name; once any row does, every figure is hidden
	 *  (`data-figures="off"`, visibility only, so the rows keep their layout and the check still works
	 *  as the pane widens again). Browser only: an action never runs in the server render. */
	function figuresAllOrNone(node: HTMLElement) {
		let raf = 0;
		const check = () => {
			cancelAnimationFrame(raf);
			raf = requestAnimationFrame(() => {
				const clipped = [...node.querySelectorAll<HTMLElement>('.fit-row')].some((row) => {
					const name = row.firstElementChild as HTMLElement | null;
					const fig = row.lastElementChild as HTMLElement | null;
					return !!name && !!fig && name !== fig && fig.offsetTop > name.offsetTop;
				});
				if (clipped) node.dataset.figures = 'off';
				else delete node.dataset.figures;
			});
		};
		const ro = new ResizeObserver(check);
		const watch = () => {
			ro.disconnect();
			ro.observe(node);
			node.querySelectorAll('.fit-row').forEach((row) => ro.observe(row));
			check();
		};
		const mo = new MutationObserver(watch);
		mo.observe(node, { childList: true, subtree: true, characterData: true });
		watch();
		return {
			destroy() {
				ro.disconnect();
				mo.disconnect();
				cancelAnimationFrame(raf);
			}
		};
	}


</script>

<svelte:window onkeydown={onPaneKey} onpointerdowncapture={onWindowPointerDown} />

{#if pane === 'overlay'}
	<!-- Light dismiss behind the overlay pane: clear, not a dimming scrim, and over the page
	     only; the title bar closes the pane on its own (onWindowPointerDown) so its clicks act at once.
	     A click on the page closes the pane without reaching it. -->
	<div class="fixed inset-x-0 top-(--topbar-h) bottom-0 z-40 {closing ? 'pointer-events-none' : ''}" aria-hidden="true" onclick={closeOverlay}></div>
{/if}

<aside use:navKeys use:figuresAllOrNone
	id="app-sidebar"
	tabindex="-1"
	data-region
	aria-label="Navigation"
	class="relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden outline-none"
	style="background:var(--base)"
>
	{#if pane === 'expanded'}
		<!-- The pane's edge: drag to resize, double-click to reset, arrow keys from the keyboard. A
		     focusable separator with a value is WAI-ARIA's window splitter; Svelte's lint can't tell. -->
		<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
		<div
			role="separator"
			aria-orientation="vertical"
			aria-label="Resize navigation"
			aria-valuemin={MIN_W}
			aria-valuemax={maxW()}
			aria-valuenow={openW}
			tabindex="0"
			class="group absolute inset-y-0 right-0 z-10 w-1.5 cursor-col-resize outline-none"
			onpointerdown={dragStart}
			onpointermove={dragMove}
			onpointerup={dragEnd}
			onpointercancel={dragEnd}
			ondblclick={() => applyW(DEFAULT_W, true)}
			onkeydown={sizeKey}
		>
			<span class="absolute inset-y-0 right-0 w-0.5 bg-transparent transition-colors group-hover:bg-border-strong group-focus-visible:bg-[var(--focus-outer)] group-active:bg-border-strong"></span>
		</div>
	{/if}
	{#if pane === 'overlay'}
		<!-- The overlay pane's head, over the title bar (option D): the mark and the menu button
		     in the title bar's exact spots and markup (TopBar), so nothing moves when the pane opens; the
		     rest of it drags the window as the title bar does. -->
		<div class="app-drag flex shrink-0 items-center" style="height:var(--topbar-h)">
			<span class="grid h-full w-12 shrink-0 place-items-center" aria-hidden="true"><Logomark size={20} /></span>
			<Tooltip label="Close navigation" side="bottom">
				{#snippet child({ props })}
					<button
						{...props}
						type="button"
						onclick={closeOverlay}
						aria-label="Close navigation"
						aria-controls="app-sidebar"
						aria-expanded="true"
						class="grid size-8 flex-none place-items-center rounded-control text-text-muted hover:bg-control-hover hover:text-text"
					>
						<Menu size={16} />
					</button>
				{/snippet}
			</Tooltip>
		</div>
	{/if}
	<!-- net-worth hero, first under the title bar (chrome B, the mark, the pane
	     toggle and the path moved up into the full-width title bar). -->
	<!-- The rail drops it: it folds over the slide (`.pane-fold`), so the icons below glide. -->
	<div class="pane-fold min-w-(--sidebar-open) rail:min-w-0">
		<div>
		<div class="pane-text border-b border-divider px-5 pb-4 pt-4 rail:hidden">
		{#if nav && nav.hasOpenAccounts}
			<div class="text-caption font-normal text-text-muted">
				Net worth
			</div>
			<!-- 20 px, not 28: each page's own headline is the biggest figure on screen (DESIGN-360 §11.2). -->
			<div class="num font-display mt-0.75 text-subtitle font-semibold tracking-[-0.01em] {levelToneClass(nav.netWorthPaise)}">
				<Figure text={m.money(nav.netWorthPaise, { compact: m.compact })} />
			</div>
			{#if nav.monthChange}
				{@const up = nav.monthChange.absPaise >= 0}
				<div class="mt-0.75 text-body font-normal {up ? 'text-pos' : 'text-neg'}">
					{up ? '+' : '−'}{wholeMoney(Math.abs(nav.monthChange.absPaise), { compact: m.compact })} this month
				</div>
			{/if}
		{:else}
			<div class="text-caption font-normal text-text-muted">
				Net worth
			</div>
			<div class="num font-display mt-0.75 text-subtitle font-semibold tracking-[-0.01em]">
				{wholeMoney(0, { compact: m.compact })}
			</div>
			<div class="mt-0.5 text-caption text-text-muted">Add your first account to begin</div>
		{/if}
		</div>
		</div>
	</div>

	<!-- scroll: nav + sections -->
	<div use:fluentScroll class="min-w-(--sidebar-open) flex-1 overflow-y-auto px-1 pt-3 pb-4 rail:min-w-0">
		<div>
			{#each PRIMARY as it (it.id)}
				<Tooltip label={it.label} side="right" disabled={pane !== 'rail'}>
					{#snippet child({ props })}
						<a
							{...props}
							href={it.href} data-sveltekit-keepfocus
							class="{navItem} {primaryActive(it.href) ? navItemActive : ''}"
							aria-current={primaryActive(it.href) ? 'page' : undefined}
						>
							<ColourIcon name={it.icon} class="-m-px" />
							<span class={railText}>{it.label}</span>
							{#if it.id === 'inbox' && inboxCount > 0}
								<!-- Two badges: the pane's fades with its label; the rail's sits on the icon
								     and fades in once the rail lands, so neither jumps across the slide. -->
								<span
									class="pane-text ml-auto inline-flex min-w-5 items-center justify-center rounded-full bg-brand px-2 text-caption font-semibold text-[var(--primary-foreground)] rail:sr-only"
									aria-label={`${m.count(inboxCount)} to categorize`}
								>{m.count(inboxCount)}</span>
								<span
									class="pane-rail-only pointer-events-none absolute top-0 right-0.5 inline-flex min-w-4 items-center justify-center rounded-full bg-brand px-1 text-caption font-semibold text-[var(--primary-foreground)]"
									aria-hidden="true"
								>{m.count(inboxCount)}</span>
							{/if}
						</a>
					{/snippet}
				</Tooltip>
			{/each}
		</div>

		<!-- The accounts lead the scroll area (accounts are the focus). Add account
		     sits on the group's header as a + (Gmail's Labels, Outlook's Folders, Quicken's account
		     bar), so it never scrolls away; All accounts heads the list (Actual, YNAB). -->
		<div class="pane-fold">
			<div>
				<div class="{groupLabel} pane-text mt-2 flex items-center rail:sr-only">
					<span>Accounts</span>
					<Tooltip label="Add account" side="right">
						{#snippet child({ props })}
							<button {...props} type="button" onclick={() => openAddAccount()} aria-label="Add account"
								class="-my-1 -mr-2 ml-auto grid size-7 place-items-center rounded-control text-text-muted hover:bg-control-hover hover:text-foreground">
								<Plus size={16} aria-hidden="true" />
							</button>
						{/snippet}
					</Tooltip>
				</div>
			</div>
		</div>
		<Tooltip label="All accounts" side="right" disabled={pane !== 'rail'}>
			{#snippet child({ props })}
				<a
					{...props}
					href="/accounts" data-sveltekit-keepfocus
					class="{navItem} {manageActive('/accounts') ? navItemActive : ''}"
					aria-current={manageActive('/accounts') ? 'page' : undefined}
				>
					<ColourIcon name="accounts" class="-m-px" />
					<span class={railText}>All accounts</span>
				</a>
			{/snippet}
		</Tooltip>

		{#if nav && nav.sections.length > 0}
			{#each nav.sections as sec (sec.type)}
				{@const open = !isCollapsed(sec)}
				<!-- The whole row folds and unfolds its group, as accordion
				     headers do in YNAB's sidebar and on phones; the section page is reached from All
				     accounts, the register header and Ctrl K. The chevron sits where the separate
				     toggle did (same pixels). In the 48 px rail nothing can fold, so there the row
				     stays a link to the section page. -->
				<button
					type="button"
					data-section-toggle
					onclick={() => toggleSection(sec)}
					aria-expanded={open}
					class="{navItem} w-full text-left rail:hidden {sectionActive(sec.type) ? navItemActive : ''}"
				>
					<ColourIcon name={sec.type} class="-m-px" />
					<!-- A group keeps its subtotal open or folded (as YNAB and Actual's sidebar
					     do); figures show on every row or none (figuresAllOrNone). -->
					<span class="fit-row pane-text">
						<span>{sec.label}</span>
						<span class="num text-body font-normal {sec.rateNeeded ? 'text-text-muted' : levelToneClass(sec.subtotalPaise)}">
							{#if sec.rateNeeded}<span aria-hidden="true">–</span><span class="sr-only">Rate needed</span>{:else}{wholeMoney(sec.subtotalPaise, { compact: m.compact })}{/if}
						</span>
					</span>
					<!-- -my-1: the 28 px target doesn't make the row taller than its 36 px neighbours (its
					     group rows were 44, the rail's links 36, so the icons moved between the states). -->
					<span class="pane-text -my-1 -mr-2 -ml-2 grid size-7 flex-none place-items-center text-text-muted" aria-hidden="true">
						<ChevronDown size={14} class="transition-transform motion-fast ease-decelerate {open ? '' : '-rotate-90'}" />
					</span>
				</button>
				<Tooltip label={sec.label} side="right" disabled={pane !== 'rail'}>
					{#snippet child({ props })}
						<a
							{...props}
							href="/sections/{sec.type}" data-sveltekit-keepfocus
							class="{navItem} hidden rail:flex {sectionActive(sec.type) ? navItemActive : ''}"
							aria-current={sectionActive(sec.type) ? 'page' : undefined}
						>
							<ColourIcon name={sec.type} class="-m-px" />
							<span class="sr-only">{sec.label}</span>
						</a>
					{/snippet}
				</Tooltip>
				{#if open}
					<!-- A group's rows fold open and shut (inline things never jump). -->
					<div class="pane-fold" in:foldIn out:foldOut>
					<ul class="pane-text rail:hidden">
						{#each sec.accounts as a (a.id)}
							<li>
								<a
									href="/accounts/{a.id}" data-sveltekit-keepfocus
									class="{navItem} py-1.5 pl-10 {accountActive(a.id) ? navItemActive : ''}"
									aria-current={accountActive(a.id) ? 'page' : undefined}
								>
									<span class="fit-row">
										<span>{a.name}</span>
										<!-- At the viewer's share (H2 RD8): rows add to the subtotal and to net worth; a joint
										     account says its share, the register keeps the full balance. -->
										<span class="num text-body font-normal {levelToneClass(a.sharePaise)}">
											{#if a.shareBp !== null}<span class="text-text-muted">{formatShare(a.shareBp)}<span class="sr-only"> your share,</span></span>&nbsp;{/if}{wholeMoney(a.sharePaise, { compact: m.compact, currency: a.currency })}
										</span>
									</span>
								</a>
							</li>
						{/each}
					</ul>
					</div>
				{/if}
			{/each}
		{/if}

		<Tooltip label="Add account" side="right" disabled={pane !== 'rail'}>
			{#snippet child({ props })}
				<button {...props} type="button" onclick={() => openAddAccount()} class="{navItem} pane-rail-only mt-3 hidden w-full text-left text-brand-ink rail:flex">
					<Plus size={16} class="flex-none" />
					<span class={railText}>Add account</span>
				</button>
			{/snippet}
		</Tooltip>

	</div>

	<!-- Categories and Payees: places, pinned at the foot (Actual's "More",
	     Banktivity's "Configuration"). You and Settings moved to the title bar (AccountMenu). -->
	<nav aria-label="Manage" class="min-w-(--sidebar-open) border-t border-divider px-1 py-2 rail:min-w-0">
		{#each MANAGE as it (it.id)}
			<Tooltip label={it.label} side="right" disabled={pane !== 'rail'}>
				{#snippet child({ props })}
					<a
						{...props}
						href={it.href} data-sveltekit-keepfocus
						class="{navItem} {primaryActive(it.href) ? navItemActive : ''}"
						aria-current={primaryActive(it.href) ? 'page' : undefined}
					>
						<ColourIcon name={it.icon} class="-m-px" />
						<span class={railText}>{it.label}</span>
					</a>
				{/snippet}
			</Tooltip>
		{/each}
	</nav>
</aside>
