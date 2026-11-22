/**
 * accounts list + create (F1 · S1 · S5). The list is viewer-scoped through
 * `listAccounts` (→ `accountsVisibleTo`, the P0 predicate) — never a broader
 * read. The create form is driven by the app module CATALOGUE (`$lib/modules`):
 * the picker offers every creatable module grouped for discovery (S1), and each
 * module's ONBOARDING shape decides how opening cash + S5 informational fields
 * are captured — asset holdings onboard invested + current value (S2 RD1) via
 * `createHoldingAccount`; liabilities capture an outstanding stored as a negative
 * opening; the rest capture a plain opening balance.
 */
import { fail, redirect } from '@sveltejs/kit';
import * as v from 'valibot';
import type { Actions, PageServerLoad } from './$types';
import { getDb } from '$lib/server/db/instance';
import {
	createAccount,
	createHoldingAccount,
	createChildAccount,
	listAccounts,
	listAccountsHeldBefore,
	AccountNameConflictError,
	UnsupportedCurrencyError,
	OpeningDateError
} from '$lib/server/accounts';
import { rupeesToPaise, type FieldErrors } from '$lib/server/validation';
import { moduleProfile, moduleLabel, openingCurrency, readInfoForm } from '$lib/modules';
import { SUPPORTED_CURRENCIES } from '$lib/currencies';
import { textProblem } from '$lib/text-limits';
import { loadRateTable } from '$lib/server/rates';
import { baseCurrency } from '$lib/server/settings';
import { toBase, Money, today, formatDate } from '@miserly/core';
import { sharesFor, accountsVisibleTo } from '$lib/server/visibility';
import { appClock } from '$lib/server/clock';
import { balanceTrends } from '$lib/server/dashboard';
import { ledgerCuts, todayCuts } from '$lib/server/ledger-cuts';

export const load: PageServerLoad = async ({ locals }) => {
	const user = locals.user;
	if (!user) throw redirect(303, '/signin');

	const all = await listAccounts(getDb(), user.id, { includeClosed: true });
	const label = (a: { type: string }) => moduleLabel(a.type);
	// Open accounts at the viewer's share (H2 RD8), as the sidebar: each figure
	// is the account in full (converted first when foreign) times the share, so rows and subtotals
	// match the sidebar's to the paisa. The register keeps the full balance.
	const now = today(appClock());
	const todayIso = formatDate(now);
	// Each open account's last 12 months, and its change this month as
	// the section pages show it (balance today less the last month end's, both at the viewer's share).
	const prevEndIso = formatDate(now.with({ day: 1 }).subtract({ days: 1 }));
	const trends = await balanceTrends(getDb(), user.id, all.filter((a) => a.status === 'open').map((a) => a.id));
	// The balance at the last month end: every row less those dated after it (the request's one
	// grouped sum; it was one query per account).
	const sinceEnd = ledgerCuts(getDb().sqlite, await accountsVisibleTo(getDb().db, user.id), todayCuts(now)).sums;
	const shares = await sharesFor(getDb().db, user.id, all.map((a) => a.id));
	// DL-18 / MC3: a foreign account's list row also shows "≈ base", through the ONE
	// toBase boundary (null = rate needed, never a silent 1:1).
	const base = baseCurrency(getDb().db);
	const rates = all.some((a) => a.currency !== base) ? loadRateTable(getDb().db) : null;
	const baseApprox = (a: { id: string; currency: string; balancePaise: number }) => {
		if (!rates || a.currency === base) return null;
		const full = toBase(Money.fromPaise(a.balancePaise, a.currency), rates);
		return full === null ? null : shares.partOn(a.id, full.paise, todayIso);
	};
	return {
		open: all
			.filter((a) => a.status === 'open')
			.map((a) => ({
				...a,
				label: label(a),
				balancePaise: shares.partOn(a.id, a.balancePaise, todayIso),
				shareBp: shares.isShared(a.id) ? shares.shareBpOn(a.id, todayIso) : null,
				baseApproxPaise: baseApprox(a),
				changePaise:
					shares.partOn(a.id, a.balancePaise, todayIso) -
					shares.partOn(a.id, a.balancePaise - (sinceEnd.get(a.id)?.[1] ?? 0) - (sinceEnd.get(a.id)?.[2] ?? 0), prevEndIso),
				trend: trends.get(a.id) ?? null
			})),
		closed: all.filter((a) => a.status === 'closed').map((a) => ({ ...a, label: label(a) })),
		// C5 C: accounts no longer shared with the viewer, read-only for the dates they held them.
		left: (await listAccountsHeldBefore(getDb(), user.id)).map((a) => ({ ...a, label: label(a) })),
	};
};

/** Parse a rupees string → integer paise, `null` on blank, `'error'` on bad input. */
function parsePaise(raw: string): number | null | 'error' {
	const s = raw.trim();
	if (s === '') return null;
	const r = v.safeParse(rupeesToPaise, s);
	return r.success ? r.output : 'error';
}

export const actions: Actions = {
	create: async ({ request, locals }) => {
		const user = locals.user;
		if (!user) throw redirect(303, '/signin');
		const form = await request.formData();

		const type = String(form.get('type') ?? '').trim();
		const profile = moduleProfile(type);
		// A child type (an EPF's EPS) is made with its parent, never on its own (S5 RD16).
		if (!profile || profile.comingSoon || profile.childOf) {
			return fail(400, { errors: { type: 'Choose an account type' } as FieldErrors });
		}

		const name = String(form.get('name') ?? '').trim();
		if (name === '') return fail(400, { errors: { name: 'Give the account a name' } });
		const nameProblem = textProblem(name, 'name');
		if (nameProblem) return fail(400, { errors: { name: nameProblem } });

		// MC1: currency is chosen once, at creation, and is IMMUTABLE thereafter —
		// there is no edit path anywhere in accounts.ts. Checked here (friendly,
		// field-scoped) AND again inside `createAccount` (the service-layer choke
		// point every creation path funnels through, incl. holding onboarding) —
		// belt and suspenders, never a route that can slip an unsupported code in.
		// No currency posted: the instance's base (MC1: the picker opens on it). An Indian scheme is
		// always in rupees, whatever was posted (PPF's ₹1.5 lakh counts rupees).
		const base = baseCurrency(getDb().db);
		const posted = form.get('currency');
		const currency = openingCurrency(type, posted === null ? null : String(posted), base);
		if (!(SUPPORTED_CURRENCIES as readonly string[]).includes(currency)) {
			return fail(400, { errors: { currency: 'Choose a supported currency' } });
		}
		const openingDate = String(form.get('openingDate') ?? '').trim() || null;

		// S5 informational fields → a small JSON object (display-only; dates checked, blanks dropped).
		const details = readInfoForm(profile, form);
		if ('errors' in details) return fail(400, { errors: details.errors });
		const infoJson = details.infoJson;

		const db = getDb();
		let accountId: string;
		try {
			if (profile.onboarding === 'investedValue') {
				const invested = parsePaise(String(form.get('invested') ?? ''));
				if (invested === 'error') return fail(400, { errors: { invested: 'Enter an amount like 100000' } });
				const investedPaise = invested ?? 0;
				if (investedPaise < 0) return fail(400, { errors: { invested: 'Amount cannot be negative' } });

				const cv = parsePaise(String(form.get('currentValue') ?? ''));
				if (cv === 'error') return fail(400, { errors: { currentValue: 'Enter an amount like 100000' } });
				if (cv !== null && cv < 0) return fail(400, { errors: { currentValue: 'Amount cannot be negative' } });
				// S5 RD16: the child's opening (an EPF's "EPS paid in so far"), checked before anything is written.
				const childOpening = profile.child ? parsePaise(String(form.get('childOpening') ?? '')) : null;
				if (childOpening === 'error') return fail(400, { errors: { childOpening: 'Enter an amount like 100000' } });
				if (childOpening !== null && childOpening < 0) return fail(400, { errors: { childOpening: 'Amount cannot be negative' } });

				({ id: accountId } = await createHoldingAccount(db, {
					ownerId: user.id,
					type,
					name,
					currency,
					investedPaise,
					investedDate: investedPaise === 0 ? null : openingDate,
					currentValuePaise: cv,
					infoJson
				}));
				if (profile.child) await createChildAccount(db, accountId, childOpening ?? 0, openingDate);
			} else if (profile.onboarding === 'cardOutstanding' || profile.onboarding === 'loanOutstanding') {
				const out = parsePaise(String(form.get('outstanding') ?? ''));
				if (out === 'error') return fail(400, { errors: { outstanding: 'Enter an amount like 50000' } });
				const outstanding = out ?? 0;
				// A card or loan can start in credit (overpaid): a negative outstanding opens as a
				// positive balance.
				({ id: accountId } = await createAccount(db, {
					ownerId: user.id,
					type,
					name,
					currency,
					openingPaise: -outstanding, // owed → negative (natural-signed liability)
					openingDate: outstanding === 0 ? null : openingDate,
					infoJson
				}));
			} else {
				// balance — a plain signed opening (Bank).
				const bal = parsePaise(String(form.get('opening') ?? ''));
				if (bal === 'error') return fail(400, { errors: { opening: 'Enter an amount like 1000 or -250' } });
				const openingPaise = bal ?? 0;
				({ id: accountId } = await createAccount(db, {
					ownerId: user.id,
					type,
					name,
					currency,
					openingPaise,
					openingDate: openingPaise === 0 ? null : openingDate,
					infoJson
				}));
			}
		} catch (err) {
			if (err instanceof AccountNameConflictError) {
				return fail(400, { errors: { name: err.message } });
			}
			if (err instanceof UnsupportedCurrencyError) {
				return fail(400, { errors: { currency: 'Choose a supported currency' } });
			}
			if (err instanceof OpeningDateError) return fail(400, { errors: { openingDate: err.message } });
			if (err instanceof Error && /opening date|start date/iu.test(err.message)) {
				return fail(400, { errors: { openingDate: 'A start date is required for a non-zero amount' } });
			}
			return fail(400, { errors: { _: err instanceof Error ? err.message : 'Could not create account' } });
		}
		// The dialog opens the new account.
		return { created: true, accountId };
	}
};
