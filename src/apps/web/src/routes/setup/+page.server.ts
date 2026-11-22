/** First-run ceremony: create the admin, start a session, hand off to the app (H1). */
import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { retireSetupCode, setupCodeMatches, setupCodeRequired } from '$lib/server/auth/setup-code';
import { getDb } from '$lib/server/db/instance';
import { ADMIN_EXISTS, adminExists, createAdmin } from '$lib/server/auth/users';
import { seedStarterCategories } from '$lib/server/seed';
import { createSession } from '$lib/server/auth/session';
import { SESSION_CONFIG, cookieOptions, sessionCookieName } from '$lib/server/config';
import { passwordProblem } from '$lib/server/auth/password-rule';
import { textProblem } from '$lib/text-limits';
import { setCircleName } from '$lib/server/settings';
import { defaultYearStartFor, isBaseCurrencyChoice, parseYearStart, type YearStartMonth } from '$lib/currencies';

/** Whether the form shows the setup code field (a hosted instance, H1 RD13). */
export const load: PageServerLoad = () => ({ needsCode: setupCodeRequired() });

export const actions: Actions = {
	default: async ({ request, cookies, url }) => {
		const { db } = getDb();
		// hooks.server already guards this route to fresh instances only, but a
		// racing double-submit must not create a second admin (single Circle, H1).
		if (await adminExists(db)) {
			return fail(400, { message: 'Setup has already been completed' });
		}

		const form = await request.formData();
		// A hosted instance asks for the code its server printed at start (S8, H1 RD13), so the
		// first person to reach the port can't take it over.
		if (setupCodeRequired()) {
			const typed = String(form.get('setupCode') ?? '').trim();
			if (typed === '') return fail(400, { message: "Enter the setup code from the server's log." });
			if (!setupCodeMatches(typed)) {
				return fail(400, {
					message: "That isn't the latest setup code. Each start prints a new one: use the last “miserly setup code:” line in the server's log."
				});
			}
		}
		const username = String(form.get('username') ?? '').trim();
		const displayName = String(form.get('displayName') ?? '').trim() || username;
		const password = String(form.get('password') ?? '');
		const circleName = String(form.get('circleName') ?? '').trim();
		// MC1 RD2 amended, R1: the currency totals are in and the year start, chosen here once.
		// A form without them (a script, an old page) writes no row: the readers fall back to rupees
		// and April, as for an instance set up before the choice existed.
		const currencyRaw = String(form.get('baseCurrency') ?? '').trim().toUpperCase();
		const yearRaw = String(form.get('yearStart') ?? '').trim();

		if (!username) return fail(400, { message: 'Username is required' });
		for (const [label, value, kind] of [
			['Username', username, 'username'],
			['Display name', displayName, 'displayName'],
			['Group name', circleName, 'displayName']
		] as const) {
			const problem = textProblem(value, kind);
			if (problem) return fail(400, { message: `${label}: ${problem.toLowerCase()}.` });
		}
		const problem = passwordProblem(password, username);
		if (problem) return fail(400, { message: problem });
		let instance: { baseCurrency: string; yearStartMonth: YearStartMonth } | undefined;
		if (currencyRaw !== '') {
			if (!isBaseCurrencyChoice(currencyRaw)) return fail(400, { message: 'Choose a currency for totals from the list.' });
			const yearStartMonth = yearRaw === '' ? defaultYearStartFor(currencyRaw) : parseYearStart(yearRaw);
			if (yearStartMonth === null) return fail(400, { message: 'Choose January or April for the year start.' });
			instance = { baseCurrency: currencyRaw, yearStartMonth };
		}

		let admin;
		try {
			admin = await createAdmin(db, { username, displayName, password, instance });
		} catch (e) {
			if (e instanceof Error && e.message === ADMIN_EXISTS) {
				return fail(400, { message: 'Setup has already been completed' });
			}
			throw e;
		}
		retireSetupCode();
		// The Circle's starter taxonomy is born with the Circle (idempotent).
		await seedStarterCategories(db);
		// H1: an optional display name for the instance, captured once at setup
		// (also editable later from Settings → Circle, admin-only).
		if (circleName !== '') await setCircleName(db, circleName);
		const issued = await createSession(db, admin.id, SESSION_CONFIG);
		cookies.set(sessionCookieName(url), issued.token, cookieOptions(url.protocol === 'https:'));

		throw redirect(303, '/');
	}
};
