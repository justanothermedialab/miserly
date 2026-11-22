/**
 * Dismiss the "Your password was reset by the admin" notice (S4, H3 RD9). The layout's notice
 * POSTs here when the person closes it; it clears their own `password_reset_at` and nothing
 * else. Same-origin only (SvelteKit's CSRF origin check applies to this POST).
 */
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db/instance';
import { dismissPasswordResetNotice } from '$lib/server/auth/users';

export const POST: RequestHandler = async ({ locals }) => {
	const user = locals.user;
	if (!user) throw error(401, 'Not signed in');
	dismissPasswordResetNotice(getDb().db, user.id);
	return json({ ok: true });
};
