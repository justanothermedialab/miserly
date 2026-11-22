/**
 * Persist the viewer's theme preference (SET1). The top-bar light/dark toggle
 * POSTs here so the choice survives a reload/other devices — the same
 * `setUserPrefs` the Settings page uses. Same-origin only (SvelteKit's CSRF
 * origin check applies to this POST).
 */
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db/instance';
import { setUserPrefs } from '$lib/server/settings';

export const POST: RequestHandler = async ({ request, locals }) => {
	const user = locals.user;
	if (!user) throw error(401, 'Not signed in');

	const body = (await request.json().catch(() => ({}))) as { theme?: unknown };
	const theme = body.theme;
	if (theme !== 'light' && theme !== 'dark' && theme !== 'black' && theme !== 'system') {
		throw error(400, 'theme must be light | dark | system');
	}

	await setUserPrefs(getDb().db, user.id, { theme });
	return json({ ok: true, theme });
};
