/** Sign out: hard-delete the session row (immediate revocation) and clear the cookie. */
import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db/instance';
import { invalidateSession } from '$lib/server/auth/session';
import { sessionCookieName } from '$lib/server/config';

export const POST: RequestHandler = async ({ cookies, url }) => {
	const token = cookies.get(sessionCookieName(url));
	if (token) {
		const { db } = getDb();
		await invalidateSession(db, token);
	}
	cookies.delete(sessionCookieName(url), { path: '/' });
	// Switch account (the account menu): the same sign-out, then a sign-in that
	// says it is for another member.
	throw redirect(303, url.searchParams.has('switch') ? '/signin?switch=1' : '/signin');
};
