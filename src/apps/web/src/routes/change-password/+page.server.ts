/**
 * Change password: verifies the current password unless the change is FORCED
 * (`must_change_password`), then invalidates the user's OTHER sessions (H1) —
 * the current session (this cookie's token) is kept.
 */
import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { getDb } from '$lib/server/db/instance';
import { mustChangePassword, changePassword, verifyCredentials } from '$lib/server/auth/users';
import { invalidateOtherSessions } from '$lib/server/auth/session';
import { sessionCookieName } from '$lib/server/config';
import { passwordProblem } from '$lib/server/auth/password-rule';

export const load: PageServerLoad = async ({ locals }) => {
	const user = locals.user;
	if (!user) throw redirect(303, '/signin');
	const { db } = getDb();
	return { forced: await mustChangePassword(db, user.id) };
};

export const actions: Actions = {
	default: async ({ request, locals, cookies, url }) => {
		const user = locals.user;
		if (!user) throw redirect(303, '/signin');

		const { db } = getDb();
		const forced = await mustChangePassword(db, user.id);

		const form = await request.formData();
		const currentPassword = String(form.get('currentPassword') ?? '');
		const newPassword = String(form.get('newPassword') ?? '');
		const confirmPassword = String(form.get('confirmPassword') ?? '');

		if (!forced) {
			const verified = await verifyCredentials(db, user.username, currentPassword);
			if (!verified) {
				return fail(400, { message: 'Current password is incorrect' });
			}
		}
		const problem = passwordProblem(newPassword, user.username);
		if (problem) {
			return fail(400, { message: problem });
		}
		if (newPassword !== confirmPassword) {
			return fail(400, { message: 'Passwords do not match' });
		}

		await changePassword(db, user.id, newPassword);

		const token = cookies.get(sessionCookieName(url));
		if (token) {
			await invalidateOtherSessions(db, user.id, token);
		}

		throw redirect(303, '/');
	}
};
