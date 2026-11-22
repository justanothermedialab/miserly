/**
 * inbox (C5) — the "To categorize" view. Lists the viewer's uncategorized,
 * non-transfer spending rows (derived membership; no stored flag) and clears them
 * one at a time or in bulk, reusing the C4 bulk service. Everything is
 * viewer-scoped inside the services.
 */
import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { getDb } from '$lib/server/db/instance';
import { inboxTransactions, inboxPage, inboxSummary, bulkUpdate, InvalidCategoryError } from '$lib/server/transactions';
import { listCategoryTree } from '$lib/server/categories';
import { cursorText } from '$lib/server/dashboard';
import { firstPageSize } from '$lib/list-pages';

export const load: PageServerLoad = async ({ locals, url }) => {
	const user = locals.user;
	if (!user) throw redirect(303, '/signin');
	const db = getDb();
	// The newest page of rows, the rest by pages as the list scrolls (`rows/+server.ts`); the
	// header's figures are counted in SQL.
	const [page, summary, groups] = await Promise.all([
		inboxPage(db, user.id, { limit: firstPageSize(url) }),
		inboxSummary(db, user.id),
		listCategoryTree(db.db)
	]);
	return {
		rows: page.rows,
		next: page.next ? cursorText(page.next) : null,
		total: summary.total,
		suggested: summary.suggested,
		categoryGroups: groups.map((g) => ({
			id: g.id,
			name: g.name,
			categories: g.categories.map((c) => ({ id: c.id, name: c.name }))
		}))
	};
};

export const actions: Actions = {
	/** Categorize one or many inbox rows (reuses the C4 bulk service, atomic). */
	categorize: async ({ request, locals }) => {
		const user = locals.user;
		if (!user) throw redirect(303, '/signin');
		const form = await request.formData();
		const ids = form.getAll('ids').map(String).filter(Boolean);
		const categoryId = String(form.get('categoryId') ?? '');
		if (ids.length === 0) return fail(400, { errors: { _: 'Select at least one row' } });
		if (categoryId === '') return fail(400, { errors: { _: 'Choose a category' } });
		try {
			const res = await bulkUpdate(getDb(), { userId: user.id }, ids, {
				kind: 'setCategory',
				categoryId
			});
			// The ids let the message offer Undo.
			return { categorized: true, affected: res.affected, ids };
		} catch (err) {
			if (err instanceof InvalidCategoryError) return fail(400, { errors: { _: err.message } });
			throw err;
		}
	},

	/**
	 * Apply every row's remembered-category suggestion (F3) in one action.
	 * Re-derives the suggestions server-side (never trusts the client), groups the
	 * rows by suggested category, and clears each group via the same bulk service.
	 */
	applySuggestions: async ({ locals }) => {
		const user = locals.user;
		if (!user) throw redirect(303, '/signin');
		const db = getDb();
		const rows = await inboxTransactions(db, user.id);
		const byCategory = new Map<string, string[]>();
		for (const r of rows) {
			if (!r.suggestedCategoryId) continue;
			const list = byCategory.get(r.suggestedCategoryId) ?? [];
			list.push(r.id);
			byCategory.set(r.suggestedCategoryId, list);
		}
		if (byCategory.size === 0) return fail(400, { errors: { _: 'No suggestions to apply' } });
		let affected = 0;
		const done: string[] = [];
		try {
			for (const [categoryId, ids] of byCategory) {
				const res = await bulkUpdate(db, { userId: user.id }, ids, { kind: 'setCategory', categoryId });
				affected += res.affected;
				done.push(...ids);
			}
		} catch (err) {
			if (err instanceof InvalidCategoryError) return fail(400, { errors: { _: err.message } });
			throw err;
		}
		return { categorized: true, affected, ids: done };
	},

	/** Undo a categorize, as Gmail undoes an archive. The rows came from the inbox,
	 *  so they were uncategorized: they go back to it. Viewer-scoped inside the service. */
	uncategorize: async ({ request, locals }) => {
		const user = locals.user;
		if (!user) throw redirect(303, '/signin');
		const ids = (await request.formData()).getAll('ids').map(String).filter(Boolean);
		if (ids.length === 0) return fail(400, { errors: { _: 'Nothing to undo' } });
		const res = await bulkUpdate(getDb(), { userId: user.id }, ids, { kind: 'setCategory', categoryId: null });
		return { restored: true, restoredCount: res.affected };
	}
};
