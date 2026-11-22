/**
 * listed-notes.test.ts: an over-long note stored before the limits. Every page that
 * listed such a row crashed the hosted server, and its Delete was only on those pages, so it needed
 * direct database access to remove. Lists now carry a cut note; the row opens, edits and deletes in
 * the app, and a save that didn't touch the note never writes the cut one back over the full one.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AuthedUser } from '../src/lib/server/auth/session';

const DB_PATH = path.join(os.tmpdir(), `miserly-listed-notes-${randomUUID()}.db`);
process.env.MISERLY_DB_PATH = DB_PATH;

import { getDb } from '../src/lib/server/db/instance';
import * as schema from '../src/lib/server/db/schema';
import { createAdmin } from '../src/lib/server/auth/users';
import { registerView, inboxTransactions } from '../src/lib/server/transactions';
import { recentActivity } from '../src/lib/server/dashboard';
import { postValuationMark } from '../src/lib/server/marks';
import { LISTED_NOTE_CHARS } from '../src/lib/server/listed-notes';
import { actions } from '../src/routes/accounts/[id]/+page.server';
import { eq } from 'drizzle-orm';

const HUGE = 'junk note '.repeat(50_000); // 500 KB, stored before the limits
let alice: AuthedUser;
let bankId: string;
let mfId: string;
let rowId: string;

function ev(id: string, fields: Record<string, string>) {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.set(k, v);
  return { locals: { user: alice }, params: { id }, request: new Request('http://localhost/', { method: 'POST', body }) } as never;
}
const run = (fn: unknown, arg: never) =>
  (fn as (a: never) => Promise<unknown>)(arg) as Promise<{ status?: number; data?: { errors?: Record<string, string> } } & Record<string, unknown>>;
const stored = (id: string) => getDb().db.select().from(schema.transactions).where(eq(schema.transactions.id, id)).get()!;

beforeAll(async () => {
  const { db } = getDb();
  alice = await createAdmin(db, { username: 'alice', displayName: 'Alice', password: 'alice-password-123' });
  bankId = randomUUID();
  mfId = randomUUID();
  rowId = randomUUID();
  db.insert(schema.accounts)
    .values([
      { id: bankId, ownerId: alice.id, name: 'HDFC', type: 'bank', currency: 'INR', openingPaise: 1000_00, openingDate: '2024-01-01' },
      { id: mfId, ownerId: alice.id, name: 'Index fund', type: 'mutualFunds', currency: 'INR', openingPaise: 0 },
    ])
    .run();
  db.insert(schema.transactions)
    .values({ id: rowId, accountId: bankId, date: '2024-02-01', sequence: 1, amountPaise: -500_00, notes: HUGE, enteredBy: alice.id, kind: 'ordinary' })
    .run();
});

afterAll(() => {
  getDb().sqlite.close();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(DB_PATH + suffix, { force: true });
});

const row = async () => (await registerView(getDb(), alice.id, bankId)).rows.find((r) => r.id === rowId)!;

describe('an over-long note stored before the limits', () => {
  it('lists carry it cut: the register, All transactions and Inbox', async () => {
    expect((await row()).notes).toHaveLength(LISTED_NOTE_CHARS);
    const activity = await recentActivity(getDb(), alice.id, 30);
    expect(activity.find((r) => r.id === rowId)?.notes).toHaveLength(LISTED_NOTE_CHARS);
    const inbox = await inboxTransactions(getDb(), alice.id);
    expect(inbox.find((r) => r.id === rowId)?.notes).toHaveLength(LISTED_NOTE_CHARS);
  });

  it('its amount edits in place, as the grid posts it, and the full note stays', async () => {
    const r = await row();
    const res = await run(actions.editTx, ev(bankId, {
      txId: r.id, expectedUpdatedAt: r.updatedAt, date: r.date, payee: '', category: '', outflow: '650', inflow: '', notes: r.notes ?? '', field: 'outflow',
    }));
    expect(res).toMatchObject({ edited: true });
    expect(stored(rowId).amountPaise).toBe(-650_00);
    expect(stored(rowId).notes).toBe(HUGE);
  });

  it('its note edits in place to a shorter one; a longer one is refused', async () => {
    const r = await row();
    const base = { txId: r.id, expectedUpdatedAt: r.updatedAt, date: r.date, payee: '', category: '', outflow: '650', inflow: '', field: 'notes' };
    const tooLong = await run(actions.editTx, ev(bankId, { ...base, notes: (r.notes ?? '').slice(0, 1500) }));
    expect(tooLong.status).toBe(400);
    expect(stored(rowId).notes).toBe(HUGE);
    const res = await run(actions.editTx, ev(bankId, { ...base, notes: 'Groceries' }));
    expect(res).toMatchObject({ edited: true });
    expect(stored(rowId).notes).toBe('Groceries');
  });

  it('it deletes from the app', async () => {
    const id = randomUUID();
    getDb().db.insert(schema.transactions)
      .values({ id, accountId: bankId, date: '2024-02-02', sequence: 1, amountPaise: -1_00, notes: HUGE, enteredBy: alice.id, kind: 'ordinary' })
      .run();
    const res = await run(actions.deleteTx, ev(bankId, { txId: id, expectedUpdatedAt: stored(id).updatedAt }));
    expect(res).toMatchObject({ deleted: true });
    expect(stored(id).deletedAt).not.toBeNull();
  });

  it("a value update's over-long memo stays when its value is edited", async () => {
    await postValuationMark(getDb(), { userId: alice.id }, { accountId: mfId, targetPaise: 1_000_00, date: '2024-03-01' });
    const mark = getDb().db.select().from(schema.transactions).where(eq(schema.transactions.accountId, mfId)).get()!;
    getDb().db.update(schema.transactions).set({ notes: HUGE }).where(eq(schema.transactions.id, mark.id)).run();
    const listed = (await registerView(getDb(), alice.id, mfId)).rows.find((r) => r.id === mark.id)!;
    expect(listed.notes).toHaveLength(LISTED_NOTE_CHARS);
    const res = await run(actions.editMark, ev(mfId, {
      markId: mark.id, expectedUpdatedAt: listed.updatedAt, target: '1200', date: listed.date, notes: listed.notes ?? '',
    }));
    expect(res).toMatchObject({ markEdited: true });
    expect(stored(mark.id).markTargetPaise).toBe(1_200_00);
    expect(stored(mark.id).notes).toBe(HUGE);
  });

  it('a note within the limit is listed whole', async () => {
    const id = randomUUID();
    const note = 'ā'.repeat(1000);
    getDb().db.insert(schema.transactions)
      .values({ id, accountId: bankId, date: '2024-02-03', sequence: 1, amountPaise: -1_00, notes: note, enteredBy: alice.id, kind: 'ordinary' })
      .run();
    expect((await registerView(getDb(), alice.id, bankId)).rows.find((r) => r.id === id)?.notes).toBe(note);
  });
});
