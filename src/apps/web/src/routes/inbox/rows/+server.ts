/**
 * The Inbox's next page: the uncategorized rows after `after` (newest first), as the list
 * scrolls. Viewer-scoped as the page is (`inboxPage` reads only the viewer's visible accounts, on
 * the dates they hold them).
 */
import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db/instance';
import { inboxPage } from '$lib/server/transactions';
import { cursorText, parseCursor } from '$lib/server/dashboard';
import { pageSize } from '$lib/list-pages';

export const GET: RequestHandler = async ({ locals, url }) => {
	const user = locals.user;
	if (!user) throw error(401, 'Not signed in');
	const after = parseCursor(url.searchParams.get('after'));
	if (!after) throw error(400, 'Bad cursor');
	const page = await inboxPage(getDb(), user.id, { limit: pageSize(url), after });
	return json({ rows: page.rows, next: page.next ? cursorText(page.next) : null });
};
