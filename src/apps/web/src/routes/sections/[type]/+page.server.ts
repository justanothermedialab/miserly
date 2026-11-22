/**
 * /sections/[type] — one instrument section (S1): a header total + the viewer's
 * open accounts of that module. Asset holding sections carry per-account value /
 * invested / return (S2, via `holdingMetrics`); bank, card and loan sections (cash
 * and liabilities) carry each account's change this month instead (S1 RD9, session
 * 4: a loan has no invested or return), and every section lead into the
 * register (C1). All figures reuse the shared derived computation (D4
 * `accountSummary` for the list + total, `holdingMetrics` for return) — no second
 * balance path that could drift. Viewer-scoped (P0). An unknown/coming-soon type
 * 404s.
 */
import { error, redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getDb } from '$lib/server/db/instance';
import {
	accountSummary,
	balanceTrends,
	holdingMetrics,
	sectionAnnualReturnDetail,
	sharedAnnualReturns,
	valueInvestedHistory,
	type Timeframe
} from '$lib/server/dashboard';
import { loadRateTable } from '$lib/server/rates';
import { toBase, Money, getModule, today, formatDate } from '@miserly/core';
import { ledgerCuts, todayCuts } from '$lib/server/ledger-cuts';
import { appClock } from '$lib/server/clock';
import { sharesFor, accountsVisibleTo } from '$lib/server/visibility';
import { moduleProfile } from '$lib/modules';

const TIMEFRAMES: readonly Timeframe[] = ['1M', '3M', '6M', 'YTD', '1Y', 'ALL'];

export const load: PageServerLoad = async ({ params, locals, url }) => {
	const user = locals.user;
	if (!user) throw redirect(303, '/signin');

	const profile = moduleProfile(params.type);
	// A type shown in another's section (an EPF's EPS, NPS Tier II in NPS) has none of its own (S5 RD16).
	if (!profile || profile.comingSoon || profile.childOf || profile.sectionOf) throw error(404, 'Not found');

	const db = getDb();
	const summary = await accountSummary(db, user.id);
	const group = summary.find((g) => g.type === params.type);
	const rawAccounts = group?.accounts ?? [];
	// `subtotalPaise` is already BASE (INR), converted from mixed native currencies
	// via the one `toBase` (accountSummary, MC1). `rateNeeded` flags a foreign
	// member with no rate so the header total reads honestly (never a silent 1:1).
	const totalPaise = group?.subtotalPaise ?? 0;
	const rateNeeded = group?.rateNeeded ?? false;

	// Invested and return belong to ASSET holdings; a liability or a cash account leads with its
	// balance and change instead (S1 RD9). The side comes from the module's contract metadata.
	const side = getModule(params.type).metadata.side;
	const isHolding = profile.sectionShape === 'holding' && side === 'Asset';
	// A liability section whose profile has a stale period (Loans, Other liability) shows
	// when each outstanding was last updated, and asks for the lender's figure once payments pass 0.
	const tracksUpdates = profile.sectionShape === 'holding' && side === 'Liability' && profile.staleAfterMonths !== undefined;
	const rates = loadRateTable(db.db);
	const now = today(appClock());
	const todayIso = formatDate(now);
	const prevEndIso = formatDate(now.with({ day: 1 }).subtract({ days: 1 }));
	// Every figure at the viewer's share (H2 RD8): rows add to the section's
	// total, which is the sidebar's subtotal; the register keeps the full balance.
	const shares = await sharesFor(db.db, user.id, rawAccounts.map((a) => a.id));
	// The balance at the last month end: today's less the rows dated since (the request's one
	// grouped sum; it was one query per account).
	const sinceEnd = ledgerCuts(db.sqlite, await accountsVisibleTo(db.db, user.id), todayCuts(now)).sums;
	// A holding whose share changed reads the viewer's own rate on its row, as the headline.
	const sharedRates = isHolding ? await sharedAnnualReturns(db, user.id, rawAccounts.map((a) => a.id)) : new Map<string, number | null>();
	const accounts = await Promise.all(
		rawAccounts.map(async (a) => {
			const part = (paise: number, date = todayIso) => shares.partOn(a.id, paise, date);
			const full = isHolding || tracksUpdates ? await holdingMetrics(db, user.id, a.id) : null;
			const updated = tracksUpdates && full
				? { lastUpdated: full.lastUpdated, stale: full.stale, passedZero: full.passedZero }
				: null;
			const metrics = isHolding && full && {
				...full,
				...(sharedRates.has(a.id) ? { annualReturn: sharedRates.get(a.id) ?? null } : {}),
				currentValuePaise: part(full.currentValuePaise),
				costBasisPaise: part(full.costBasisPaise),
				returnPaise: part(full.currentValuePaise) - part(full.costBasisPaise)
			};
			return {
				id: a.id,
				name: a.name,
				type: a.type,
				parentId: a.parentId,
				shareBp: a.shareBp,
				// Per-row balance stays NATIVE (MC3: native-primary); `currency` drives
				// the correct symbol so a USD account never renders with a ₹ sign.
				balancePaise: a.sharePaise,
				currency: a.currency,
				// Change since the previous month end, native; and the base value of a foreign account (MC3).
				changePaise: a.sharePaise - part(a.balancePaise - (sinceEnd.get(a.id)?.[1] ?? 0), prevEndIso),
				basePaise: a.currency === rates.base ? null : (toBase(Money.fromPaise(a.sharePaise, a.currency), rates)?.paise ?? null),
				metrics,
				updated
			};
		})
	);
	// The section's change this month in base (accounts without a rate are left out, as the total).
	let changeBasePaise = 0;
	for (const a of accounts) {
		const c = toBase(Money.fromPaise(a.changePaise, a.currency), rates);
		if (c !== null) changeBasePaise += c.paise;
	}

	// A section-level KPI summary for holding sections (Current value /
	// Invested / Return). Invested + value are summed in BASE (INR) via the one
	// `toBase` boundary (MC1) so a mixed-currency section totals honestly; a member
	// with a missing rate flags `rateNeeded` rather than a silent 1:1.
	let holdingKpi: {
		valuePaise: number;
		investedPaise: number;
		returnPaise: number;
		returnPct: number | null;
		rateNeeded: boolean;
	} | null = null;
	if (isHolding && accounts.length > 0) {
		let investedBasePaise = 0;
		let valueBasePaise = 0;
		let kpiRateNeeded = rateNeeded;
		for (const a of accounts) {
			if (!a.metrics) continue;
			const inv = toBase(Money.fromPaise(a.metrics.costBasisPaise, a.metrics.currency), rates);
			const val = toBase(Money.fromPaise(a.metrics.currentValuePaise, a.metrics.currency), rates);
			if (inv === null || val === null) {
				kpiRateNeeded = true;
				continue;
			}
			investedBasePaise += inv.paise;
			valueBasePaise += val.paise;
		}
		holdingKpi = {
			valuePaise: valueBasePaise,
			investedPaise: investedBasePaise,
			returnPaise: valueBasePaise - investedBasePaise,
			returnPct: investedBasePaise > 0 ? (valueBasePaise - investedBasePaise) / investedBasePaise : null,
			rateNeeded: kpiRateNeeded
		};
	}

	// I1 + I2: an investment section's value against money put in, over the
	// Dashboard's ranges (All by default: the whole of what was put in), and its return per year.
	// Every section: each account's last 12 months (N1; investment sections too).
	const raw = url.searchParams.get('range');
	const timeframe: Timeframe = TIMEFRAMES.includes(raw as Timeframe) ? (raw as Timeframe) : 'ALL';
	const [chart, annualReturn, trends] = await Promise.all([
		holdingKpi ? valueInvestedHistory(db, user.id, { type: params.type }, timeframe) : null,
		holdingKpi ? sectionAnnualReturnDetail(db, user.id, params.type) : null,
		balanceTrends(db, user.id, accounts.map((a) => a.id))
	]);

	return {
		tracksUpdates,
		todayIso,
		profile: {
			type: profile.type,
			label: profile.label,
			description: profile.description,
			sectionShape: profile.sectionShape,
			side
		},
		accounts: accounts.map((a) => ({ ...a, trend: trends.get(a.id) ?? null })),
		chart,
		annualReturn: annualReturn?.rate ?? null,
		// Holdings never valued since they began are left out of the rate, with a note.
		notValued: annualReturn?.notValued ?? 0,
		// C1 A: holdings whose interest is paid out show their stated rate and stay out of this one.
		paidOut: annualReturn?.paidOut ?? 0,
		totalPaise,
		changeBasePaise,
		rateNeeded,
		holdingKpi
	};
};
