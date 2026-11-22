/**
 * Persist the viewer's accent colour (SET1). The Settings swatches POST here,
 * like the theme, so the choice survives a reload and other devices. Same-origin only.
 */
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db/instance';
import { setUserPrefs } from '$lib/server/settings';
import { ACCENTS, type Accent } from '$lib/prefs';

export const POST: RequestHandler = async ({ request, locals }) => {
	const user = locals.user;
	if (!user) throw error(401, 'Not signed in');

	const body = (await request.json().catch(() => ({}))) as { accent?: unknown };
	const accent = body.accent;
	if (typeof accent !== 'string' || !(ACCENTS as readonly string[]).includes(accent)) {
		throw error(400, `accent must be ${ACCENTS.join(' | ')}`);
	}

	await setUserPrefs(getDb().db, user.id, { accent: accent as Accent });
	return json({ ok: true, accent });
};
