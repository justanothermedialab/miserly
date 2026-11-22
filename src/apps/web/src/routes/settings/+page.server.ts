/**
 * Settings (SET1): the viewer's preferences (number format, theme, accent), the group's name and
 * members (H1/H3, admin only), and Currencies & rates (MC3). Currencies & rates is the SINGLE
 * rate-management surface MC1/MC3 lock: every active foreign currency (one used by ≥1 of the
 * viewer's VISIBLE accounts, open or historically-open — same rule as D3), its current rate to
 * base (INR), and a passive "updated N days ago" freshness label (never a nag/modal/block — MC3
 * Resolved decision 2). Base INR is shown as the fixed reference (rate 1, non-editable).
 *
 * All the correctness (parsing, no-float-drift storage, the one `toBase` used
 * everywhere else) lives in `rates.ts` (m9a, untouched here) — this file is
 * pure read + a thin form-action wrapper, matching the categories.ts route's
 * fail()/action shape.
 */
import { formatDate, today } from '@miserly/core';
import { appClock } from '$lib/server/clock';
import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { getDb } from '$lib/server/db/instance';
import { exclusiveWrite } from '$lib/server/write-gate';
import { listRates, setRate, parseRateToScaled, activeForeignCurrencies } from '$lib/server/rates';
import { getUserPrefs, setUserPrefs, getCircleName, setCircleName, baseCurrency } from '$lib/server/settings';
import type { NumberSystem, ForeignGrouping, Theme } from '$lib/prefs';
import {
	listMembers,
	resetMemberPassword,
	removeMember,
	liveUsername,
	NotAdminError,
	LastAdminError,
	SharedOwnershipError,
	MemberNotFoundError
} from '$lib/server/members';
import { createMember } from '$lib/server/auth/users';
import { clientAddress, logAuthEvent } from '$lib/server/auth/auth-log';
import { passwordProblem } from '$lib/server/auth/password-rule';
import { textProblem } from '$lib/text-limits';
import { readActualExport, ActualFileError, MAX_ZIP_BYTES } from '$lib/server/import/actual-read';
import {
	previewImport,
	runImport,
	undoImport,
	undoCheck,
	listImports,
	ImportRefusedError,
	type ImportChoices,
	type AccountChoice
} from '$lib/server/import/actual-import';

/** Whole days between an 'YYYY-MM-DD' `asOf` and today — for the "updated N
 *  days ago" label. Pure date-string arithmetic (civil dates, no timezone). */
function daysAgo(asOf: string, todayIso: string): number {
	const a = new Date(`${asOf}T00:00:00Z`).getTime();
	const b = new Date(`${todayIso}T00:00:00Z`).getTime();
	return Math.max(0, Math.round((b - a) / 86_400_000));
}

/** A rate-surface row: either a set rate (with its age) or "rate needed". */
export interface RateSurfaceRow {
	readonly currency: string;
	readonly rate: number | null;
	readonly asOf: string | null;
	readonly daysAgo: number | null;
	/** MC3 Resolved decision 2: a purely cosmetic hint beyond ~30 days, never blocking. */
	readonly stale: boolean;
}

const STALE_THRESHOLD_DAYS = 30;

export const load: PageServerLoad = async ({ locals, url, request }) => {
	const user = locals.user;
	if (!user) throw redirect(303, '/signin');

	const { db } = getDb();
	const todayIso = formatDate(today(appClock()));
	const isAdmin = user.role === 'admin';

	const [active, rates, prefs, circleName, members] = await Promise.all([
		activeForeignCurrencies(db, user.id),
		Promise.resolve(listRates(db)),
		getUserPrefs(db, user.id, request.headers.get('accept-language')),
		// The Circle name is admin-only chrome (H1) — non-admins never see or edit it.
		isAdmin ? getCircleName(db) : Promise.resolve(null),
		// H3: the admin-only Members roster (identity only — no financial data).
		// Non-admins get an empty list; the Svelte page never renders the section
		// for them regardless (defense in depth, matches the Circle-name pattern).
		isAdmin ? listMembers(db, { id: user.id, role: user.role }) : Promise.resolve([])
	]);
	// F4: this person's imports (newest first) and, for the one Undo can act on, why not or how
	// many rows were typed into its accounts since (the Undo dialog says so).
	const imports = listImports(getDb(), user.id).map((i) => ({ ...i, undo: i.canUndo ? undoCheck(getDb(), user.id, i.id) : null }));
	const rateByCurrency = new Map(rates.map((r) => [r.currency, r]));

	// The active list (viewer-scoped, MC1's activation rule) drives WHICH rows
	// appear — a currency with no live account never shows here, even if a
	// stale rate row for it happens to still be in the store (D3 edge: closed
	// foreign accounts keep their rate but it stays visible only while ≥1 of
	// the viewer's accounts, open or closed, uses that currency).
	const rows: RateSurfaceRow[] = active.map((currency) => {
		const r = rateByCurrency.get(currency);
		if (!r) return { currency, rate: null, asOf: null, daysAgo: null, stale: false };
		const age = daysAgo(r.asOf, todayIso);
		return { currency, rate: r.rate, asOf: r.asOf, daysAgo: age, stale: age > STALE_THRESHOLD_DAYS };
	});

	// MC3's "one-tap set-rate" affordance: the dashboard's "rate needed" nudge
	// links here with `?currency=USD`; the page pre-opens that row's edit form
	// so the round-trip needs no hunting through the list.
	const deepLinkCurrency = url.searchParams.get('currency')?.trim().toUpperCase() || null;

	return {
		baseCurrency: baseCurrency(db),
		rows,
		deepLinkCurrency,
		prefs,
		isAdmin,
		circleName,
		members,
		imports
	};
};

export const actions: Actions = {
	/** Set/replace ONE currency's current rate. Resets its `as_of` to today —
	 *  MC3's "editing a rate updates its timestamp" AC — and every base-currency
	 *  aggregate recomputes on next read through the one shared `toBase`. */
	setRate: async ({ request, locals }) => {
		const user = locals.user;
		if (!user) throw redirect(303, '/signin');

		const form = await request.formData();
		const currency = String(form.get('currency') ?? '').trim().toUpperCase();
		const rateInput = String(form.get('rate') ?? '').trim();

		if (currency === '' || currency === baseCurrency(getDb().db)) {
			return fail(400, { currency, errors: { rate: 'Choose a currency to set' } });
		}
		// Rates are one table for the group, so only someone who holds an account in a currency
		// sets its rate: the same list this page shows them (MC3 RD4). The answer
		// depends only on the actor's own accounts, so it says nothing about anyone else's.
		const db = getDb();
		if (!(await activeForeignCurrencies(db.db, user.id)).includes(currency)) {
			return fail(400, { currency, errors: { rate: `You hold no account in ${currency}, so you can't set its rate.` } });
		}

		let scaledRate: { scaled: number; scale: number };
		try {
			scaledRate = parseRateToScaled(rateInput);
		} catch (err) {
			return fail(400, {
				currency,
				errors: { rate: err instanceof Error ? err.message : 'Enter a valid rate' }
			});
		}

		try {
			setRate(db, currency, scaledRate);
		} catch (err) {
			return fail(400, {
				currency,
				errors: { rate: err instanceof Error ? err.message : 'Could not save the rate' }
			});
		}
		return { saved: true, currency };
	},

	/** SET1 Display prefs: number system, compact default, foreign grouping, theme.
	 *  Display-only (no stored amount/rate/derived value touched) — plain upsert. */
	setDisplay: async ({ request, locals }) => {
		const user = locals.user;
		if (!user) throw redirect(303, '/signin');

		const form = await request.formData();
		const patch = {
			numberSystem: String(form.get('numberSystem') ?? '') as NumberSystem,
			compact: form.get('compact') === 'on',
			foreignGrouping: String(form.get('foreignGrouping') ?? '') as ForeignGrouping,
			theme: String(form.get('theme') ?? '') as Theme
		};

		const db = getDb();
		try {
			await setUserPrefs(db.db, user.id, patch, request.headers.get('accept-language'));
		} catch (err) {
			return fail(400, { displayError: err instanceof Error ? err.message : 'Could not save preferences' });
		}
		return { displaySaved: true };
	},

	/** H1 Circle display name — admin-only (gated here AND in `load`); a blank value clears it. */
	setCircleName: async ({ request, locals }) => {
		const user = locals.user;
		if (!user) throw redirect(303, '/signin');
		if (user.role !== 'admin') {
			return fail(403, { circleNameError: 'Only the admin can rename the group' });
		}

		const form = await request.formData();
		const name = String(form.get('circleName') ?? '');
		const nameProblem = textProblem(name.trim(), 'displayName');
		if (nameProblem) return fail(400, { circleNameError: nameProblem });

		const db = getDb();
		await setCircleName(db.db, name);
		return { circleNameSaved: true };
	},

	/** H3: admin creates a member login with a temp password (`must_change_password`
	 *  forces a change on first sign-in). Gated here AND by the service's own
	 *  `assertAdmin` (defense in depth — same pattern as setCircleName above). */
	addMember: async (event) => {
		const { request, locals } = event;
		const user = locals.user;
		if (!user) throw redirect(303, '/signin');
		if (user.role !== 'admin') {
			return fail(403, { memberError: 'Only the admin can add members' });
		}

		const form = await request.formData();
		const username = String(form.get('username') ?? '').trim();
		const displayName = String(form.get('displayName') ?? '').trim();
		const tempPassword = String(form.get('tempPassword') ?? '');

		if (!username) return fail(400, { memberError: 'Username is required' });
		if (!displayName) return fail(400, { memberError: 'Display name is required' });
		const usernameProblem = textProblem(username, 'username');
		if (usernameProblem) return fail(400, { memberError: `Username: ${usernameProblem.toLowerCase()}` });
		const displayProblem = textProblem(displayName, 'displayName');
		if (displayProblem) return fail(400, { memberError: `Display name: ${displayProblem.toLowerCase()}` });
		// The one password rule (H1 RD, S14), for the temporary one too.
		const problem = passwordProblem(tempPassword, username, 'member');
		if (problem) return fail(400, { memberError: problem });

		const db = getDb();
		try {
			const added = await createMember(db.db, { username, displayName, tempPassword });
			logAuthEvent('member added', { username: added.username, by: user.username, address: clientAddress(event) });
		} catch (err) {
			return fail(400, { memberError: err instanceof Error ? err.message : 'Could not add member' });
		}
		return { memberAdded: true };
	},

	/** H3: admin resets a member's password (forces a change + revokes sessions). */
	resetPassword: async (event) => {
		const { request, locals } = event;
		const user = locals.user;
		if (!user) throw redirect(303, '/signin');
		if (user.role !== 'admin') {
			return fail(403, { memberError: 'Only the admin can reset passwords' });
		}

		const form = await request.formData();
		const targetUserId = String(form.get('targetUserId') ?? '').trim();
		const tempPassword = String(form.get('tempPassword') ?? '');
		const db = getDb();
		const problem = passwordProblem(tempPassword, liveUsername(db.db, targetUserId) ?? '', 'member');
		if (problem) return fail(400, { memberError: problem });

		try {
			const target = await resetMemberPassword(db.db, { id: user.id, role: user.role }, targetUserId, tempPassword);
			logAuthEvent('password reset', { username: target.username, by: user.username, address: clientAddress(event) });
		} catch (err) {
			if (err instanceof NotAdminError) return fail(403, { memberError: err.message });
			if (err instanceof MemberNotFoundError) return fail(404, { memberError: err.message });
			throw err;
		}
		return { passwordReset: true };
	},

	/** H3: admin removes a member. Blocked by the last-admin rule or by shared
	 *  accounts the member solely owns (surfaced so the UI can name them). */
	removeMember: async (event) => {
		const { request, locals } = event;
		const user = locals.user;
		if (!user) throw redirect(303, '/signin');
		if (user.role !== 'admin') {
			return fail(403, { memberError: 'Only the admin can remove members' });
		}

		const targetUserId = String((await request.formData()).get('targetUserId') ?? '').trim();
		const db = getDb();
		try {
			const gone = await removeMember(db.db, { id: user.id, role: user.role }, targetUserId);
			logAuthEvent('member removed', { username: gone.username, by: user.username, address: clientAddress(event) });
		} catch (err) {
			if (err instanceof NotAdminError) return fail(403, { memberError: err.message });
			if (err instanceof LastAdminError) return fail(400, { memberError: err.message });
			if (err instanceof SharedOwnershipError) {
				return fail(409, { memberError: err.message, blockedAccounts: err.accounts });
			}
			if (err instanceof MemberNotFoundError) return fail(404, { memberError: err.message });
			throw err;
		}
		return { memberRemoved: true };
	},

	/** F4: read Actual's export and return the preview. Nothing is written. */
	importPreview: async ({ request, locals }) => {
		const user = locals.user;
		if (!user) throw redirect(303, '/signin');
		const file = await uploadedZip(request);
		if ('importError' in file) return fail(400, file);
		try {
			const budget = readActualExport(file.bytes);
			return { importPreview: previewImport(getDb(), user.id, budget), importFileName: file.name };
		} catch (err) {
			if (err instanceof ActualFileError) return fail(400, { importError: err.message });
			throw err;
		}
	},

	/** F4: import the file (sent again with the choices), in one transaction. It runs alone among
	 *  writes and gives the thread back as it goes, so other members' pages go on. */
	importRun: async ({ request, locals }) => {
		const user = locals.user;
		if (!user) throw redirect(303, '/signin');
		const form = await request.formData();
		const file = await uploadedZip(form);
		if ('importError' in file) return fail(400, file);
		const choices = parseChoices(String(form.get('choices') ?? ''));
		if (!choices) return fail(400, { importError: 'Something in the list was unreadable. Open the file again.' });
		try {
			const budget = readActualExport(file.bytes);
			const result = await exclusiveWrite(() => runImport(getDb(), user.id, budget, file.name, choices));
			return { imported: result };
		} catch (err) {
			if (err instanceof ActualFileError || err instanceof ImportRefusedError) return fail(400, { importError: err.message });
			throw err;
		}
	},

	/** F4: Undo import, the latest one (refused while an account it made is shared). */
	undoImport: async ({ request, locals }) => {
		const user = locals.user;
		if (!user) throw redirect(303, '/signin');
		const importId = String((await request.formData()).get('importId') ?? '');
		try {
			undoImport(getDb(), user.id, importId);
		} catch (err) {
			if (err instanceof ImportRefusedError) return fail(400, { undoError: err.message });
			throw err;
		}
		return { importUndone: true };
	}
};

/** The uploaded zip of a form (field `file`), or the message for its absence or size. */
async function uploadedZip(source: Request | FormData): Promise<{ bytes: Buffer; name: string } | { importError: string }> {
	const form = source instanceof Request ? await source.formData() : source;
	const file = form.get('file');
	if (!(file instanceof File) || file.size === 0) return { importError: 'Choose the zip Actual saved.' };
	if (file.size > MAX_ZIP_BYTES) return { importError: 'This file is too large to import (over 60 MB).' };
	return { bytes: Buffer.from(await file.arrayBuffer()), name: file.name.slice(0, 200) };
}

/** The preview's choices as posted (JSON), checked field by field; null when malformed. */
function parseChoices(raw: string): ImportChoices | null {
	try {
		const v = JSON.parse(raw) as { accounts?: unknown; groupKinds?: unknown };
		if (!v || typeof v !== 'object' || !v.accounts || typeof v.accounts !== 'object') return null;
		const accounts: Record<string, AccountChoice> = {};
		for (const [id, c] of Object.entries(v.accounts as Record<string, Record<string, unknown>>)) {
			if (!c || typeof c.addAs !== 'string' || typeof c.name !== 'string' || c.name.length > 200) return null;
			accounts[id] = { include: c.include === true, addAs: c.addAs, name: c.name, deposits: c.deposits === 'moneyIn' ? 'moneyIn' : 'return' };
		}
		const groupKinds: Record<string, 'spending' | 'investments'> = {};
		for (const [id, k] of Object.entries((v.groupKinds ?? {}) as Record<string, unknown>)) {
			groupKinds[id] = k === 'investments' ? 'investments' : 'spending';
		}
		return { accounts, groupKinds };
	} catch {
		return null;
	}
}
