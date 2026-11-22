/**
 * Payee manager (F3): the viewer-scoped payee list with rename, delete and
 * multi-select merge (no Hide: F3 RD3). The list funnels through `listPayeesFor` (→
 * `accountsVisibleTo`, the P0 predicate) — only payees seen on a visible account,
 * NEVER "all payees". Before any transactions exist (M5) this is typically empty,
 * and the manager shows the empty state — that's expected, not a bug.
 *
 * Rename that collides with another payee's identity throws
 * `PayeeNameConflictError`; the route surfaces the conflicting id so the user can
 * merge instead of silently duplicating identity.
 */
import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { getDb } from '$lib/server/db/instance';
import {
	listPayeesWithStats,
	renamePayeeFor,
	deletePayeeFor,
	mergePayeesFor,
	isPayeeVisibleTo,
	setRememberedCategory,
	createPayeeFor,
	PayeeNameConflictError
} from '$lib/server/payees';
import { listCategoryTree } from '$lib/server/categories';
import { parseForm, payeeNameSchema } from '$lib/server/validation';

export const load: PageServerLoad = async ({ locals }) => {
	const user = locals.user;
	if (!user) throw redirect(303, '/signin');
	const payees = await listPayeesWithStats(getDb().db, user.id);
	// The Default category picker: each visible group's visible categories.
	const categoryGroups = (await listCategoryTree(getDb().db))
		.filter((g) => !g.hidden)
		.map((g) => ({ name: g.name, categories: g.categories.filter((c) => !c.hidden).map((c) => ({ id: c.id, name: c.name })) }));
	return { payees, categoryGroups };
};

/** Every action acts only on a payee the viewer can see; any other id is "not found" (P0). */
const NOT_FOUND = { message: 'That payee is no longer here. Reload the page.' };
async function visible(userId: string, id: string): Promise<boolean> {
	return id !== '' && (await isPayeeVisibleTo(getDb().db, userId, id));
}

export const actions: Actions = {
	/** F3 RD7: the New payee row. Name required, default category optional. */
	create: async ({ request, locals }) => {
		if (!locals.user) throw redirect(303, '/signin');
		const form = await request.formData();
		const parsed = parseForm(payeeNameSchema, form);
		if (!parsed.success) return fail(400, { errors: parsed.errors });
		const categoryId = String(form.get('categoryId') ?? '');
		try {
			await createPayeeFor(getDb().db, locals.user.id, parsed.data.displayName, categoryId === '' ? null : categoryId);
		} catch (err) {
			if (err instanceof PayeeNameConflictError) return fail(400, { message: err.message, conflictingId: err.conflictingId });
			return fail(400, { message: err instanceof Error ? err.message : 'Could not add the payee' });
		}
		return { created: true };
	},

	rename: async ({ request, locals }) => {
		if (!locals.user) throw redirect(303, '/signin');
		const form = await request.formData();
		const id = String(form.get('id') ?? '');
		const parsed = parseForm(payeeNameSchema, form);
		if (!parsed.success) return fail(400, { errors: parsed.errors });
		if (!(await visible(locals.user.id, id))) return fail(404, NOT_FOUND);
		try {
			// Changes only the viewer's rows when others use the payee too, and answers the same
			// whether or not the name is used on accounts the viewer can't see (P0).
			await renamePayeeFor(getDb().db, locals.user.id, id, parsed.data.displayName);
		} catch (err) {
			if (err instanceof PayeeNameConflictError) {
				return fail(400, { message: err.message, conflictingId: err.conflictingId, renameId: id });
			}
			throw err;
		}
		return { ok: true };
	},

	/** The payee's default category (the category a new row with it fills in), set in place. */
	setCategory: async ({ request, locals }) => {
		if (!locals.user) throw redirect(303, '/signin');
		const form = await request.formData();
		const id = String(form.get('id') ?? '');
		const categoryId = String(form.get('categoryId') ?? '');
		if (!(await visible(locals.user.id, id))) return fail(404, NOT_FOUND);
		try {
			await setRememberedCategory(getDb().db, locals.user.id, id, categoryId === '' ? null : categoryId);
		} catch (err) {
			return fail(400, { message: err instanceof Error ? err.message : 'Could not set the category' });
		}
		return { ok: true };
	},

	/** Hard-delete (F3 RD3): transactions keep working with payee = none. */
	delete: async ({ request, locals }) => {
		if (!locals.user) throw redirect(303, '/signin');
		const id = String((await request.formData()).get('id') ?? '');
		if (!(await visible(locals.user.id, id))) return fail(404, NOT_FOUND);
		await deletePayeeFor(getDb().db, locals.user.id, id);
		return { ok: true };
	},

	merge: async ({ request, locals }) => {
		if (!locals.user) throw redirect(303, '/signin');
		const form = await request.formData();
		const targetId = String(form.get('targetId') ?? '');
		const loserIds = form.getAll('loserIds').map((v) => String(v)).filter((v) => v !== '');
		if (targetId === '' || loserIds.length === 0) {
			return fail(400, { message: 'Pick a target payee and at least one payee to merge into it' });
		}
		for (const id of [targetId, ...loserIds]) if (!(await visible(locals.user.id, id))) return fail(404, NOT_FOUND);
		try {
			await mergePayeesFor(getDb().db, locals.user.id, targetId, loserIds);
		} catch (err) {
			return fail(400, { message: err instanceof Error ? err.message : 'Could not merge payees' });
		}
		return { ok: true };
	}
};
