/**
 * real-dates.test.ts: a date that isn't a day of the calendar ('2026-02-31', '2026-13-01') is
 * refused wherever a date comes in. First the harm: such a row, stored
 * straight into the database, stops the dashboard for everyone who holds the account.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { parseDate } from '@miserly/core';
import { createDb, type Db } from '../src/lib/server/db/client';
import { allStatements } from '../src/lib/server/db/migrate';
import * as schema from '../src/lib/server/db/schema';
import { createAdmin } from '../src/lib/server/auth/users';
import { createAccount, setOpeningBalance } from '../src/lib/server/accounts';
import { createTransaction, updateTransaction } from '../src/lib/server/transactions';
import { createTransfer } from '../src/lib/server/transfers';
import { postValuationMark } from '../src/lib/server/marks';
import { dashboardSummary } from '../src/lib/server/dashboard';
import { isRealDate } from '../src/lib/dates';

let handle: Db | undefined;
afterEach(() => {
  handle?.sqlite.close();
  handle = undefined;
});

async function fresh() {
  const h = createDb(':memory:');
  for (const stmt of allStatements()) h.sqlite.exec(stmt);
  handle = h;
  const alice = await createAdmin(h.db, { username: 'alice', displayName: 'Alice', password: 'alice-password-123' });
  const open = (type: string, name: string) =>
    createAccount(h, { ownerId: alice.id, type, name, currency: 'INR', openingPaise: 1_000_00, openingDate: '2026-01-01' });
  const bank = await open('bank', 'Bank');
  const other = await open('bank', 'Other bank');
  const fund = await open('mutualFunds', 'Fund');
  return { h, alice, bank, other, fund };
}

const NOT_REAL = ['2026-02-31', '2026-13-01', '2026-00-10', '2026-04-31', '2025-02-29'];

describe('S20: the harm, now read past (hosted audit H2; every page in stored-bad-date.test.ts)', () => {
  it('a stored 2026-02-31 row no longer makes dashboardSummary throw', async () => {
    const { h, alice, bank } = await fresh();
    h.db.insert(schema.transactions)
      .values({ id: randomUUID(), accountId: bank.id, date: '2026-02-31', sequence: 1, amountPaise: -100, enteredBy: alice.id })
      .run();
    await expect(dashboardSummary(h, alice.id)).resolves.toBeDefined();
  });
});

describe('S20: isRealDate', () => {
  it("agrees with Temporal's round trip for every candidate date of 2023 to 2025", () => {
    for (let y = 2023; y <= 2025; y++) {
      for (let m = 0; m <= 13; m++) {
        for (let d = 0; d <= 32; d++) {
          const s = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
          let temporal = false;
          try {
            temporal = parseDate(s).toString() === s;
          } catch {
            temporal = false;
          }
          expect(isRealDate(s), s).toBe(temporal);
        }
      }
    }
  });

  it.each(['2024-02-29', '2000-02-29', '2026-12-31'])('%s is real', (s) => expect(isRealDate(s)).toBe(true));
  it.each([...NOT_REAL, '1900-02-29', '2026-2-1', '2026-02-01x', ' 2026-02-01', ''])('%j is not', (s) => expect(isRealDate(s)).toBe(false));
});

describe('S20: every service refuses a date that is not real', () => {
  it.each(NOT_REAL)('%s', async (bad) => {
    const { h, alice, bank, other, fund } = await fresh();
    const actor = { userId: alice.id };
    await expect(createTransaction(h, actor, { accountId: bank.id, date: bad, amountPaise: -100 })).rejects.toThrow(/date/i);
    const tx = await createTransaction(h, actor, { accountId: bank.id, date: '2026-03-01', amountPaise: -100 });
    await expect(updateTransaction(h, actor, tx.id, { date: bad }, tx.updatedAt)).rejects.toThrow(/date/i);
    await expect(createTransfer(h, actor, { fromId: bank.id, toId: other.id, amountPaise: 100, date: bad })).rejects.toThrow(/date/i);
    await expect(postValuationMark(h, actor, { accountId: fund.id, targetPaise: 2_000_00, date: bad })).rejects.toThrow(/date/i);
    await expect(
      createAccount(h, { ownerId: alice.id, type: 'bank', name: `New ${bad}`, currency: 'INR', openingPaise: 100, openingDate: bad }),
    ).rejects.toThrow(/date/i);
    await expect(setOpeningBalance(h, bank.id, 500_00, bad)).rejects.toThrow(/date/i);
    // Nothing was stored with that date.
    expect(h.sqlite.prepare('SELECT COUNT(*) AS n FROM transactions WHERE date = ?').get(bad)).toEqual({ n: 0 });
  });
});
