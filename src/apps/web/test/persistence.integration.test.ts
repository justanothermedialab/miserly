/**
 * persistence.integration.test.ts — the M3 DIFFERENTIAL proof.
 * ============================================================================
 * The raw-SQL running-balance window function (balances.ts) is only trustworthy
 * if it reconciles with the pure engine (packages/core/src/ledger.ts) BIT-FOR-
 * BIT. This suite persists transactions to SQLite, reads them back, and asserts
 * the SQL result equals the engine's derived result — per row and in scalar —
 * across the exact bug-class cases the model exists to defend: a back-dated
 * insert, a same-date reorder, and a soft-deleted row. A fast-check property
 * then hammers the same equality over random ledgers (the strongest drift catch).
 * ============================================================================
 */
import { afterEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { and, eq, isNull } from 'drizzle-orm';
import {
  parseDate,
  runningBalances as engineRunningBalances,
  orderedBalance,
  balanceAsOf,
} from '@miserly/core';
import type Database from 'better-sqlite3';
import { createDb } from '../src/lib/server/db/client';
import { allStatements } from '../src/lib/server/db/migrate';
import { runningBalances as sqlRunningBalances, accountBalance } from '../src/lib/server/db/balances';
import { rowToAccountView } from '../src/lib/server/db/mappers';
import * as schema from '../src/lib/server/db/schema';

const ACCOUNT = 'a1';
const OWNER = 'u1';

interface TxSeed {
  readonly id: string;
  readonly date: string;
  readonly sequence: number;
  readonly amountPaise: number;
  readonly deleted?: boolean;
}

let open: ReturnType<typeof createDb> | undefined;
afterEach(() => {
  open?.sqlite.close();
  open = undefined;
});

/** Fresh in-memory db with the frozen schema applied and a user+account seeded. */
function seed(openingPaise: number, txs: readonly TxSeed[]): ReturnType<typeof createDb> {
  const handle = createDb(':memory:');
  open = handle;
  const { sqlite, db } = handle;
  for (const stmt of allStatements()) sqlite.exec(stmt);

  db.insert(schema.users).values({ id: OWNER, displayName: 'Owner' }).run();
  db
    .insert(schema.accounts)
    .values({
      id: ACCOUNT,
      ownerId: OWNER,
      name: 'Account',
      type: 'bank',
      currency: 'INR',
      status: 'open',
      openingPaise,
    })
    .run();
  for (const t of txs) {
    db
      .insert(schema.transactions)
      .values({
        id: t.id,
        accountId: ACCOUNT,
        date: t.date,
        sequence: t.sequence,
        amountPaise: t.amountPaise,
        ...(t.deleted ? { deletedAt: '2020-01-01 00:00:00' } : {}),
      })
      .run();
  }
  return handle;
}

/** The engine's view of the account, built from the LIVE rows in the db. */
function engineView(sqlite: Database.Database, db: ReturnType<typeof createDb>['db']) {
  const accountRow = db.select().from(schema.accounts).where(eq(schema.accounts.id, ACCOUNT)).get();
  if (!accountRow) throw new Error('account not found');
  const liveRows = db
    .select()
    .from(schema.transactions)
    .where(and(eq(schema.transactions.accountId, ACCOUNT), isNull(schema.transactions.deletedAt)))
    .all();
  return rowToAccountView(accountRow, liveRows);
}

/** Assert SQL window fn == engine runningBalances (row-for-row) + scalars match. */
function assertReconciles(handle: ReturnType<typeof createDb>, asOf?: string): void {
  const { sqlite, db } = handle;
  const view = engineView(sqlite, db);

  const sqlRows = sqlRunningBalances(sqlite, ACCOUNT);
  const engineRows = engineRunningBalances(view.opening, view.transactions);

  expect(sqlRows.length).toBe(engineRows.length);
  for (let i = 0; i < sqlRows.length; i++) {
    const s = sqlRows[i]!;
    const e = engineRows[i]!;
    expect(s.id).toBe(e.transaction.id);
    expect(s.balancePaise).toBe(e.balance.paise);
  }

  expect(accountBalance(sqlite, ACCOUNT)).toBe(orderedBalance(view.opening, view.transactions).paise);
  if (asOf !== undefined) {
    expect(accountBalance(sqlite, ACCOUNT, asOf)).toBe(
      balanceAsOf(view.opening, view.transactions, parseDate(asOf)).paise,
    );
  }
}

describe('persistence: SQL window fn reconciles with the engine', () => {
  it('a simple ledger reconciles (opening + ordered sum)', () => {
    const handle = seed(100_00, [
      { id: 't1', date: '2024-01-02', sequence: 0, amountPaise: 50_00 },
      { id: 't2', date: '2024-01-05', sequence: 0, amountPaise: -30_00 },
    ]);
    assertReconciles(handle, '2024-01-03');
    // Spot the exact figures: 100 + 50 = 150, then 150 - 30 = 120.
    const rows = sqlRunningBalances(handle.sqlite, ACCOUNT);
    expect(rows.map((r) => r.balancePaise)).toEqual([150_00, 120_00]);
    expect(accountBalance(handle.sqlite, ACCOUNT, '2024-01-03')).toBe(150_00);
  });

  it('a BACK-DATED insert lands in date order and shifts later balances', () => {
    // t_back is inserted last but dated earliest — it must sort first and lift
    // every subsequent running balance, exactly as the engine derives.
    const handle = seed(0, [
      { id: 't-mid', date: '2024-03-10', sequence: 0, amountPaise: 200_00 },
      { id: 't-late', date: '2024-03-20', sequence: 0, amountPaise: 100_00 },
      { id: 't-back', date: '2024-03-01', sequence: 0, amountPaise: 500_00 },
    ]);
    const rows = sqlRunningBalances(handle.sqlite, ACCOUNT);
    expect(rows.map((r) => r.id)).toEqual(['t-back', 't-mid', 't-late']);
    expect(rows.map((r) => r.balancePaise)).toEqual([500_00, 700_00, 800_00]);
    assertReconciles(handle, '2024-03-15');
  });

  it('a SAME-DATE reorder follows sequence, not insert order', () => {
    // Same date, inserted out of sequence order; ledger order is by sequence.
    const handle = seed(0, [
      { id: 't-seq2', date: '2024-05-01', sequence: 2, amountPaise: -100_00 },
      { id: 't-seq0', date: '2024-05-01', sequence: 0, amountPaise: 1000_00 },
      { id: 't-seq1', date: '2024-05-01', sequence: 1, amountPaise: -250_00 },
    ]);
    const rows = sqlRunningBalances(handle.sqlite, ACCOUNT);
    expect(rows.map((r) => r.id)).toEqual(['t-seq0', 't-seq1', 't-seq2']);
    expect(rows.map((r) => r.balancePaise)).toEqual([1000_00, 750_00, 650_00]);
    assertReconciles(handle);
  });

  it('a SOFT-DELETED row is excluded from both the window fn and the scalar', () => {
    const handle = seed(0, [
      { id: 't-live1', date: '2024-06-01', sequence: 0, amountPaise: 300_00 },
      { id: 't-dead', date: '2024-06-02', sequence: 0, amountPaise: 999_00, deleted: true },
      { id: 't-live2', date: '2024-06-03', sequence: 0, amountPaise: 200_00 },
    ]);
    const rows = sqlRunningBalances(handle.sqlite, ACCOUNT);
    expect(rows.map((r) => r.id)).toEqual(['t-live1', 't-live2']);
    expect(rows.map((r) => r.balancePaise)).toEqual([300_00, 500_00]);
    expect(accountBalance(handle.sqlite, ACCOUNT)).toBe(500_00);
    assertReconciles(handle);
  });

  it('an account with no transactions has balance = opening', () => {
    const handle = seed(4200_00, []);
    expect(sqlRunningBalances(handle.sqlite, ACCOUNT)).toEqual([]);
    expect(accountBalance(handle.sqlite, ACCOUNT)).toBe(4200_00);
    expect(accountBalance(handle.sqlite, ACCOUNT, '2024-01-01')).toBe(4200_00);
  });
});

describe('persistence property: window fn == engine over random ledgers', () => {
  it('matches the engine row-for-row for any generated ledger', () => {
    const dateArb = fc.constantFrom(
      '2024-01-01',
      '2024-01-02',
      '2024-01-03',
      '2024-02-01',
      '2024-02-15',
      '2024-03-31',
    );
    const txsArb = fc.array(
      fc.record({ date: dateArb, amountPaise: fc.integer({ min: -1_000_000, max: 1_000_000 }) }),
      { maxLength: 40 },
    );

    fc.assert(
      fc.property(fc.integer({ min: -500_000, max: 500_000 }), txsArb, (openingPaise, raw) => {
        // Globally-unique, monotonic `sequence` (a valid within-date tiebreaker)
        // keeps (date, sequence) unique, mirroring how real inserts assign it.
        const txs: TxSeed[] = raw.map((r, i) => ({
          id: `t${i}`,
          date: r.date,
          sequence: i,
          amountPaise: r.amountPaise,
        }));
        const handle = seed(openingPaise, txs);
        try {
          const { sqlite, db } = handle;
          const view = engineView(sqlite, db);
          const sqlRows = sqlRunningBalances(sqlite, ACCOUNT);
          const engineRows = engineRunningBalances(view.opening, view.transactions);
          expect(sqlRows.length).toBe(engineRows.length);
          for (let i = 0; i < sqlRows.length; i++) {
            expect(sqlRows[i]!.id).toBe(engineRows[i]!.transaction.id);
            expect(sqlRows[i]!.balancePaise).toBe(engineRows[i]!.balance.paise);
          }
          expect(accountBalance(sqlite, ACCOUNT)).toBe(
            orderedBalance(view.opening, view.transactions).paise,
          );
        } finally {
          handle.sqlite.close();
          open = undefined;
        }
      }),
    );
    // fast-check runs many cases, each seeding a fresh in-memory DB; on a loaded
    // low-RAM box the default 5s can be too tight (the logic is fast). 30s headroom.
  }, 30_000);
});
