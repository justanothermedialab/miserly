/**
 * Category manager (F2): the group → category tree with create / rename /
 * set-kind / hide / delete, plus a show-hidden toggle (?hidden=1). Category
 * delete offers a reassignment target (a live category, or Uncategorized = null);
 * group delete is guarded (must be emptied first). Categories are Circle-wide
 * (not per-account), so there is no viewer-scoping here — every signed-in member
 * shares the one taxonomy (F2). One exception (F2 RD): a delete, or a
 * group kind change, is refused when rows the actor can't see sit under it. All routes are
 * authed via hooks.server.
 */
import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { getDb } from '$lib/server/db/instance';
import * as schema from '$lib/server/db/schema';
import { isNull } from 'drizzle-orm';
import {
	createGroup,
	renameGroup,
	setGroupKind,
	hideGroup,
	unhideGroup,
	deleteGroup,
	createCategory,
	renameCategory,
	moveCategory,
	setColour,
	hideCategory,
	unhideCategory,
	setCountsAsReturn,
	deleteCategory,
	listCategoryTree,
	CategoryNameConflictError,
	OtherMembersRowsError,
	GroupNotEmptyError,
	SystemCategoryError,
	CategoryReassignRequiredError,
	type Kind
} from '$lib/server/categories';
import {
	parseForm,
	groupCreateSchema,
	groupRenameSchema,
	categoryCreateSchema,
	categoryRenameSchema
} from '$lib/server/validation';

const KINDS = ['income', 'spending', 'investments', 'neutral'] as const;
function asKind(value: string): Kind | null {
	return (KINDS as readonly string[]).includes(value) ? (value as Kind) : null;
}

/** Map the F2 domain errors to a friendly action failure. Re-throws the rest. */
function failFor(err: unknown) {
	if (
		err instanceof CategoryNameConflictError ||
		err instanceof GroupNotEmptyError ||
		err instanceof CategoryReassignRequiredError ||
		err instanceof SystemCategoryError ||
		err instanceof OtherMembersRowsError
	) {
		return fail(400, { message: err.message });
	}
	throw err;
}

export const load: PageServerLoad = async ({ locals, url }) => {
	if (!locals.user) throw redirect(303, '/signin');
	const includeHidden = url.searchParams.get('hidden') === '1';
	const tree = await listCategoryTree(getDb().db, { includeHidden });
	// A flat list of live categories for the "move" + "reassign on delete" pickers.
	const allCategories = (await listCategoryTree(getDb().db, { includeHidden: false })).flatMap((g) =>
		g.categories.map((c) => ({ id: c.id, name: c.name, groupId: g.id, groupName: g.name }))
	);
	// Categories are one list for the whole group (F2): with more than one member, the edit and delete
	// dialogs say so. A count of people, never of anyone's rows (P0).
	const memberCount = getDb().db.select({ id: schema.users.id }).from(schema.users).where(isNull(schema.users.deletedAt)).all().length;
	return { tree, allCategories, includeHidden, shared: memberCount > 1 };
};

export const actions: Actions = {
	createGroup: async ({ request, locals }) => {
		if (!locals.user) throw redirect(303, '/signin');
		const parsed = parseForm(groupCreateSchema, await request.formData());
		if (!parsed.success) return fail(400, { errors: parsed.errors });
		try {
			await createGroup(getDb().db, parsed.data);
		} catch (err) {
			return failFor(err);
		}
		return { ok: true };
	},

	renameGroup: async ({ request, locals }) => {
		if (!locals.user) throw redirect(303, '/signin');
		const form = await request.formData();
		const id = String(form.get('id') ?? '');
		const parsed = parseForm(groupRenameSchema, form);
		if (!parsed.success) return fail(400, { errors: parsed.errors });
		try {
			await renameGroup(getDb().db, id, parsed.data.name);
		} catch (err) {
			return failFor(err);
		}
		return { ok: true };
	},

	setGroupKind: async ({ request, locals }) => {
		if (!locals.user) throw redirect(303, '/signin');
		const form = await request.formData();
		const id = String(form.get('id') ?? '');
		const kind = asKind(String(form.get('kind') ?? ''));
		if (!kind) return fail(400, { message: 'Choose a valid kind' });
		try {
			await setGroupKind(getDb().db, id, kind, { userId: locals.user.id });
		} catch (err) {
			return failFor(err);
		}
		return { ok: true };
	},

	hideGroup: async ({ request, locals }) => {
		if (!locals.user) throw redirect(303, '/signin');
		const id = String((await request.formData()).get('id') ?? '');
		await hideGroup(getDb().db, id);
		return { ok: true };
	},

	unhideGroup: async ({ request, locals }) => {
		if (!locals.user) throw redirect(303, '/signin');
		const id = String((await request.formData()).get('id') ?? '');
		await unhideGroup(getDb().db, id);
		return { ok: true };
	},

	deleteGroup: async ({ request, locals }) => {
		if (!locals.user) throw redirect(303, '/signin');
		const id = String((await request.formData()).get('id') ?? '');
		try {
			await deleteGroup(getDb().db, id, { userId: locals.user.id });
		} catch (err) {
			return failFor(err);
		}
		return { ok: true };
	},

	createCategory: async ({ request, locals }) => {
		if (!locals.user) throw redirect(303, '/signin');
		const form = await request.formData();
		const groupId = String(form.get('groupId') ?? '');
		const parsed = parseForm(categoryCreateSchema, form);
		if (!parsed.success) return fail(400, { errors: parsed.errors });
		try {
			await createCategory(getDb().db, {
				groupId,
				name: parsed.data.name,
				colour: parsed.data.colour
			});
		} catch (err) {
			return failFor(err);
		}
		return { ok: true };
	},

	/** The category editor is one form with one Save (name, group, colour if
	 *  sent, hidden), in that order, stopping at the first refusal (a name clash). */
	editCategory: async ({ request, locals }) => {
		if (!locals.user) throw redirect(303, '/signin');
		const form = await request.formData();
		const id = String(form.get('id') ?? '');
		const parsed = parseForm(categoryRenameSchema, form);
		if (!parsed.success) return fail(400, { errors: parsed.errors });
		const newGroupId = String(form.get('newGroupId') ?? '');
		const raw = String(form.get('colour') ?? '').trim();
		if (raw !== '' && !/^#[0-9a-fA-F]{6}$/u.test(raw)) {
			return fail(400, { message: 'Use a hex colour like #46A758' });
		}
		const db = getDb().db;
		try {
			await renameCategory(db, id, parsed.data.name);
			if (newGroupId !== '') await moveCategory(db, id, newGroupId);
		} catch (err) {
			return failFor(err);
		}
		// The editor has no colour field: a form without one keeps the stored colour.
		if (form.has('colour')) await setColour(db, id, raw === '' ? null : raw);
		if (form.get('hidden') === 'on') await hideCategory(db, id);
		else await unhideCategory(db, id);
		// F2 RD10: a form without the switch (an older page) keeps what is stored.
		if (form.has('countsAsReturnShown')) await setCountsAsReturn(db, id, form.get('countsAsReturn') === 'on');
		return { ok: true };
	},

	renameCategory: async ({ request, locals }) => {
		if (!locals.user) throw redirect(303, '/signin');
		const form = await request.formData();
		const id = String(form.get('id') ?? '');
		const parsed = parseForm(categoryRenameSchema, form);
		if (!parsed.success) return fail(400, { errors: parsed.errors });
		try {
			await renameCategory(getDb().db, id, parsed.data.name);
		} catch (err) {
			return failFor(err);
		}
		return { ok: true };
	},

	moveCategory: async ({ request, locals }) => {
		if (!locals.user) throw redirect(303, '/signin');
		const form = await request.formData();
		const id = String(form.get('id') ?? '');
		const newGroupId = String(form.get('newGroupId') ?? '');
		try {
			await moveCategory(getDb().db, id, newGroupId);
		} catch (err) {
			return failFor(err);
		}
		return { ok: true };
	},

	setColour: async ({ request, locals }) => {
		if (!locals.user) throw redirect(303, '/signin');
		const form = await request.formData();
		const id = String(form.get('id') ?? '');
		const raw = String(form.get('colour') ?? '').trim();
		// Same #RRGGBB rule as the create path (validation.ts optionalColour) —
		// no path may write a junk colour the other path would have rejected.
		if (raw !== '' && !/^#[0-9a-fA-F]{6}$/u.test(raw)) {
			return fail(400, { message: 'Use a hex colour like #46A758' });
		}
		await setColour(getDb().db, id, raw === '' ? null : raw);
		return { ok: true };
	},

	hideCategory: async ({ request, locals }) => {
		if (!locals.user) throw redirect(303, '/signin');
		const id = String((await request.formData()).get('id') ?? '');
		await hideCategory(getDb().db, id);
		return { ok: true };
	},

	unhideCategory: async ({ request, locals }) => {
		if (!locals.user) throw redirect(303, '/signin');
		const id = String((await request.formData()).get('id') ?? '');
		await unhideCategory(getDb().db, id);
		return { ok: true };
	},

	deleteCategory: async ({ request, locals }) => {
		if (!locals.user) throw redirect(303, '/signin');
		const form = await request.formData();
		const id = String(form.get('id') ?? '');
		// Field absent → undefined (let the service enforce "must choose"); '' →
		// null (Uncategorized); otherwise a target category id.
		const raw = form.get('reassignToId');
		const reassignToId = raw === null ? undefined : String(raw) === '' ? null : String(raw);
		try {
			await deleteCategory(getDb().db, id, reassignToId, { userId: locals.user.id });
		} catch (err) {
			return failFor(err);
		}
		return { ok: true };
	}
};
