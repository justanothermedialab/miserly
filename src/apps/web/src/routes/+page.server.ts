/**
 * The dashboard (M7; recomposed to the approved mock, D1 RD5 and RD8, D4 RD9).
 * Composes the ONE aggregation service (dashboard.ts) into the D1 headline, D3 net worth over
 * time, D4 recent activity and D2 allocation, plus month-to-date spending against last month
 * (reports.ts, on the R2/R3 spending predicate so the figures reconcile). All viewer-scoped.
 * The timeframe is a URL query param (`?range=`) so switching it re-runs this load server-side.
 * Joint accounts count at the viewer's share (D1 RD12); the Mine / Shared switch is gone.
 * No account list: the sidebar is the account list (D4 RD9).
 */
import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getDb } from '$lib/server/db/instance';
import { dashboardSummary, netWorthHistory, recentActivity, type Timeframe } from '$lib/server/dashboard';
import { monthToDateSpending } from '$lib/server/reports';

const TIMEFRAMES: readonly Timeframe[] = ['1M', '3M', '6M', 'YTD', '1Y', 'ALL'];

function parseTimeframe(raw: string | null): Timeframe {
	return TIMEFRAMES.includes(raw as Timeframe) ? (raw as Timeframe) : '1Y';
}

export const load: PageServerLoad = async ({ locals, url }) => {
	const user = locals.user;
	if (!user) throw redirect(303, '/signin'); // defense-in-depth; hooks already guarantees this

	const db = getDb();
	const timeframe = parseTimeframe(url.searchParams.get('range'));

	const [summary, history, activity, mtd] = await Promise.all([
		dashboardSummary(db, user.id),
		netWorthHistory(db, user.id, timeframe),
		// Up to 30: the page shows 10 or more, as many as fit beside the right column. It never
		// shows a note, so none is read (one long note made the dashboard megabytes).
		recentActivity(db, user.id, 30, undefined, { notes: false }),
		monthToDateSpending(db, user.id)
	]);

	return { summary, history, activity, mtd };
};
