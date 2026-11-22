/**
 * /transactions — All transactions (D4 RD6): every visible account's
 * rows in one list, newest first by (date, sequence), with search and an Account column.
 * Linked from the sidebar and from recent activity's "View all". It reads the D4 feed
 * (`recentActivity`), so it is viewer-scoped through `accountsVisibleTo` and a transfer is
 * one "A → B" row, never two legs.
 *
 * ACTUAL-PARITY #5: it edits in place and adds rows, as Actual's All accounts. The first page of
 * rows comes with the page and the rest by pages as the person scrolls (`rows/+server.ts`);
 * the page draws only the rows in view. A cell's edit and a new row post to the
 * row's own account (`/accounts/<id>?/editTx`, `?/addTransaction`, which check visibility), and
 * the selection's Delete and Set category post here (`bulkUpdate` checks every id). The Account
 * cell moves a row to another account (`moveTx`, as Actual's All accounts).
 */
import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { getDb } from '$lib/server/db/instance';
import { activityPage, cursorText } from '$lib/server/dashboard';
import { firstPageSize } from '$lib/list-pages';
import {
	bulkUpdate,
	restoreTransactions,
	moveTransaction,
	AccountNotFoundError,
	ClosedAccountError,
	InvalidCategoryError,
	MoveTransactionError,
	StaleEditError,
	TransferEditError,
	type BulkAction
} from '$lib/server/transactions';

export const load: PageServerLoad = async ({ locals, url }) => {
	const user = locals.user;
	if (!user) throw redirect(303, '/signin');

	const db = getDb();
	const q = url.searchParams.get('q')?.trim() ?? '';
	const n = firstPageSize(url);
	const page = await activityPage(db, user.id, { limit: n, q: q || undefined });
	// Accounts, payees and categories come from the layout (Quick add's lists, the same ones): a
	// save reloads the layout alone and they stay current.
	return {
		q,
		rows: page.rows,
		// Where the next page starts (the scroll asks `rows?after=`), null when this is all.
		next: page.next ? cursorText(page.next) : null
	};
};

export const actions: Actions = {
	/** The selection's Delete and Set category (the register's bulk action, any visible rows). */
	bulkTx: async ({ request, locals }) => {
		const user = locals.user;
		if (!user) throw redirect(303, '/signin');
		const form = await request.formData();
		const ids = form.getAll('ids').map(String).filter(Boolean);
		const op = String(form.get('op') ?? '');
		let action: BulkAction;
		if (op === 'delete') action = { kind: 'delete' };
		else if (op === 'setCategory') action = { kind: 'setCategory', categoryId: String(form.get('categoryId') ?? '') || null };
		else return fail(400, { errors: { _: 'Unknown bulk action' } });
		try {
			const res = await bulkUpdate(getDb(), { userId: user.id }, ids, action);
			return { bulked: true, op, ...res };
		} catch (err) {
			if (err instanceof InvalidCategoryError) return fail(400, { errors: { _: err.message } });
			throw err;
		}
	},
	/** The Account cell: move a row to another account. */
	moveTx: async ({ request, locals }) => {
		const user = locals.user;
		if (!user) throw redirect(303, '/signin');
		const form = await request.formData();
		try {
			await moveTransaction(getDb(), { userId: user.id }, String(form.get('txId') ?? ''), String(form.get('accountId') ?? ''), String(form.get('updatedAt') ?? ''));
			return { moved: true };
		} catch (err) {
			if (err instanceof AccountNotFoundError) throw error(404, 'Not found');
			if (err instanceof StaleEditError) return fail(409, { errors: { _: 'This row changed since the page loaded. Try again.' } });
			if (err instanceof ClosedAccountError) return fail(400, { errors: { _: "A closed account's rows don't move" } });
			if (err instanceof MoveTransactionError || err instanceof TransferEditError) return fail(400, { errors: { _: err.message } });
			throw err;
		}
	},
	/** Undo of a selection's Delete. */
	restoreBulkTx: async ({ request, locals }) => {
		const user = locals.user;
		if (!user) throw redirect(303, '/signin');
		const ids = (await request.formData()).getAll('ids').map(String).filter(Boolean);
		try {
			const { restored } = await restoreTransactions(getDb(), { userId: user.id }, ids);
			return { restored: true, restoredCount: restored };
		} catch (err) {
			if (err instanceof AccountNotFoundError) throw error(404, 'Not found');
			if (err instanceof ClosedAccountError) return fail(400, { errors: { _: err.message } });
			throw err;
		}
	}
};
