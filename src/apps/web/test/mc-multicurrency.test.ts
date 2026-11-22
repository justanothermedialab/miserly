/**
 * mc-multicurrency.test.ts — M9 (MC1 aggregation rate + MC2 cross-currency transfer).
 * ============================================================================
 * Proves the M9 invariants, several as adversarial RED-then-safe checks:
 *   - MC1: a foreign account with NO rate is EXCLUDED from the base total and
 *     flagged in `rateNeededCurrencies` — NEVER a silent 1:1 (the Firefly trap).
 *     Setting the rate folds it in; base totals reconcile through one `toBase`.
 *   - MC2: a cross-currency transfer is two NATIVE legs (source −out, dest +to)
 *     coupled by a FROZEN linkage rate stored on both, independent of the MC1
 *     standing rate. Enter rate OR to-amount; the other derives (GnuCash model).
 *   - MC2 × C4 (2026-10-16): correcting a leg's amount KEEPS the partner's amount
 *     and re-derives the rate (both amounts are the facts; a same-currency negation would
 *     corrupt the other account's native balance).
 * ============================================================================
 */
import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb } from '../src/lib/server/db/client';
import { allStatements } from '../src/lib/server/db/migrate';
import type { Db } from '../src/lib/server/db/client';
import * as schema from '../src/lib/server/db/schema';
import { accountBalance } from '../src/lib/server/db/balances';
import { createAccount } from '../src/lib/server/accounts';
import { updateTransaction, deleteTransaction, registerView } from '../src/lib/server/transactions';
import { createTransfer, CurrencyMismatchError, AmbiguousFxInputError } from '../src/lib/server/transfers';
import {
  parseRateToScaled,
  setRate,
  loadRateTable,
  listRates,
  activeForeignCurrencies,
} from '../src/lib/server/rates';
import { dashboardSummary } from '../src/lib/server/dashboard';
import { toBase, Money } from '@miserly/core';

let handle: Db | undefined;
afterEach(() => {
  handle?.sqlite.close();
  handle = undefined;
});

function seed(): Db {
  const h = createDb(':memory:');
  handle = h;
  for (const stmt of allStatements()) h.sqlite.exec(stmt);
  h.db
    .insert(schema.users)
    .values([{ id: 'owner1', username: 'o1', displayName: 'Owner 1', role: 'admin' }])
    .run();
  return h;
}

async function acct(
  h: Db,
  opts: { type?: string; opening?: number; currency?: string; name?: string } = {},
): Promise<string> {
  const a = await createAccount(h, {
    ownerId: 'owner1',
    type: opts.type ?? 'bank',
    name: opts.name ?? `A-${Math.random().toString(36).slice(2, 8)}`,
    currency: opts.currency ?? 'INR',
    openingPaise: opts.opening ?? 0,
    openingDate: (opts.opening ?? 0) === 0 ? null : '2024-01-01',
  });
  return a.id;
}

function txRow(h: Db, id: string) {
  return h.db.select().from(schema.transactions).where(eq(schema.transactions.id, id)).get()!;
}

// ── MC1: rate parsing & the store ────────────────────────────────────────────

describe('parseRateToScaled: exact decimal → scaled integer, no float drift', () => {
  it('parses whole and fractional rates at scale 6', () => {
    expect(parseRateToScaled('83')).toEqual({ scaled: 83_000_000, scale: 6 });
    expect(parseRateToScaled('83.5')).toEqual({ scaled: 83_500_000, scale: 6 });
    expect(parseRateToScaled('83.456789')).toEqual({ scaled: 83_456_789, scale: 6 });
  });

  it('rejects non-positive, malformed, or over-precise input', () => {
    expect(() => parseRateToScaled('0')).toThrow();
    expect(() => parseRateToScaled('-5')).toThrow();
    expect(() => parseRateToScaled('8x')).toThrow();
    expect(() => parseRateToScaled('83.1234567')).toThrow(); // 7 dp > scale 6
  });
});

describe('setRate + loadRateTable: one current rate per currency', () => {
  it('upserts a single row and converts through toBase', () => {
    const h = seed();
    setRate(h, 'USD', parseRateToScaled('83.5'));
    setRate(h, 'USD', parseRateToScaled('84')); // replace, not duplicate
    expect(listRates(h.db)).toHaveLength(1);

    const rates = loadRateTable(h.db);
    // $100.00 → ₹8,400.00 at the replaced rate.
    expect(toBase(Money.fromPaise(100_00, 'USD'), rates)!.paise).toBe(8400_00);
    expect(listRates(h.db)[0]!.rate).toBe(84);
  });

  it('rejects setting a rate on the base currency (INR is always 1)', () => {
    const h = seed();
    expect(() => setRate(h, 'INR', parseRateToScaled('1'))).toThrow();
  });

  it('activeForeignCurrencies lists the viewer\'s foreign currencies only', async () => {
    const h = seed();
    await acct(h, { currency: 'INR' });
    await acct(h, { currency: 'USD' });
    await acct(h, { currency: 'USD' }); // deduped
    expect(await activeForeignCurrencies(h.db, 'owner1')).toEqual(['USD']);
  });
});

// ── MC1: dashboard "rate needed" (never a silent 1:1) ────────────────────────

describe('dashboardSummary: a foreign account with no rate flags "rate needed"', () => {
  it('excludes the unrated USD account and never folds it at 1:1', async () => {
    const h = seed();
    await acct(h, { currency: 'INR', opening: 1000_00 });
    await acct(h, { currency: 'USD', opening: 100_00 });

    const before = await dashboardSummary(h, 'owner1');
    expect(before.rateNeededCurrencies).toEqual(['USD']);
    // The USD 100.00 is NOT counted as ₹100 — net worth is the INR account only.
    expect(before.netWorthPaise).toBe(1000_00);

    setRate(h, 'USD', parseRateToScaled('80'));
    const after = await dashboardSummary(h, 'owner1');
    expect(after.rateNeededCurrencies).toEqual([]);
    // ₹1000 + $100 × 80 = ₹1000 + ₹8000 = ₹9000.
    expect(after.netWorthPaise).toBe(1000_00 + 8000_00);
  });
});

// ── MC2: cross-currency transfer ─────────────────────────────────────────────

describe('createTransfer (MC2): two native legs + a frozen linkage rate', () => {
  it('rate input: $100 out, ₹8,200 in; both legs carry the rate', async () => {
    const h = seed();
    const usd = await acct(h, { currency: 'USD', opening: 500_00 });
    const inr = await acct(h, { currency: 'INR', opening: 0 });

    const t = await createTransfer(h, { userId: 'owner1' }, {
      fromId: usd,
      toId: inr,
      amountPaise: 100_00, // $100.00 out
      date: '2024-02-01',
      rate: parseRateToScaled('82'),
    });

    // Native legs: source −$100, dest +₹8,200 (each in its OWN currency).
    expect(accountBalance(h.sqlite, usd)).toBe(400_00); // 500 − 100
    expect(accountBalance(h.sqlite, inr)).toBe(8200_00);

    const from = txRow(h, t.fromTxId);
    const to = txRow(h, t.toTxId);
    expect(from.amountPaise).toBe(-100_00);
    expect(to.amountPaise).toBe(8200_00);
    // Frozen linkage rate stored on BOTH legs (destination-per-1-source).
    expect(from.fxRateScaled).toBe(82_000_000);
    expect(from.fxScale).toBe(6);
    expect(to.fxRateScaled).toBe(82_000_000);
  });

  it('to-amount input: derives the linkage rate', async () => {
    const h = seed();
    const usd = await acct(h, { currency: 'USD', opening: 500_00 });
    const inr = await acct(h, { currency: 'INR', opening: 0 });

    const t = await createTransfer(h, { userId: 'owner1' }, {
      fromId: usd,
      toId: inr,
      amountPaise: 100_00,
      date: '2024-02-01',
      toAmountPaise: 8250_00, // ₹8,250 received
    });
    expect(accountBalance(h.sqlite, inr)).toBe(8250_00);
    // rate = 8250 / 100 = 82.5 → scaled 82_500_000.
    expect(txRow(h, t.fromTxId).fxRateScaled).toBe(82_500_000);
  });

  it('rejects ambiguous (both rate AND to-amount) input', async () => {
    const h = seed();
    const usd = await acct(h, { currency: 'USD', opening: 500_00 });
    const inr = await acct(h, { currency: 'INR', opening: 0 });
    await expect(
      createTransfer(h, { userId: 'owner1' }, {
        fromId: usd,
        toId: inr,
        amountPaise: 100_00,
        date: '2024-02-01',
        rate: parseRateToScaled('82'),
        toAmountPaise: 8200_00,
      }),
    ).rejects.toBeInstanceOf(AmbiguousFxInputError);
  });

  it('rejects cross-currency with NO FX input (never a silent 1:1)', async () => {
    const h = seed();
    const usd = await acct(h, { currency: 'USD', opening: 500_00 });
    const inr = await acct(h, { currency: 'INR', opening: 0 });
    await expect(
      createTransfer(h, { userId: 'owner1' }, {
        fromId: usd,
        toId: inr,
        amountPaise: 100_00,
        date: '2024-02-01',
      }),
    ).rejects.toBeInstanceOf(CurrencyMismatchError);
  });

  it('the linkage rate is INDEPENDENT of the MC1 standing rate', async () => {
    const h = seed();
    const usd = await acct(h, { currency: 'USD', opening: 500_00 });
    const inr = await acct(h, { currency: 'INR', opening: 0 });
    setRate(h, 'USD', parseRateToScaled('90')); // standing mark says 90…

    const t = await createTransfer(h, { userId: 'owner1' }, {
      fromId: usd,
      toId: inr,
      amountPaise: 100_00,
      date: '2024-02-01',
      rate: parseRateToScaled('82'), // …but the transfer happened at 82
    });
    // The transfer stores 82 and does NOT touch the standing 90.
    expect(txRow(h, t.fromTxId).fxRateScaled).toBe(82_000_000);
    expect(listRates(h.db)[0]!.rate).toBe(90);
  });
});

// ── MC2 × C4: editing a cross-currency transfer re-derives the partner ────────

describe('updateTransaction (MC2 × C4): keep the other amount, re-derive the rate', () => {
  it('correcting the SOURCE amount keeps the destination and re-derives the rate', async () => {
    const h = seed();
    const usd = await acct(h, { currency: 'USD', opening: 500_00 });
    const inr = await acct(h, { currency: 'INR', opening: 0 });
    const t = await createTransfer(h, { userId: 'owner1' }, {
      fromId: usd,
      toId: inr,
      amountPaise: 100_00,
      date: '2024-02-01',
      rate: parseRateToScaled('82'),
    });

    const from = txRow(h, t.fromTxId);
    // Correct $100 → $102 out (a fee). The ₹8,200 received stays; the rate becomes 8200/102.
    await updateTransaction(h, { userId: 'owner1' }, t.fromTxId, { amountPaise: -102_00 }, from.updatedAt);

    expect(accountBalance(h.sqlite, usd)).toBe(500_00 - 102_00);
    expect(accountBalance(h.sqlite, inr)).toBe(8200_00);
    for (const id of [t.fromTxId, t.toTxId]) {
      expect(txRow(h, id)).toMatchObject({ fxRateScaled: 80_392_157, fxScale: 6 }); // 80.392157
    }
  });

  it('correcting the DESTINATION amount keeps the source and re-derives the rate', async () => {
    const h = seed();
    const usd = await acct(h, { currency: 'USD', opening: 500_00 });
    const inr = await acct(h, { currency: 'INR', opening: 0 });
    const t = await createTransfer(h, { userId: 'owner1' }, {
      fromId: usd,
      toId: inr,
      amountPaise: 100_00,
      date: '2024-02-01',
      rate: parseRateToScaled('82'),
    });

    const to = txRow(h, t.toTxId);
    // Correct the INR received ₹8,200 → ₹8,150 (P1's case: the statement says so). The $100
    // sent stays; the rate becomes 81.5 on both legs.
    await updateTransaction(h, { userId: 'owner1' }, t.toTxId, { amountPaise: 8150_00 }, to.updatedAt);

    expect(accountBalance(h.sqlite, inr)).toBe(8150_00);
    expect(txRow(h, t.fromTxId).amountPaise).toBe(-100_00);
    expect(accountBalance(h.sqlite, usd)).toBe(500_00 - 100_00);
    expect(txRow(h, t.fromTxId)).toMatchObject({ fxRateScaled: 81_500_000, fxScale: 6 });
  });

  it('INR into USD: a rate below 1 keeps 10 places after a correction', async () => {
    const h = seed();
    const inr = await acct(h, { currency: 'INR', opening: 1_00_000_00 });
    const usd = await acct(h, { currency: 'USD', opening: 0 });
    const t = await createTransfer(h, { userId: 'owner1' }, { fromId: inr, toId: usd, amountPaise: 8400_00, date: '2024-02-01', toAmountPaise: 100_00 });
    await updateTransaction(h, { userId: 'owner1' }, t.toTxId, { amountPaise: 99_50 }, txRow(h, t.toTxId).updatedAt);
    expect(txRow(h, t.fromTxId).amountPaise).toBe(-8400_00);
    expect(txRow(h, t.toTxId)).toMatchObject({ amountPaise: 99_50, fxRateScaled: 118_452_381, fxScale: 10 }); // 0.0118452381
  });

  it('deleting a cross-currency transfer removes BOTH legs', async () => {
    const h = seed();
    const usd = await acct(h, { currency: 'USD', opening: 500_00 });
    const inr = await acct(h, { currency: 'INR', opening: 0 });
    const t = await createTransfer(h, { userId: 'owner1' }, {
      fromId: usd,
      toId: inr,
      amountPaise: 100_00,
      date: '2024-02-01',
      rate: parseRateToScaled('82'),
    });
    const from = txRow(h, t.fromTxId);
    const res = await deleteTransaction(h, { userId: 'owner1' }, t.fromTxId, from.updatedAt);
    expect(res.deletedIds.sort()).toEqual([t.fromTxId, t.toTxId].sort());
    expect(accountBalance(h.sqlite, usd)).toBe(500_00);
    expect(accountBalance(h.sqlite, inr)).toBe(0);
  });
});

// ── P0: cross-currency transfer display is visibility-gated ───────────────────

describe('registerView (MC2 × P0): a NON-visible counterpart leg is nulled out', () => {
  it('shows the counterpart currency/amount to a holder, hides them from a non-holder', async () => {
    const h = seed();
    // owner2 joins account A only; account B stays owner1-private (unshared).
    h.db.insert(schema.users).values({ id: 'owner2', username: 'o2', displayName: 'Owner 2', role: 'member' }).run();
    const a = await acct(h, { currency: 'INR', opening: 0, name: 'Shared INR' });
    const b = await acct(h, { currency: 'USD', opening: 500_00, name: 'Private USD' });
    h.db.insert(schema.accountMembers).values({ accountId: a, userId: 'owner2' }).run();

    // owner1 (sees both) records a USD→INR transfer B→A.
    await createTransfer(h, { userId: 'owner1' }, {
      fromId: b,
      toId: a,
      amountPaise: 100_00,
      date: '2024-02-01',
      rate: parseRateToScaled('82'),
    });

    // The holder (owner1) sees the counterpart leg fully.
    const asHolder = await registerView(h, 'owner1', a);
    expect(asHolder.rows[0]!.counterpartAccountName).toBe('Private USD');
    expect(asHolder.rows[0]!.counterpartCurrency).toBe('USD');
    expect(asHolder.rows[0]!.counterpartAmountPaise).toBe(-100_00);

    // owner2 sees A but NOT B → the counterpart name/currency/AMOUNT are all null
    // (P0: a non-holder never learns B's existence, currency, or leg amount).
    const asOutsider = await registerView(h, 'owner2', a);
    expect(asOutsider.rows[0]!.counterpartAccountName).toBeNull();
    expect(asOutsider.rows[0]!.counterpartCurrency).toBeNull();
    expect(asOutsider.rows[0]!.counterpartAmountPaise).toBeNull();
  });
});
