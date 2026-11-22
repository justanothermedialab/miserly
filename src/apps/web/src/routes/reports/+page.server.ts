/**
 * reports/+page.server.ts: the Reports load, rebuilt to the approved mock.
 * Named tabs (R1 RD5): Spending, Income vs expense, Net worth,
 * each with its own range (R1 RD6: trailing 6 months for the first two, 12 for Net worth),
 * resolved server-side from the URL (`?report=`, `?preset=`, `?from=&to=` for a custom range,
 * `?cat=` for the spending drill, `?flow=` for Income vs expense's). Only the open tab's report is computed. Joint accounts count
 * at the viewer's share (R2 RD10); there is no shared-only view.
 *
 *   - Spending (R2 RD5 to RD8): spending by category by month, the previous period's total for
 *     the comparison in words and the drill's transactions; `?by=payee` (R2 RD13) gives the same
 *     figures by payee instead, `?payee=` its drill.
 *   - Income vs expense (R3 RD5, RD6): the monthly bins (the savings rate is derived on the page)
 *     and the drill's transactions (R3 RD10: a month's Income or Spending figure).
 *   - Net worth (D3 RD6, RD7): net worth by class at each month end.
 *
 * Everything is viewer-scoped through the services (P0); the totals reconcile with R2/R3.
 */
import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getDb } from '$lib/server/db/instance';
import {
	spendingByCategory,
	spendingByCategoryByMonth,
	spendingByPayeeByMonth,
	incomeVsExpense,
	categoryTransactions,
	payeeTransactions,
	flowTransactions,
	earliestActivityDate,
	UNCATEGORIZED_KEY,
	NO_PAYEE_KEY,
} from '$lib/server/reports';
import { netWorthByClass } from '$lib/server/dashboard';
import { resolvePeriod, previousPeriod, PRESETS, type Preset, type ResolvedPeriod } from '$lib/reports/period';
import { today, formatDate } from '@miserly/core';
import { appClock } from '$lib/server/clock';
import { yearStartMonth } from '$lib/server/settings';

export type ReportTab = 'spending' | 'income' | 'networth';
const TABS: readonly ReportTab[] = ['spending', 'income', 'networth'];

function parseTab(raw: string | null): ReportTab {
	return TABS.includes(raw as ReportTab) ? (raw as ReportTab) : 'spending';
}
/** `month` (YYYY-MM, a figure's row or column) narrows a drill to that month inside the range. */
function monthWithin(range: { from: string; to: string }, monthParam: string | null): { from: string; to: string; label: string } {
	if (!monthParam || !/^\d{4}-\d{2}$/u.test(monthParam)) return { ...range, label: '' };
	const [y, mo] = monthParam.split('-').map(Number) as [number, number];
	const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
	const from = `${monthParam}-01`;
	const to = `${monthParam}-${String(last).padStart(2, '0')}`;
	return {
		from: from > range.from ? from : range.from,
		to: to < range.to ? to : range.to,
		label: new Date(`${monthParam}-01T00:00:00Z`).toLocaleString('en-IN', { month: 'short', year: 'numeric', timeZone: 'UTC' })
	};
}

function parsePreset(raw: string | null, tab: ReportTab): Preset {
	if (raw !== null && (PRESETS as readonly string[]).includes(raw)) return raw as Preset;
	return tab === 'networth' ? 'last12m' : 'last6m';
}

export const load: PageServerLoad = async ({ locals, url }) => {
	const user = locals.user;
	if (!user) throw redirect(303, '/signin'); // defense-in-depth; hooks already guarantees this

	const db = getDb();
	const now = today(appClock());
	const tab = parseTab(url.searchParams.get('report'));
	const preset = parsePreset(url.searchParams.get('preset'), tab);
	const earliest = await earliestActivityDate(db, user.id);
	// The year start chosen at setup (R1): "This financial year" and its kin follow it.
	const yearStart = yearStartMonth(db.db);

	let period: ResolvedPeriod;
	if (preset === 'all') {
		period = resolvePeriod('all', now, { earliest: earliest ?? undefined, yearStart });
	} else if (preset === 'custom') {
		const from = url.searchParams.get('from');
		const to = url.searchParams.get('to');
		try {
			if (!from || !to) throw new Error('reports: custom preset requires from/to');
			period = resolvePeriod('custom', now, { custom: { from, to } });
		} catch {
			// A missing or invalid custom range (a hand-edited URL) falls back to the tab's default.
			period = resolvePeriod(tab === 'networth' ? 'last12m' : 'last6m', now);
		}
	} else {
		period = resolvePeriod(preset, now, { yearStart });
	}
	const range = { from: period.from, to: period.to };
	const todayIso = formatDate(now);
	// The months drawn start at the ledger's first month, as the caption does and as Net worth
	// already did; a window reaching back before it showed months that weren't recorded, not zero.
	const firstMonth = earliest ? `${earliest.slice(0, 7)}-01` : null;
	const shown = firstMonth && firstMonth > range.from ? { from: firstMonth, to: range.to } : range;

	if (tab === 'income') {
		const cashflow = await incomeVsExpense(db, user.id, shown);
		const flowParam = url.searchParams.get('flow');
		const flow = flowParam === 'income' || flowParam === 'spending' ? flowParam : null;
		const within = monthWithin(range, url.searchParams.get('month'));
		const drill =
			flow === null
				? null
				: {
						flow,
						month: url.searchParams.get('month'),
						name: (flow === 'income' ? 'Income' : 'Spending') + (within.label ? `, ${within.label}` : ''),
						transactions: await flowTransactions(db, user.id, within, flow)
					};
		return { tab: 'income' as const, period, earliest, todayIso, cashflow, drill };
	}

	if (tab === 'networth') {
		const networth = await netWorthByClass(db, user.id, range);
		return { tab: 'networth' as const, period, earliest, todayIso, networth };
	}

	// Spending: the months, the previous period's total (for the comparison in words), the
	// drill. (The "who logged it" table by member was dropped: R2 RD11.)
	// By payee (R2 RD13) reads the same rows, so the previous total is the same either way.
	const by = url.searchParams.get('by') === 'payee' ? ('payee' as const) : ('category' as const);
	const prev = previousPeriod(range);
	const [byMonth, byPayee, previous] = await Promise.all([
		by === 'category' ? spendingByCategoryByMonth(db, user.id, shown) : null,
		by === 'payee' ? spendingByPayeeByMonth(db, user.id, shown) : null,
		spendingByCategory(db, user.id, { from: prev.from, to: prev.to })
	]);
	// "Tracking began in …" instead of a comparison when the ledger starts inside the previous window.
	const previousComplete = earliest !== null && earliest <= prev.from;

	const within = monthWithin(range, url.searchParams.get('month'));
	const monthLabel = within.label ? `, ${within.label}` : '';
	const catParam = by === 'category' ? url.searchParams.get('cat') : null;
	const payeeParam = by === 'payee' ? url.searchParams.get('payee') : null;
	let drill: { categoryId: string | null; payeeId: string | null; name: string; transactions: Awaited<ReturnType<typeof categoryTransactions>> } | null = null;
	if (catParam !== null) {
		drill = {
			categoryId: catParam,
			payeeId: null,
			name:
				(catParam === UNCATEGORIZED_KEY
					? 'Uncategorized'
					: (byMonth?.categories.find((c) => c.categoryId === catParam)?.name ?? 'Category')) + monthLabel,
			transactions: await categoryTransactions(db, user.id, within, catParam === UNCATEGORIZED_KEY ? null : catParam)
		};
	} else if (payeeParam !== null) {
		drill = {
			categoryId: null,
			payeeId: payeeParam,
			name:
				(payeeParam === NO_PAYEE_KEY
					? 'No payee'
					: (byPayee?.payees.find((p) => p.payeeId === payeeParam)?.name ?? 'Payee')) + monthLabel,
			transactions: await payeeTransactions(db, user.id, within, payeeParam)
		};
	}

	return {
		tab: 'spending' as const,
		period,
		earliest,
		todayIso,
		by,
		byMonth,
		byPayee,
		previous: { totalPaise: previous.totalPaise, label: prev.label, complete: previousComplete },
		drill
	};
};
