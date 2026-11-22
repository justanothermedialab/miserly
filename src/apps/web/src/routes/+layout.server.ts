/**
 * Layout load — exposes the resolved viewer (from hooks.server's single auth
 * gate) to every page, plus the reference data the global quick-add overlay
 * (C2) needs on every screen: the viewer's OPEN accounts (the account picker),
 * the category tree, and the viewer's payees (autocomplete + fill-when-blank).
 * All viewer-scoped: accounts + payees funnel through `accountsVisibleTo`.
 */
import type { LayoutServerLoad } from './$types';
import { getDb } from '$lib/server/db/instance';
import { transferTargetsFor } from '$lib/server/inline-transfer';
import { listCategoryTree } from '$lib/server/categories';
import { capturePayees, inboxCount, rememberedTransferCategories } from '$lib/server/transactions';
import { getUserPrefs, getCircleName, baseCurrency, yearStartMonth } from '$lib/server/settings';
import { passwordResetNotice } from '$lib/server/auth/users';
import { dashboardSummary, netWorthHistory, accountSummary } from '$lib/server/dashboard';
import { MODULE_PROFILES, sectionLabel } from '$lib/modules';
import { eq } from 'drizzle-orm';
import * as schema from '$lib/server/db/schema';
import { COLS_COOKIE, parseColsCookie } from '$lib/register/columns.svelte';

/** The sidebar sections opened this launch, dot-separated (a session cookie, Sidebar.svelte).
 *  Every group starts folded at each launch; one opened stays open until
 *  the app (or the browser) closes. */
const NAV_OPEN_COOKIE = 'miserly_nav_open';

/**
 * The persistent-chrome (sidebar) nav payload: the viewer's net-worth hero + the
 * held sections, each with its subtotal and its accounts by name (S1 RD7). It is
 * composed from the SAME viewer-scoped `dashboard.ts` aggregates the dashboard page
 * reads, so the sidebar total can never drift from the dashboard hero (the
 * architecture's no-drift invariant). Sections the viewer holds nothing in are
 * omitted; the order is the module registry's.
 */
async function buildNav(db: ReturnType<typeof getDb>, userId: string, openCookie: string | undefined) {
	// Sections the viewer opened (a cookie, so the server renders them open: no flash on load).
	const opened = new Set((openCookie ?? '').split('.').filter(Boolean));
	const [summary, history, byType] = await Promise.all([
		dashboardSummary(db, userId),
		// Only the change since last month: the 1M window's last two points are the 3M window's.
		netWorthHistory(db, userId, '1M'),
		accountSummary(db, userId)
	]);

	const order = new Map(MODULE_PROFILES.map((p, i) => [p.type, i]));
	const sections = [...byType]
		.sort((a, b) => (order.get(a.type) ?? 99) - (order.get(b.type) ?? 99))
		.map((g) => ({
			type: g.type,
			label: sectionLabel(g.type),
			subtotalPaise: g.subtotalPaise,
			rateNeeded: g.rateNeeded,
			collapsed: !opened.has(g.type),
			accounts: g.accounts
		}));

	return {
		hasOpenAccounts: summary.hasOpenAccounts,
		netWorthPaise: summary.netWorthPaise,
		assetsPaise: summary.assetsPaise,
		liabilitiesPaise: summary.liabilitiesPaise,
		rateNeededCurrencies: summary.rateNeededCurrencies,
		monthChange: history.changeSinceLastMonth,
		sections
	};
}

export const load: LayoutServerLoad = async ({ locals, request, cookies, depends }) => {
	// A save reloads this alone (the sidebar, the Inbox count, Quick add's lists), not the page's list.
	depends('app:nav');
	const user = locals.user;
	// The currency for totals and the year start, chosen at setup and read per request (MC1 RD2
	// amended, R1): every page's formatter takes its symbol from the base.
	const base = baseCurrency(getDb().db);
	const yearStart = yearStartMonth(getDb().db);
	if (!user)
		return {
			user: null,
			quickAdd: null,
			inboxCount: 0,
			prefs: null,
			circleName: null,
			baseCurrency: base,
			yearStart,
			nav: null,
			passwordResetAt: null as string | null,
			colWidths: {} as Record<string, Record<string, number>>
		};

	const db = getDb();
	// The viewer's own display name for the chrome (account menu) — the session
	// carries only the username, and UI copy uses display names (CP-07).
	const me = db.db
		.select({ displayName: schema.users.displayName })
		.from(schema.users)
		.where(eq(schema.users.id, user.id))
		.get();
	const [accounts, groups, payees, transferCategories, inbox, prefs, circleName, nav] = await Promise.all([
		transferTargetsFor(db, user.id), // open-only, each with its C8 label ("HDFC (Bob's)")
		listCategoryTree(db.db),
		capturePayees(db.db, user.id),
		rememberedTransferCategories(db.db, user.id), // A transfer's category per destination
		inboxCount(db, user.id),
		getUserPrefs(db.db, user.id, request.headers.get('accept-language'), base),
		getCircleName(db.db),
		buildNav(db, user.id, cookies.get(NAV_OPEN_COOKIE))
	]);

	return {
		user: { ...user, displayName: me?.displayName ?? user.username },
		// Column widths the person set by dragging a heading's edge (columns.svelte.ts).
		colWidths: parseColsCookie(cookies.get(COLS_COOKIE)),
		inboxCount: inbox,
		prefs,
		circleName,
		baseCurrency: base,
		yearStart,
		nav,
		// S4 (H3 RD9): the day the admin reset this password, until the person dismisses it.
		passwordResetAt: passwordResetNotice(db.db, user.id),
		quickAdd: {
			accounts: accounts.map((a) => ({
				id: a.id,
				name: a.name,
				label: a.label,
				listLabel: a.listLabel,
				type: a.type,
				currency: a.currency
			})),
			categoryGroups: groups.map((g) => ({
				id: g.id,
				name: g.name,
				categories: g.categories.map((c) => ({ id: c.id, name: c.name }))
			})),
			payees,
			transferCategories
		}
	};
};
