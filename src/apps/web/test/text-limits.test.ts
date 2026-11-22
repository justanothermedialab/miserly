/**
 * text-limits.test.ts: the maxima for typed text, at the helper, the
 * form schemas and the route actions that read fields by hand. The junk that broke it: an 8 MB note
 * that took the server down, a 100 KB category name every member paid for on every page, a
 * NUL and a right-to-left override in a name, a password that could be set and never used.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AuthedUser } from '../src/lib/server/auth/session';

const DB_PATH = path.join(os.tmpdir(), `miserly-limits-${randomUUID()}.db`);
process.env.MISERLY_DB_PATH = DB_PATH;

import { TEXT_LIMITS, fitsLength, hasHiddenCharacters, textProblem, visibleLength } from '../src/lib/text-limits';
import {
  parseForm,
  transactionCreateSchema,
  categoryCreateSchema,
  groupCreateSchema,
  payeeNameSchema,
} from '../src/lib/server/validation';
import { passwordProblem } from '../src/lib/server/auth/password-rule';
import { readInfoForm, moduleProfile } from '../src/lib/modules';
import { getDb } from '../src/lib/server/db/instance';
import * as schema from '../src/lib/server/db/schema';
import { createAdmin } from '../src/lib/server/auth/users';
import { actions as registerActions } from '../src/routes/accounts/[id]/+page.server';
import { actions as captureActions } from '../src/routes/capture/+page.server';
import { eq } from 'drizzle-orm';

function fd(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

describe('the helper', () => {
  it('counts characters a person sees, not UTF-16 units', () => {
    expect(visibleLength('café')).toBe(4);
    expect(visibleLength('é')).toBe(1); // e + combining acute
    expect(visibleLength('👨‍👩‍👧')).toBe(1); // a family emoji, five code points
    expect(fitsLength('👨‍👩‍👧'.repeat(100), 100)).toBe(true);
    expect(fitsLength('👨‍👩‍👧'.repeat(101), 100)).toBe(false);
    expect(fitsLength('a'.repeat(100), 100)).toBe(true);
    expect(fitsLength('a'.repeat(101), 100)).toBe(false);
  });

  it('refuses a short-looking string padded with thousands of combining marks', () => {
    expect(fitsLength('a' + '́'.repeat(5000), 100)).toBe(false);
  });

  it('refuses control characters and text-direction overrides', () => {
    expect(hasHiddenCharacters('HDFC\u0000')).toBe(true);
    expect(hasHiddenCharacters('gpj.‮exe')).toBe(true);
    expect(hasHiddenCharacters('a⁦b')).toBe(true);
    expect(hasHiddenCharacters('line one\nline two')).toBe(true);
    expect(hasHiddenCharacters('line one\nline two', true)).toBe(false);
    expect(hasHiddenCharacters('नमस्ते Priya’s ₹ fund')).toBe(false);
    expect(textProblem('a‮b', 'name')).toMatch(/hidden characters/u);
  });

  it('says the limit in the message', () => {
    expect(textProblem('x'.repeat(1001), 'note')).toBe('Use 1,000 characters or fewer');
    expect(textProblem('x'.repeat(1000), 'note')).toBeNull();
  });
});

describe('the form schemas', () => {
  it('refuses a note over 1,000 and a payee over 200, never cuts them', () => {
    const note = parseForm(transactionCreateSchema, fd({ date: '2024-02-01', outflow: '5', notes: 'n'.repeat(1001) }));
    expect(note.success).toBe(false);
    if (!note.success) expect(note.errors.notes).toBe('Use 1,000 characters or fewer');
    const payee = parseForm(transactionCreateSchema, fd({ date: '2024-02-01', outflow: '5', payee: 'p'.repeat(201) }));
    expect(payee.success).toBe(false);
    if (!payee.success) expect(payee.errors.payee).toBe('Use 200 characters or fewer');
    const ok = parseForm(transactionCreateSchema, fd({ date: '2024-02-01', outflow: '5', payee: 'p'.repeat(200), notes: 'n'.repeat(1000) }));
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data.notes).toHaveLength(1000);
  });

  it('refuses names over 100 for categories and groups, payees over 200', () => {
    expect(parseForm(categoryCreateSchema, fd({ name: 'c'.repeat(101) })).success).toBe(false);
    expect(parseForm(categoryCreateSchema, fd({ name: 'c'.repeat(100) })).success).toBe(true);
    expect(parseForm(groupCreateSchema, fd({ name: 'g'.repeat(101), kind: 'spending' })).success).toBe(false);
    expect(parseForm(payeeNameSchema, fd({ displayName: 'p'.repeat(201) })).success).toBe(false);
    expect(parseForm(payeeNameSchema, fd({ displayName: 'p'.repeat(200) })).success).toBe(true);
    expect(parseForm(categoryCreateSchema, fd({ name: 'Fuel\u0000' })).success).toBe(false);
  });

  it('refuses an account detail over 4,000', () => {
    const profile = moduleProfile('fd')!;
    const key = profile.infoFields.find((f) => f.type === 'text' || f.type === 'number')!.key;
    expect('errors' in readInfoForm(profile, fd({ [`info_${key}`]: 'x'.repeat(4001) }))).toBe(true);
    expect('errors' in readInfoForm(profile, fd({ [`info_${key}`]: 'x'.repeat(4000) }))).toBe(false);
  });

  it('refuses a password over 1,024 code points, which could be set and never used', () => {
    expect(passwordProblem('x'.repeat(1025), 'alice')).toBe('Use 1,024 characters or fewer.');
    expect(passwordProblem('x'.repeat(1024) + 'q', 'alice')).not.toBeNull();
    expect(passwordProblem('xq'.repeat(512), 'alice')).toBeNull();
    expect(TEXT_LIMITS.password).toBe(1024);
  });
});

describe('the actions that read fields by hand', () => {
  let alice: AuthedUser;
  let bankId: string;
  let cashId: string;
  let fdId: string;

  function ev(id: string, fields: Record<string, string>) {
    const request = new Request('http://localhost/', { method: 'POST', body: fd(fields) });
    return { locals: { user: alice }, params: { id }, request } as never;
  }
  const run = (fn: unknown, arg: never) => (fn as (a: never) => Promise<unknown>)(arg) as Promise<{ status?: number; data?: { errors?: Record<string, string> } } & Record<string, unknown>>;

  beforeAll(async () => {
    const { db } = getDb();
    alice = await createAdmin(db, { username: 'alice', displayName: 'Alice', password: 'alice-password-123' });
    bankId = randomUUID();
    cashId = randomUUID();
    fdId = randomUUID();
    db.insert(schema.accounts)
      .values([
        { id: bankId, ownerId: alice.id, name: 'HDFC', type: 'bank', currency: 'INR', openingPaise: 1000_00, openingDate: '2024-01-01' },
        { id: cashId, ownerId: alice.id, name: 'Cash', type: 'bank', currency: 'INR', openingPaise: 0 },
        { id: fdId, ownerId: alice.id, name: 'FD', type: 'fd', currency: 'INR', openingPaise: 0 },
      ])
      .run();
  });

  afterAll(() => {
    getDb().sqlite.close();
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(DB_PATH + suffix, { force: true });
  });

  it('a register row with a 1,001-character note is refused, and nothing is saved', async () => {
    const res = await run(registerActions.addTransaction, ev(bankId, { date: '2024-02-01', outflow: '5', notes: 'n'.repeat(1001) }));
    expect(res.status).toBe(400);
    expect(res.data?.errors?.notes).toBe('Use 1,000 characters or fewer');
    expect(getDb().db.select().from(schema.transactions).where(eq(schema.transactions.accountId, bankId)).all()).toHaveLength(0);
  });

  it('Edit account refuses a 101-character name and keeps the old one', async () => {
    const res = await run(registerActions.editAccount, ev(bankId, { name: 'a'.repeat(101), opening: '1000', openingDate: '2024-01-01' }));
    expect(res.status).toBe(400);
    expect(res.data?.errors?.name).toBe('Use 100 characters or fewer');
    const after = getDb().db.select().from(schema.accounts).where(eq(schema.accounts.id, bankId)).get();
    expect(after?.name).toBe('HDFC');
  });

  it('Edit account refuses a right-to-left override in the name', async () => {
    const res = await run(registerActions.editAccount, ev(bankId, { name: 'HDFC‮latot', opening: '1000', openingDate: '2024-01-01' }));
    expect(res.status).toBe(400);
    expect(res.data?.errors?.name).toMatch(/hidden characters/u);
  });

  it('Edit account refuses a detail over 4,000 (a 100 KB interest rate was saved)', async () => {
    const key = moduleProfile('fd')!.infoFields.find((f) => f.type !== 'date' && f.type !== 'select')!.key;
    const res = await run(registerActions.editAccount, ev(fdId, { name: 'FD', opening: '0', [`info_${key}`]: '7'.repeat(100_000) }));
    expect(res.status).toBe(400);
    expect(res.data?.errors?.[`info_${key}`]).toBe('Use 4,000 characters or fewer');
  });

  it("a transfer's note over 1,000 is refused", async () => {
    const res = await run(captureActions.addTransfer, ev('', { from: bankId, to: cashId, date: '2024-02-02', amount: '10', notes: 'n'.repeat(1001) }));
    expect(res.status).toBe(400);
    expect(res.data?.errors?.notes).toBe('Use 1,000 characters or fewer');
  });
});
