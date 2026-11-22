/** Sign in: generic errors, per-username lockout, session creation, deep-link redirect (H1). */
import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { getDb } from '$lib/server/db/instance';
import { verifyCredentials, takeAttempt, resetFailures, withCheckSlot } from '$lib/server/auth/users';
import { createSession } from '$lib/server/auth/session';
import { clientAddress, logAuthEvent } from '$lib/server/auth/auth-log';
import { SESSION_CONFIG, cookieOptions, sessionCookieName } from '$lib/server/config';

const GENERIC_ERROR = 'Invalid username or password';
const TOO_MANY = 'Too many attempts. Try again later.';

/**
 * Only ever redirect to a path on this site. Browsers read `\` as `/` and drop tabs and newlines
 * inside an address, so `/\evil.example` is another site: a target is kept
 * only if it starts with one `/`, has no backslash or control character, and still resolves to
 * this origin.
 */
const BASE = 'http://miserly.invalid';
function safeRedirectTarget(raw: string | null): string {
	if (!raw) return '/';
	if (!raw.startsWith('/') || raw.startsWith('//')) return '/';
	// eslint-disable-next-line no-control-regex
	if (/[\\\u0000-\u001f\u007f]/u.test(raw)) return '/';
	try {
		if (new URL(raw, BASE).origin !== BASE) return '/';
	} catch {
		return '/';
	}
	return raw;
}

export const load: PageServerLoad = ({ url }) => {
	return { redirectTo: safeRedirectTarget(url.searchParams.get('redirectTo')) };
};

export const actions: Actions = {
	default: async (event) => {
		const { request, cookies, url } = event;
		const form = await request.formData();
		const username = String(form.get('username') ?? '').trim();
		const password = String(form.get('password') ?? '');

		if (!username || !password) {
			return fail(400, { message: GENERIC_ERROR });
		}
		// The try is counted before its password is checked (S1), so tries sent together can't
		// all pass the lockout question before the first of them has failed.
		const turn = takeAttempt(username);
		if (turn === 'refused') {
			return fail(429, { message: TOO_MANY });
		}

		const { db } = getDb();
		const checked = await withCheckSlot(() => verifyCredentials(db, username, password));
		if (!checked) return fail(429, { message: TOO_MANY });
		const user = checked.value;
		if (!user) {
			// One line per failed try, and one when the last try of the window fails (S13).
			const address = clientAddress(event);
			logAuthEvent('sign-in failed', { username, address });
			if (turn === 'last') logAuthEvent('sign-in locked', { username, address });
			return fail(400, { message: GENERIC_ERROR });
		}
		resetFailures(username);

		const issued = await createSession(db, user.id, SESSION_CONFIG);
		cookies.set(sessionCookieName(url), issued.token, cookieOptions(url.protocol === 'https:'));

		throw redirect(303, safeRedirectTarget(url.searchParams.get('redirectTo')));
	}
};
