/**
 * ledger-cuts.property.test.ts: the grouped SQL sums value every account exactly as its rows do.
 * The sidebar, the dashboard and the charts now hand the engine one row per date asked
 * for, the SQL sum of the rows up to it (`ledgerCuts`, `cutViews`), instead of every row. For every
 * registered module, on random ledgers (back-dated, same-day, future-dated, deleted rows, value
 * updates, stored dates that aren't days of the calendar), the module's `currentValue` of that view
 * at each date equals its `currentValue` of the view of every live row: so the numbers can't
 * change, only their cost. A module that ever values more than the balance fails here first.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { allModules, getModule, formatDate, parseDate } from '@miserly/core';
import { createDb, type Db } from '../src/lib/server/db/client';
import { allStatements } from '../src/lib/server/db/migrate';
import * as schema from '../src/lib/server/db/schema';
import { ledgerCuts, cutViews, inLedgerScope } from '../src/lib/server/ledger-cuts';
import { rowToAccountView, parseStoredDate } from '../src/lib/server/db/mappers';
import { isNull } from 'drizzle-orm';

let h: Db;
const types = allModules().map((m) => m.type);
const DAY0 = parseDate('2023-01-01');
const iso = (day: number) => formatDate(DAY0.add({ days: day }));
/** Stored dates the H2 audit found in files: not days of the calendar. */
const ODD = ['2024-02-30', '2023-02-29', '2025-04-31', '2024-06-00', '2024-13-05'];

beforeAll(() => {
  h = createDb(':memory:');
  for (const stmt of allStatements()) h.sqlite.exec(stmt);
  h.db.insert(schema.users).values({ id: 'alice', username: 'alice', displayName: 'Alice', role: 'admin' }).run();
});
afterAll(() => h.sqlite.close());

const rowArb = fc.record({
  account: fc.nat({ max: types.length - 1 }),
  day: fc.integer({ min: 0, max: 1500 }), // to early 2027: some after every cut
  odd: fc.option(fc.constantFrom(...ODD), { freq: 8 }),
  sequence: fc.integer({ min: 0, max: 3 }),
  amount: fc.integer({ min: -5_000_000, max: 5_000_000 }),
  mark: fc.boolean(),
  deleted: fc.boolean(),
});
const caseArb = fc.record({
  openings: fc.array(fc.integer({ min: -1_000_000, max: 1_000_000 }), { minLength: types.length, maxLength: types.length }),
  rows: fc.array(rowArb, { maxLength: 60 }),
  cuts: fc.uniqueArray(fc.integer({ min: 0, max: 1400 }), { maxLength: 8 }).map((a) => a.sort((x, y) => x - y)),
});

let run = 0;
describe('a view of the grouped sums values as the rows do (every module)', () => {
  it('at every cut, and after the last one', () => {
    fc.assert(
      fc.property(caseArb, (c) => {
        run++;
        h.sqlite.exec('DELETE FROM transactions; DELETE FROM accounts;');
        const accounts = types.map((type, i) => ({
          id: `a${run}-${i}`, ownerId: 'alice', type, name: `${type} ${i}`, currency: 'INR', openingPaise: c.openings[i]!,
        }));
        h.db.insert(schema.accounts).values(accounts).run();
        const used = new Set<string>();
        c.rows.forEach((r, k) => {
          const accountId = accounts[r.account]!.id;
          const date = r.odd ?? iso(r.day);
          // (account, date, sequence) is unique: a repeat moves to the next free sequence.
          let sequence = r.sequence;
          while (used.has(`${accountId}|${date}|${sequence}`)) sequence++;
          used.add(`${accountId}|${date}|${sequence}`);
          h.db.insert(schema.transactions).values({
            id: `t${run}-${k}`, accountId, date, sequence, amountPaise: r.amount, kind: r.mark ? 'valuationMark' : 'ordinary',
            markTargetPaise: r.mark ? r.amount : null, enteredBy: 'alice', deletedAt: r.deleted ? '2026-01-01T00:00:00Z' : null,
          }).run();
        });

        const rows = h.db.select().from(schema.accounts).all();
        const live = h.db.select().from(schema.transactions).where(isNull(schema.transactions.deletedAt)).all();
        const cutIso = c.cuts.map(iso);
        const cutDates = cutIso.map((d) => parseDate(d));
        const lc = ledgerCuts(h.sqlite, rows.map((a) => a.id), cutIso);
        const views = cutViews(rows, cutDates, lc);
        const after = parseDate('2031-01-01');

        rows.forEach((a, i) => {
          const mine = live.filter((t) => t.accountId === a.id);
          const full = rowToAccountView(a, mine);
          const module = getModule(a.type);
          for (const at of [...cutDates, after]) {
            expect(module.currentValue(views[i]!, at).paise, `${a.type} at ${formatDate(at)}`).toBe(module.currentValue(full, at).paise);
          }
          // Its first and last row, as the engine reads the dates.
          const real = mine.map((t) => formatDate(parseStoredDate(t.date))).sort();
          expect(lc.first.get(a.id)).toBe(real[0]);
          expect(lc.last.get(a.id)).toBe(real.at(-1));
        });

        // Within a request, every subset of the cuts is cut from the first sum, as summed alone.
        inLedgerScope(() => {
          const ids = rows.map((a) => a.id);
          ledgerCuts(h.sqlite, ids, cutIso);
          for (const pick of [cutIso.filter((_, i) => i % 2 === 0), cutIso.filter((_, i) => i % 2 === 1), cutIso.slice(-1), []]) {
            const cut = ledgerCuts(h.sqlite, ids, pick);
            const alone = ledgerCuts(h.sqlite, [...ids, 'none'], pick); // another key: summed afresh
            for (const id of ids) expect(cut.sums.get(id), `${id} at ${pick.join(',')}`).toEqual(alone.sums.get(id));
          }
        });
      }),
      { numRuns: 60 },
    );
  });
});
