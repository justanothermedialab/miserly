/**
 * marks.test.ts — S3 valuation marks, S2 holding onboarding, and the S3-RD1
 * reconcile (the highest-risk M8 correctness surface).
 * ============================================================================
 * Proves: gap math (value-after == target); zero-gap skip; non-markable reject;
 * markable liability marks to a negative outstanding; holding onboarding gives a
 * correct day-one return; the RD1 RECONCILE — a mark holds its target when an
 * EARLIER contribution is back-date-edited, when an earlier row is deleted, and
 * across repeated/back-dated marks; and NO DRIFT (holdingMetrics.currentValue ==
 * accountBalance). Adversarial: disabling reconcile must break the RD1 tests.
 * ============================================================================
 */
import { afterEach, describe, expect, it } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { createDb } from '../src/lib/server/db/client';
import { allStatements } from '../src/lib/server/db/migrate';
import type { Db } from '../src/lib/server/db/client';
import * as schema from '../src/lib/server/db/schema';
import { accountBalance } from '../src/lib/server/db/balances';
import { createAccount, createHoldingAccount } from '../src/lib/server/accounts';
import { createTransfer } from '../src/lib/server/transfers';
import { updateTransaction, deleteTransaction } from '../src/lib/server/transactions';
import {
  postValuationMark,
  editMarkTarget,
  NotMarkableError,
} from '../src/lib/server/marks';
import { holdingMetrics } from '../src/lib/server/dashboard';

let handle: Db | undefined;
afterEach(() => {
  handle?.sqlite.close();
  handle = undefined;
});

function seed(): Db {
  const h = createDb(':memory:');
  handle = h;
  for (const stmt of allStatements()) h.sqlite.exec(stmt);
  h.db.insert(schema.users).values({ id: 'owner1', username: 'o1', displayName: 'Owner 1', role: 'admin' }).run();
  return h;
}

const U = { userId: 'owner1' };

async function bank(h: Db, opening = 100_00_000): Promise<string> {
  const a = await createAccount(h, {
    ownerId: 'owner1', type: 'bank', name: `Bank-${Math.random().toString(36).slice(2, 7)}`,
    currency: 'INR', openingPaise: opening, openingDate: '2023-01-01',
  });
  return a.id;
}

/** A live valuation-mark row on an account (there should be at most a few). */
function markRows(h: Db, accountId: string) {
  return h.db
    .select()
    .from(schema.transactions)
    .where(
      and(
        eq(schema.transactions.accountId, accountId),
        eq(schema.transactions.kind, 'valuationMark'),
        isNull(schema.transactions.deletedAt),
      ),
    )
    .all();
}

describe('postValuationMark — gap math', () => {
  it('posts the gap so value-after equals the target; stores the target', async () => {
    const h = seed();
    const mf = await createHoldingAccount(h, {
      ownerId: 'owner1', type: 'mutualFunds', name: 'Parag', currency: 'INR',
      investedPaise: 10_000_00, investedDate: '2024-01-01', currentValuePaise: null,
    });
    const res = await postValuationMark(h, U, { accountId: mf.id, targetPaise: 11_500_00, date: '2024-06-01' });
    expect(res.gapPaise).toBe(1_500_00); // 11,500 − 10,000
    expect(accountBalance(h.sqlite, mf.id)).toBe(11_500_00);
    const rows = markRows(h, mf.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.markTargetPaise).toBe(11_500_00);
    expect(rows[0]!.amountPaise).toBe(1_500_00);
  });

  it('a zero-gap mark records a ₹0 row (N-04, S3 RD8; it created none, S3 RD3)', async () => {
    const h = seed();
    const mf = await createHoldingAccount(h, {
      ownerId: 'owner1', type: 'mutualFunds', name: 'X', currency: 'INR',
      investedPaise: 5_000_00, investedDate: '2024-01-01', currentValuePaise: null,
    });
    const res = await postValuationMark(h, U, { accountId: mf.id, targetPaise: 5_000_00, date: '2024-02-01' });
    expect(res.id).not.toBeNull();
    expect(res.gapPaise).toBe(0);
    expect(markRows(h, mf.id)).toHaveLength(1);
    expect(markRows(h, mf.id)[0]!.amountPaise).toBe(0);
  });

  it('rejects a mark on a non-markable (spending) account', async () => {
    const h = seed();
    const b = await bank(h);
    await expect(postValuationMark(h, U, { accountId: b, targetPaise: 999, date: '2024-02-01' }))
      .rejects.toBeInstanceOf(NotMarkableError);
  });

  it('a down-mark falls honestly; a back-dated mark is correct at its date', async () => {
    const h = seed();
    const mf = await createHoldingAccount(h, {
      ownerId: 'owner1', type: 'mutualFunds', name: 'Y', currency: 'INR',
      investedPaise: 10_000_00, investedDate: '2024-01-01', currentValuePaise: null,
    });
    await postValuationMark(h, U, { accountId: mf.id, targetPaise: 8_000_00, date: '2024-03-01' });
    expect(accountBalance(h.sqlite, mf.id, '2024-03-01')).toBe(8_000_00);
    const m = await holdingMetrics(h, 'owner1', mf.id);
    expect(m!.currentValuePaise).toBe(8_000_00);
    expect(m!.returnPaise).toBe(-2_000_00); // lost 2,000 vs invested
  });
});

describe('holding onboarding (S2 RD1)', () => {
  it('invested + current value give a correct day-one return', async () => {
    const h = seed();
    const mf = await createHoldingAccount(h, {
      ownerId: 'owner1', type: 'mutualFunds', name: 'Onboard', currency: 'INR',
      investedPaise: 3_00_000_00, investedDate: '2022-01-01', currentValuePaise: 5_00_000_00,
    });
    const m = await holdingMetrics(h, 'owner1', mf.id);
    expect(m!.currentValuePaise).toBe(5_00_000_00);
    expect(m!.costBasisPaise).toBe(3_00_000_00);
    expect(m!.returnPaise).toBe(2_00_000_00);
    expect(m!.returnPct).toBeCloseTo(2 / 3, 6);
    // Value equals the derived balance — no drift (S2 failure case).
    expect(m!.currentValuePaise).toBe(accountBalance(h.sqlite, mf.id));
  });

  it('a liability holding (loan) marks to its outstanding (negative side)', async () => {
    const h = seed();
    const loan = await createAccount(h, {
      ownerId: 'owner1', type: 'loan', name: 'Home loan', currency: 'INR',
      openingPaise: -50_00_000_00, openingDate: '2020-01-01',
    });
    // Outstanding actually 60,00,000 owed (accrued interest) → signed target −60,00,000.
    await postValuationMark(h, U, { accountId: loan.id, targetPaise: -60_00_000_00, date: '2024-06-01' });
    const m = await holdingMetrics(h, 'owner1', loan.id);
    expect(m!.side).toBe('Liability');
    expect(m!.currentValuePaise).toBe(-60_00_000_00);
    expect(accountBalance(h.sqlite, loan.id)).toBe(-60_00_000_00);
  });
});

describe('S3 RD1 reconcile — a mark holds its target when prior rows change', () => {
  it('back-date-editing an earlier contribution re-derives the mark gap', async () => {
    const h = seed();
    const b = await bank(h);
    const mf = await createHoldingAccount(h, {
      ownerId: 'owner1', type: 'mutualFunds', name: 'SIP', currency: 'INR',
      investedPaise: 0, investedDate: null, currentValuePaise: null,
    });
    // Contribute 10,000 (transfer bank → MF) on Jan 1.
    const t = await createTransfer(h, U, { fromId: b, toId: mf.id, amountPaise: 10_000_00, date: '2024-01-01' });
    // Mark to 12,000 on Jun 1 → gap +2,000, value-after 12,000.
    await postValuationMark(h, U, { accountId: mf.id, targetPaise: 12_000_00, date: '2024-06-01' });
    expect(accountBalance(h.sqlite, mf.id)).toBe(12_000_00);

    // Now correct the contribution up to 15,000 (edit the MF-side leg).
    const mfLeg = await h.db.select().from(schema.transactions).where(eq(schema.transactions.id, t.toTxId)).get();
    await updateTransaction(h, U, t.toTxId, { amountPaise: 15_000_00 }, mfLeg!.updatedAt);

    // The mark HOLDS its 12,000 target: value still 12,000, basis now 15,000.
    expect(accountBalance(h.sqlite, mf.id)).toBe(12_000_00);
    const m = await holdingMetrics(h, 'owner1', mf.id);
    expect(m!.currentValuePaise).toBe(12_000_00);
    expect(m!.costBasisPaise).toBe(15_000_00);
    expect(m!.returnPaise).toBe(-3_000_00);
    // The mark's amount re-derived to −3,000 (12,000 − 15,000).
    expect(markRows(h, mf.id)[0]!.amountPaise).toBe(-3_000_00);
  });

  it('deleting an earlier contribution re-derives the mark', async () => {
    const h = seed();
    const b = await bank(h);
    const mf = await createHoldingAccount(h, {
      ownerId: 'owner1', type: 'mutualFunds', name: 'Z', currency: 'INR',
      investedPaise: 0, investedDate: null, currentValuePaise: null,
    });
    await createTransfer(h, U, { fromId: b, toId: mf.id, amountPaise: 6_000_00, date: '2024-01-01' });
    const t2 = await createTransfer(h, U, { fromId: b, toId: mf.id, amountPaise: 4_000_00, date: '2024-02-01' });
    await postValuationMark(h, U, { accountId: mf.id, targetPaise: 11_000_00, date: '2024-06-01' });
    expect(accountBalance(h.sqlite, mf.id)).toBe(11_000_00);

    // Delete the 4,000 contribution — value must still be 11,000 (mark holds).
    const leg = await h.db.select().from(schema.transactions).where(eq(schema.transactions.id, t2.toTxId)).get();
    await deleteTransaction(h, U, t2.toTxId, leg!.updatedAt);
    expect(accountBalance(h.sqlite, mf.id)).toBe(11_000_00);
    const m = await holdingMetrics(h, 'owner1', mf.id);
    expect(m!.currentValuePaise).toBe(11_000_00);
    expect(m!.costBasisPaise).toBe(6_000_00); // only the surviving contribution
  });

  it('repeated marks each hold their own target (later mark stacks on the earlier)', async () => {
    const h = seed();
    const mf = await createHoldingAccount(h, {
      ownerId: 'owner1', type: 'mutualFunds', name: 'R', currency: 'INR',
      investedPaise: 10_000_00, investedDate: '2024-01-01', currentValuePaise: null,
    });
    await postValuationMark(h, U, { accountId: mf.id, targetPaise: 11_000_00, date: '2024-03-01' });
    await postValuationMark(h, U, { accountId: mf.id, targetPaise: 13_500_00, date: '2024-09-01' });
    expect(accountBalance(h.sqlite, mf.id, '2024-03-01')).toBe(11_000_00);
    expect(accountBalance(h.sqlite, mf.id)).toBe(13_500_00);
  });

  it('editMarkTarget re-derives the gap to the new target', async () => {
    const h = seed();
    const mf = await createHoldingAccount(h, {
      ownerId: 'owner1', type: 'mutualFunds', name: 'E', currency: 'INR',
      investedPaise: 10_000_00, investedDate: '2024-01-01', currentValuePaise: null,
    });
    const res = await postValuationMark(h, U, { accountId: mf.id, targetPaise: 11_000_00, date: '2024-06-01' });
    const row = await h.db.select().from(schema.transactions).where(eq(schema.transactions.id, res.id!)).get();
    await editMarkTarget(h, U, res.id!, 12_000_00, row!.updatedAt);
    expect(accountBalance(h.sqlite, mf.id)).toBe(12_000_00);
    expect(markRows(h, mf.id)[0]!.markTargetPaise).toBe(12_000_00);
  });
});
