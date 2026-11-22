/**
 * A register's next page: the rows before `before` (older), each with its running balance
 * over the whole account, as the register scrolls. The same visibility as the page: an account the
 * viewer can't read is "not found", as a bogus id (P0).
 */
import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db/instance';
import { registerView, parseRegisterCursor, AccountNotFoundError } from '$lib/server/transactions';
import { pageSize } from '$lib/list-pages';

export const GET: RequestHandler = async ({ locals, params, url }) => {
	const user = locals.user;
	if (!user) throw error(401, 'Not signed in');
	const before = parseRegisterCursor(url.searchParams.get('before'));
	if (!before) throw error(400, 'Bad cursor');
	try {
		const view = await registerView(getDb(), user.id, params.id, { limit: pageSize(url), before });
		return json({ rows: view.rows, next: view.next });
	} catch (err) {
		if (err instanceof AccountNotFoundError) throw error(404, 'Not found');
		throw err;
	}
};
