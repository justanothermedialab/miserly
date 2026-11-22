/**
 * ux-pass4-actions.integration.test.ts — the route actions behind UX-REVIEW Pass 4, driven end
 * to end like m8-sections-action (the browser OOMs here): the category editor's one Save (P9)
 * and To categorize's Undo (P12).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AuthedUser } from '../src/lib/server/auth/session';

const DB_PATH = path.join(os.tmpdir(), `miserly-ux4-${randomUUID()}.db`);
process.env.MISERLY_DB_PATH = DB_PATH;

import { getDb } from '../src/lib/server/db/instance';
import { createAdmin } from '../src/lib/server/auth/users';
import { createCategory, createGroup, listCategoryTree } from '../src/lib/server/categories';
import { actions as categoryActions } from '../src/routes/categories/+page.server';

let alice: AuthedUser;
function ev(fields: Record<string, string>) {
	const body = new FormData();
	for (const [k, v] of Object.entries(fields)) body.set(k, v);
	return { locals: { user: alice }, params: {}, request: new Request('http://localhost/', { method: 'POST', body }) } as never;
}
const find = async (id: string) =>
	(await listCategoryTree(getDb().db, { includeHidden: true }))
		.flatMap((g) => g.categories.map((c) => ({ ...c, groupId: g.id })))
		.find((c) => c.id === id)!;

let groupA: string;
let groupB: string;
beforeAll(async () => {
	const { db } = getDb();
	const u = await createAdmin(db, { username: 'alice', displayName: 'Alice', password: 'alice-password-123' });
	alice = { id: u.id, username: 'alice', role: 'admin' };
	groupA = (await createGroup(db, { name: 'Daily', kind: 'spending' })).id;
	groupB = (await createGroup(db, { name: 'Travel', kind: 'spending' })).id;
});
afterAll(() => {
	getDb().sqlite.close();
	for (const suffix of ['', '-wal', '-shm']) fs.rmSync(DB_PATH + suffix, { force: true });
});

describe('editCategory (P9): one Save for name, group, colour and hidden', () => {
	it('applies every field at once', async () => {
		const { id } = await createCategory(getDb().db, { groupId: groupA, name: 'Fule' });
		const edit = categoryActions.editCategory as (arg: never) => Promise<unknown>;
		const r = (await edit(ev({ id, name: 'Fuel', newGroupId: groupB, colour: '#3E63DD', hidden: 'on' }))) as { ok?: boolean };
		expect(r.ok).toBe(true);
		const c = await find(id);
		expect([c.name, c.groupId, c.colour, c.hidden]).toEqual(['Fuel', groupB, '#3E63DD', true]);
	});

	it('a name clash changes nothing', async () => {
		const db = getDb().db;
		await createCategory(db, { groupId: groupA, name: 'Milk' });
		const { id } = await createCategory(db, { groupId: groupA, name: 'Bread' });
		const before = (await find(id)).colour;
		const edit = categoryActions.editCategory as (arg: never) => Promise<unknown>;
		const r = (await edit(ev({ id, name: 'milk', newGroupId: groupA, colour: '#3E63DD' }))) as { status?: number };
		expect(r.status).toBe(400);
		const c = await find(id);
		expect([c.name, c.colour]).toEqual(['Bread', before]);
	});

	it('the editor without a colour field keeps the stored colour', async () => {
		const { id } = await createCategory(getDb().db, { groupId: groupA, name: 'Tea' });
		const before = (await find(id)).colour;
		expect(before).not.toBeNull();
		const edit = categoryActions.editCategory as (arg: never) => Promise<unknown>;
		await edit(ev({ id, name: 'Chai', newGroupId: groupA }));
		const c = await find(id);
		expect([c.name, c.colour]).toEqual(['Chai', before]);
	});
});
