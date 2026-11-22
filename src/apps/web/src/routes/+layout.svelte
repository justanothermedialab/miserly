<script lang="ts">
	import { onMount } from 'svelte';
	import { accentBridge, installWindowsAccent } from '$lib/theme';
	import { afterNavigate } from '$app/navigation';
	import '../app.css';
	import QuickAdd from '$lib/components/QuickAdd.svelte';
	import AddAccount from '$lib/components/AddAccount.svelte';
	import Sidebar from '$lib/components/Sidebar.svelte';
	import TopBar from '$lib/components/TopBar.svelte';
	import StatusBar from '$lib/components/StatusBar.svelte';
	import { formatDate } from '$lib/dates';
	import { fluentScroll } from '$lib/fluent-scroll';
	import { focusRescue } from '$lib/focus-rescue';
	import { page, navigating } from '$app/state';
	import { titleFor } from '$lib/page-title';
	import { setFormatContext, setPrefsController, DEFAULT_PREFS } from '$lib/format-context';
	import type { LayoutData } from './$types';
	import type { UserPrefs } from '$lib/prefs';

	let { children, data }: { children: import('svelte').Snippet; data: LayoutData } = $props();

	// S4 (H3 RD9): the admin reset this person's password, so they are told on the first page
	// after the forced change, and every page after, until they close it. "12 Nov", with the
	// year only when it isn't this one.
	let resetDismissed = $state(false);
	const resetDay = $derived.by(() => {
		const iso = data.passwordResetAt;
		if (!iso) return null;
		const long = formatDate(iso);
		return iso.slice(0, 4) === String(new Date().getFullYear()) ? long.replace(/ \d{4}$/, '') : long;
	});
	function dismissResetNotice() {
		resetDismissed = true;
		void fetch('/prefs/reset-notice', { method: 'POST' }).catch(() => {});
	}

	// SET1: hold the viewer's prefs in a `$state` so a number-format
	// change re-renders every figure app-wide INSTANTLY (no reload). This stays
	// request-scoped (a per-instance `$state`, never a module-level global — which
	// would bleed one user's preference into another's during concurrent SSR).
	// The formatter reads it through a getter, so all `useMoney()` consumers track
	// it; navigation/Save resyncs it to the freshly-loaded server prefs.
	let livePrefs = $state<UserPrefs | null>(data.prefs);
	$effect(() => {
		livePrefs = data.prefs;
	});

	// Set ALWAYS, signed in or not: the layout mounts once, and after sign-in the page
	// changes by client navigation, so a context set only when it mounted with prefs left every
	// page on the defaults (compact amounts) until a reload. The getters follow `livePrefs`.
	setFormatContext(
		() => livePrefs ?? data.prefs ?? DEFAULT_PREFS,
		() => data.baseCurrency,
	);
	// Let the Settings page push a live number-format change up into `livePrefs`
	// (child→parent) for instant apply; the `?/setDisplay` POST still persists it.
	setPrefsController({
		get current() {
			return livePrefs ?? data.prefs ?? DEFAULT_PREFS;
		},
		set: (patch) => {
			livePrefs = { ...(livePrefs ?? data.prefs ?? DEFAULT_PREFS), ...patch };
		},
	});

	// SET1 theme: 'system' leaves `prefers-color-scheme` in charge (no attribute);
	// an explicit light/dark stamps `data-theme` so the CSS can override it. Signed out there
	// are no prefs: keep what the server painted (the last signed-in theme on this device).
	$effect(() => {
		if (!data.prefs) return;
		if (data.prefs.theme !== 'system') {
			document.documentElement.dataset.theme = data.prefs.theme;
		} else {
			delete document.documentElement.dataset.theme;
		}
	});

	// Desktop shell (Electron): when the OS paints a Window-Controls-Overlay (the native
	// caption buttons), mark <html>.wco so the TopBar reserves the button rect on its right
	// and the title-bar strip becomes draggable. Driven off the JS API, NOT the
	// `@media (display-mode: window-controls-overlay)` query — Electron does not reliably
	// report that media feature. In a plain browser tab the API is absent → no class → the
	// app renders edge-to-edge, unaffected. (The buttons themselves are native and always
	// present regardless of this class; it only governs our surrounding chrome.)
	onMount(() => {
		const wco = (
			window.navigator as unknown as {
				windowControlsOverlay?: {
					visible: boolean;
					addEventListener: (t: string, f: () => void) => void;
					removeEventListener: (t: string, f: () => void) => void;
				};
			}
		).windowControlsOverlay;
		if (!wco) return;
		// Reserve the caption rect whenever WCO mode exists — toggle OFF only when the
		// overlay is *explicitly* hidden (fullscreen). `visible` can read false/undefined
		// in the first frame after mount, and if we keyed strictly on `=== true` the
		// reservation would miss and the native buttons would paint over the Add/theme
		// controls. `!== false` reserves unless the overlay is genuinely gone.
		const apply = () => document.documentElement.classList.toggle('wco', wco.visible !== false);
		apply();
		wco.addEventListener('geometrychange', apply);
		return () => wco.removeEventListener('geometrychange', apply);
	});

	// The launch cover (app.html) fades two frames after hydration, over a finished screen.
	onMount(() => {
		const root = document.documentElement;
		if (!root.hasAttribute('data-boot')) return;
		try {
			sessionStorage.setItem('miserly:booted', '1');
		} catch {
			// Storage unavailable: a reload shows the cover again, harmlessly.
		}
		requestAnimationFrame(() =>
			requestAnimationFrame(() => {
				root.dataset.boot = 'out';
				setTimeout(() => delete root.dataset.boot, 170);
			})
		);
	});
	// "Windows accent": follow a colour changed in Windows while the app is open (desktop only).
	onMount(() => accentBridge()?.onAccentColor?.((hex) => installWindowsAccent(hex)));

	// Dim the title-strip content while the desktop window is inactive. Main sends
	// focus/blur over the bridge; the hosted build has no bridge and never dims.
	onMount(() => {
		const bridge = (
			window as unknown as { miserlyDesktop?: { onWindowActive?: (cb: (a: boolean) => void) => () => void } }
		).miserlyDesktop;
		return bridge?.onWindowActive?.((active) => {
			document.documentElement.classList.toggle('inactive', !active);
			// Windows closes menus and drop-downs when their window is deactivated: send the
			// open one an Escape, which every Bits layer handles as "close".
			if (!active && document.querySelector('[data-slot=dropdown-menu-content], [data-slot=select-content], [data-popover-content]')) {
				(document.activeElement ?? document.body).dispatchEvent(
					new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
				);
			}
		});
	});

	// Keep the Electron overlay caption strip painted to the app's RESOLVED theme. A theme
	// change can come from the TopBar toggle, Settings, or an OS flip while on 'system' —
	// all of them land on <html data-theme>, so we watch that attribute + the OS media
	// query and re-notify. The bridge is absent in the hosted/browser build → harmless no-op.
	onMount(() => {
		notifyTitleBar();
		const obs = new MutationObserver(notifyTitleBar);
		obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
		const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
		mq?.addEventListener('change', notifyTitleBar);
		return () => {
			obs.disconnect();
			mq?.removeEventListener('change', notifyTitleBar);
		};
	});

	// After a navigation that left focus nowhere (palette, account menu, back/forward: SvelteKit
	// resets focus to <body>), land it on the page so Tab, F6 and screen readers start from the
	// content, not the top of the document (hunt H-nav-A). Sidebar links keep their own focus
	// (data-sveltekit-keepfocus), like a Windows NavigationView item.
	afterNavigate(({ type }) => {
		if (type === 'enter') return;
		const a = document.activeElement;
		if (!a || a === document.body) document.getElementById('app-content')?.focus({ preventScroll: true });
	});

	// Focus rescue: when the focused element is removed (a message's Undo or ✕, a
	// toolbar that unmounts, a row that re-renders), land focus on the page instead of nowhere;
	// a click outside an open Select or menu leaves focus where it was.
	onMount(() => focusRescue(() => document.getElementById('app-content')));

	// F6 / Shift+F6 cycle focus title bar → sidebar → content, the order they sit on screen
	// since chrome B put the title bar across the top (Outlook's order; F4); each region
	// is a tabindex=-1 landmark.
	const REGIONS = ['app-topbar', 'app-sidebar', 'app-content'];
	function onRegionKey(e: KeyboardEvent) {
		if (e.key !== 'F6' || !data.user) return;
		e.preventDefault();
		const active = document.activeElement;
		const cur = REGIONS.findIndex((id) => document.getElementById(id)?.contains(active));
		const step = e.shiftKey ? -1 : 1;
		const next = cur < 0 ? (e.shiftKey ? REGIONS.length - 1 : 0) : (cur + step + REGIONS.length) % REGIONS.length;
		const region = document.getElementById(REGIONS[next]!);
		// Panes land on their first control; the content pane takes focus itself.
		const first =
			next < 2
				? region?.querySelector<HTMLElement>('a[href], button:not([disabled]), input:not([type=hidden])')
				: null;
		(first ?? region)?.focus();
	}

	function notifyTitleBar() {
		const t = document.documentElement.dataset.theme;
		const dark =
			t === 'dark' ||
			t === 'black' ||
			(t !== 'light' && (window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false));
		(
			window as unknown as { miserlyDesktop?: { setTitleBarTheme: (d: boolean, black: boolean) => void } }
		).miserlyDesktop?.setTitleBarTheme(dark, t === 'black');
	}
	// A page that takes more than 300 ms shows a thin progress line at the top of the page panel
	// (Fluent's indeterminate ProgressBar; Mercury and Teams do the same); a quick one shows nothing,
	// so the desktop app, whose server is local, rarely shows it (visual checks).
	let slow = $state(false);
	$effect(() => {
		if (!navigating.to) {
			slow = false;
			return;
		}
		const t = setTimeout(() => (slow = true), 300);
		return () => clearTimeout(t);
	});
	// Change password takes the sign-in layout (DECISIONS-S4 D7): no sidebar, top bar or Quick Add.
	const bare = $derived(page.url.pathname === '/change-password');
</script>

<svelte:window onkeydown={onRegionKey} />

<svelte:head>
	<title>{titleFor(page.url.pathname, (page.data as { crumb?: string }).crumb)}</title>
</svelte:head>

{#if data.user && !bare}
	<!-- Fixed-viewport shell: the whole app is exactly one screen tall and never
	     body-scrolls. Only the CONTENT pane scrolls (its own overflow-y-auto), so the
	     vertical scrollbar starts BELOW the title bar and never bleeds into it — the
	     desktop-app model (VS Code), not a web page that scrolls under a sticky header. -->
	<a
		href="#app-content"
		class="sr-only z-[100] rounded-control bg-surface px-3 py-2 text-body font-semibold text-text shadow-[var(--shadow-pop)] focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
		onclick={(e) => {
			e.preventDefault();
			document.getElementById('app-content')?.focus();
		}}>Skip to content</a
	>
	<!-- Chrome B (Windows 11's layers): one title bar across the window, the
	     sidebar under it, both on one base (--base) with no rule between them; the page on its own
	     layer, rounded top-left with a hairline edge. -->
	<div class="flex h-screen flex-col overflow-hidden" style="background:var(--base)">
	<TopBar />
	<!-- The pane opens and closes over one Fluent "fast" step (167 ms, decelerate) instead of
	     jumping in one frame (C7.3); reduced motion makes it instant (app.css). -->
	<div
		class="pane-grid grid min-h-0 flex-1 overflow-hidden transition-[grid-template-columns] motion-fast ease-decelerate"
		style="grid-template-columns:var(--sidebar-w) 1fr"
	>
		<Sidebar
			nav={data.nav}
			user={data.user}
			inboxCount={data.inboxCount}
			baseCurrency={data.baseCurrency}
		/>
		<!-- col-start-2: the overlay pane leaves the grid, so pin the content column. -->
		<div class="relative col-start-2 flex min-w-0 flex-col overflow-hidden rounded-tl-overlay border-l border-t border-border bg-background">
			{#if slow}<div class="nav-progress" role="progressbar" aria-label="Loading"></div>{/if}
			<main
				id="app-content"
				use:fluentScroll
				tabindex="-1"
				class="relative min-w-0 flex-1 overflow-y-auto px-section pb-15 pt-section outline-none narrow:px-5"
			>
				{#if resetDay && !resetDismissed}
					<StatusBar intent="info" autoDismiss={false} class="mb-4" ondismiss={dismissResetNotice}
						>Your password was reset by the admin on {resetDay}.</StatusBar
					>
				{/if}
				{@render children()}
			</main>
		</div>
	</div>
	</div>
{:else}
	<!-- Signed-out screens (sign-in, setup, errors) and Change password (DECISIONS-S4 D7: the
	     sign-in layout) have no TopBar, so give
	     the desktop window a title-bar strip to drag by. Shown only under .wco. -->
	<div class="app-drag-strip" aria-hidden="true"></div>
	{@render children()}
{/if}

{#if data.user && !bare}
	<AddAccount />
{/if}

{#if data.quickAdd && !bare}
	<QuickAdd
		accounts={data.quickAdd.accounts}
		categoryGroups={data.quickAdd.categoryGroups}
		payees={data.quickAdd.payees}
		transferCategories={data.quickAdd.transferCategories}
	/>
{/if}
