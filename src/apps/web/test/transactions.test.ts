/**
 * transactions.test.ts — C1/C2 capture core (createTransaction + registerView).
 * ============================================================================
 * Proves the money-write invariants of the shared create path:
 *   - DERIVED balance: after a create, balance == opening + Σamounts (never a
 *     stored value); direction is the sign of amountPaise (inflow +, outflow −).
 *   - ORDERING: `sequence` is per-(account, date) MAX+1 (first row on a date = 0,
 *     NOT a global counter — the mutation-2 guard) and tombstone-inclusive so a
 *     future C4 restore can't collide.
 *   - PRIVACY (P0): a non-visible account is rejected with the SAME
 *     AccountNotFoundError as a bogus id (the mutation-6 guard).
 *   - F3 projections: recency + remembered-category commit WITH the row; a
 *     category-less save never erases an existing remembered category.
 *   - registerView: running balances match the crown-jewel window fn; the
 *     as-of-today / projected split honours future-dated rows; display joins
 *     (payee, category, transfer counterpart) resolve.
 * ============================================================================
 */
import { afterEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createDb } from '../src/lib/server/db/client';
import { allStatements } from '../src/lib/server/db/migrate';
import type { Db } from '../src/lib/server/db/client';
import * as schema from '../src/lib/server/db/schema';
import { accountBalance, runningBalances } from '../src/lib/server/db/balances';
import { createAccount, closeAccount } from '../src/lib/server/accounts';
import {
  createTransaction,
  registerView,
  nextSequenceOn,
  AccountNotFoundError,
  ClosedAccountError,
  InvalidCategoryError,
} from '../src/lib/server/transactions';

let handle: Db | undefined;
afterEach(() => {
  handle?.sqlite.close();
  handle = undefined;
});

/** Fresh in-memory db: two users + a spending group with one live + one hidden category. */
function seed(): Db {
  const h = createDb(':memory:');
  handle = h;
  for (const stmt of allStatements()) h.sqlite.exec(stmt);
  h.db
    .insert(schema.users)
    .values([
      { id: 'owner1', username: 'o1', displayName: 'Owner 1', role: 'admin' },
      { id: 'owner2', username: 'o2', displayName: 'Owner 2', role: 'member' },
    ])
    .run();
  h.db.insert(schema.categoryGroups).values({ id: 'g1', name: 'Living', kind: 'spending' }).run();
  h.db
    .insert(schema.categories)
    .values([
      { id: 'c1', groupId: 'g1', name: 'Groceries' },
      { id: 'c-hidden', groupId: 'g1', name: 'Old', hidden: true },
    ])
    .run();
  return h;
}

async function bankAccount(h: Db, owner = 'owner1', opening = 0): Promise<string> {
  const a = await createAccount(h, {
    ownerId: owner,
    type: 'bank',
    name: `Acct-${Math.random().toString(36).slice(2, 8)}`,
    currency: 'INR',
    openingPaise: opening,
    openingDate: opening === 0 ? null : '2024-01-01',
  });
  return a.id;
}

describe('createTransaction: derived balance + direction', () => {
  it('an inflow raises the derived balance by its amount', async () => {
    const h = seed();
    const acct = await bankAccount(h, 'owner1', 1000_00);
    await createTransaction(h, { userId: 'owner1' }, {
      accountId: acct,
      date: '2024-02-01',
      amountPaise: 250_00,
    });
    expect(accountBalance(h.sqlite, acct)).toBe(1250_00);
  });

  it('an outflow (negative amount) lowers the derived balance', async () => {
    const h = seed();
    const acct = await bankAccount(h, 'owner1', 1000_00);
    await createTransaction(h, { userId: 'owner1' }, {
      accountId: acct,
      date: '2024-02-01',
      amountPaise: -300_00,
    });
    expect(accountBalance(h.sqlite, acct)).toBe(700_00);
  });

  it('rejects a zero amount (direction is by sign, never zero)', async () => {
    const h = seed();
    const acct = await bankAccount(h);
    await expect(
      createTransaction(h, { userId: 'owner1' }, { accountId: acct, date: '2024-02-01', amountPaise: 0 }),
    ).rejects.toThrow();
  });

  it('stamps entered_by = the actor', async () => {
    const h = seed();
    const acct = await bankAccount(h);
    const tx = await createTransaction(h, { userId: 'owner1' }, {
      accountId: acct,
      date: '2024-02-01',
      amountPaise: 100_00,
    });
    expect(tx.enteredBy).toBe('owner1');
    const row = h.db
      .select({ enteredBy: schema.transactions.enteredBy })
      .from(schema.transactions)
      .where(eq(schema.transactions.id, tx.id))
      .get();
    expect(row?.enteredBy).toBe('owner1');
  });
});

describe('createTransaction: per-(account,date) sequence', () => {
  it('same-date rows get 0,1,2… and the first row of a NEW date restarts at 0', async () => {
    const h = seed();
    const acct = await bankAccount(h);
    const a = await createTransaction(h, { userId: 'owner1' }, { accountId: acct, date: '2024-02-01', amountPaise: 10_00 });
    const b = await createTransaction(h, { userId: 'owner1' }, { accountId: acct, date: '2024-02-01', amountPaise: 20_00 });
    const c = await createTransaction(h, { userId: 'owner1' }, { accountId: acct, date: '2024-02-05', amountPaise: 30_00 });
    expect([a.sequence, b.sequence]).toEqual([0, 1]);
    // If sequence were a GLOBAL counter this would be 2 — the mutation-2 guard.
    expect(c.sequence).toBe(0);
  });

  it('nextSequenceOn counts tombstoned rows so a restored row cannot collide', async () => {
    const h = seed();
    const acct = await bankAccount(h);
    const a = await createTransaction(h, { userId: 'owner1' }, { accountId: acct, date: '2024-02-01', amountPaise: 10_00 });
    // Soft-delete it, then ask for the next sequence on that date.
    h.db
      .update(schema.transactions)
      .set({ deletedAt: '2024-02-02 00:00:00' })
      .where(eq(schema.transactions.id, a.id))
      .run();
    expect(nextSequenceOn(h.db, acct, '2024-02-01')).toBe(1); // NOT 0 — slot stays reserved
  });
});

describe('createTransaction: privacy + status + category validation', () => {
  it('a non-visible account is rejected identically to a bogus id (P0)', async () => {
    const h = seed();
    const othersAcct = await bankAccount(h, 'owner2');
    // owner1 cannot see owner2's private account...
    await expect(
      createTransaction(h, { userId: 'owner1' }, { accountId: othersAcct, date: '2024-02-01', amountPaise: 100_00 }),
    ).rejects.toBeInstanceOf(AccountNotFoundError);
    // ...and a bogus id fails the SAME way (no existence leak).
    await expect(
      createTransaction(h, { userId: 'owner1' }, { accountId: 'no-such-id', date: '2024-02-01', amountPaise: 100_00 }),
    ).rejects.toBeInstanceOf(AccountNotFoundError);
  });

  it('a closed account rejects new entries', async () => {
    const h = seed();
    const acct = await bankAccount(h, 'owner1', 500_00);
    await closeAccount(h, acct);
    await expect(
      createTransaction(h, { userId: 'owner1' }, { accountId: acct, date: '2024-02-01', amountPaise: 100_00 }),
    ).rejects.toBeInstanceOf(ClosedAccountError);
  });

  it('a missing or hidden category is rejected', async () => {
    const h = seed();
    const acct = await bankAccount(h);
    await expect(
      createTransaction(h, { userId: 'owner1' }, { accountId: acct, date: '2024-02-01', amountPaise: 100_00, categoryId: 'nope' }),
    ).rejects.toBeInstanceOf(InvalidCategoryError);
    await expect(
      createTransaction(h, { userId: 'owner1' }, { accountId: acct, date: '2024-02-01', amountPaise: 100_00, categoryId: 'c-hidden' }),
    ).rejects.toBeInstanceOf(InvalidCategoryError);
  });
});

describe('createTransaction: payee resolution + projections (F3)', () => {
  it('creates a payee on first use and reuses it on a normalized match', async () => {
    const h = seed();
    const acct = await bankAccount(h);
    const first = await createTransaction(h, { userId: 'owner1' }, { accountId: acct, date: '2024-02-01', amountPaise: 10_00, payeeName: 'Amazon' });
    const second = await createTransaction(h, { userId: 'owner1' }, { accountId: acct, date: '2024-02-02', amountPaise: 20_00, payeeName: '  amazon ' });
    expect(first.payeeId).not.toBeNull();
    expect(second.payeeId).toBe(first.payeeId); // one canonical row
  });

  it('records recency + remembers the category ONLY on a category-carrying save', async () => {
    const h = seed();
    const acct = await bankAccount(h);
    // Save WITH a category → remembered.
    const t1 = await createTransaction(h, { userId: 'owner1' }, { accountId: acct, date: '2024-02-01', amountPaise: 10_00, payeeName: 'Store', categoryId: 'c1' });
    const up1 = h.db
      .select()
      .from(schema.userPayee)
      .where(and(eq(schema.userPayee.userId, 'owner1'), eq(schema.userPayee.payeeId, t1.payeeId!)))
      .get();
    expect(up1?.lastCategoryId).toBe('c1');
    expect(up1?.lastUsedAt).not.toBeNull();
    const ap1 = h.db
      .select()
      .from(schema.accountPayee)
      .where(and(eq(schema.accountPayee.accountId, acct), eq(schema.accountPayee.payeeId, t1.payeeId!)))
      .get();
    expect(ap1?.lastUsedAt).not.toBeNull();

    // A later category-LESS save with the same payee must NOT erase the memory.
    await createTransaction(h, { userId: 'owner1' }, { accountId: acct, date: '2024-02-03', amountPaise: 5_00, payeeName: 'Store' });
    const up2 = h.db
      .select()
      .from(schema.userPayee)
      .where(and(eq(schema.userPayee.userId, 'owner1'), eq(schema.userPayee.payeeId, t1.payeeId!)))
      .get();
    expect(up2?.lastCategoryId).toBe('c1'); // fill-when-blank memory preserved
  });
});

describe('registerView', () => {
  it('rejects a non-visible account identically to a bogus id (P0)', async () => {
    const h = seed();
    const othersAcct = await bankAccount(h, 'owner2');
    await expect(registerView(h, 'owner1', othersAcct)).rejects.toBeInstanceOf(AccountNotFoundError);
    await expect(registerView(h, 'owner1', 'no-such-id')).rejects.toBeInstanceOf(AccountNotFoundError);
  });

  it('rows carry running balances that match the window fn, in ledger order', async () => {
    const h = seed();
    const acct = await bankAccount(h, 'owner1', 1000_00);
    await createTransaction(h, { userId: 'owner1' }, { accountId: acct, date: '2024-02-01', amountPaise: 200_00 });
    await createTransaction(h, { userId: 'owner1' }, { accountId: acct, date: '2024-02-03', amountPaise: -50_00 });
    // A back-dated row must sort first and lift later balances.
    await createTransaction(h, { userId: 'owner1' }, { accountId: acct, date: '2024-01-15', amountPaise: 500_00 });

    const view = await registerView(h, 'owner1', acct);
    const windowRows = runningBalances(h.sqlite, acct);
    expect(view.rows.map((r) => r.id)).toEqual(windowRows.map((r) => r.id));
    expect(view.rows.map((r) => r.balancePaise)).toEqual(windowRows.map((r) => r.balancePaise));
    // 1000 + 500(back) = 1500, + 200 = 1700, − 50 = 1650.
    expect(view.rows.map((r) => r.balancePaise)).toEqual([1500_00, 1700_00, 1650_00]);
  });

  it('splits as-of-today from projected on a future-dated row', async () => {
    const h = seed();
    const acct = await bankAccount(h, 'owner1', 100_00);
    await createTransaction(h, { userId: 'owner1' }, { accountId: acct, date: '2020-01-01', amountPaise: 50_00 });
    await createTransaction(h, { userId: 'owner1' }, { accountId: acct, date: '2999-01-01', amountPaise: 999_00 });
    const view = await registerView(h, 'owner1', acct);
    expect(view.asOfTodayPaise).toBe(150_00); // opening + the 2020 row only
    expect(view.projectedPaise).toBe(150_00 + 999_00); // includes the far-future row
  });

  it('resolves payee + category display names, and a transfer counterpart account', async () => {
    const h = seed();
    const acct = await bankAccount(h, 'owner1', 0);
    const other = await bankAccount(h, 'owner1', 0);
    const t = await createTransaction(h, { userId: 'owner1' }, { accountId: acct, date: '2024-02-01', amountPaise: -40_00, payeeName: 'Cafe', categoryId: 'c1' });
    // Manually link a partner row in `other` to exercise the counterpart JOIN
    // (the real pair machinery is C3/m6b; here we only prove the read model).
    const partner = await createTransaction(h, { userId: 'owner1' }, { accountId: other, date: '2024-02-01', amountPaise: 40_00 });
    h.db.update(schema.transactions).set({ transferPartnerId: partner.id }).where(eq(schema.transactions.id, t.id)).run();

    const view = await registerView(h, 'owner1', acct);
    const row = view.rows.find((r) => r.id === t.id)!;
    expect(row.payeeName).toBe('Cafe');
    expect(row.categoryName).toBe('Groceries');
    expect(row.counterpartAccountName).toBe(
      (await registerView(h, 'owner1', other)).account.name,
    );
  });
});
