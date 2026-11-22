/**
 * All transactions' next page: the rows after `after` (newest first), with the same search,
 * as the person scrolls. Viewer-scoped as the page is (`activityPage` reads only the viewer's open
 * visible accounts).
 */
import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db/instance';
import { activityPage, cursorText, parseCursor } from '$lib/server/dashboard';
import { pageSize } from '$lib/list-pages';

export const GET: RequestHandler = async ({ locals, url }) => {
	const user = locals.user;
	if (!user) throw error(401, 'Not signed in');
	const after = parseCursor(url.searchParams.get('after'));
	if (url.searchParams.has('after') && !after) throw error(400, 'Bad cursor');
	const q = url.searchParams.get('q')?.trim() ?? '';
	const page = await activityPage(getDb(), user.id, { limit: pageSize(url), q: q || undefined, after });
	return json({ rows: page.rows, next: page.next ? cursorText(page.next) : null });
};
