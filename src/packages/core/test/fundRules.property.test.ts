/**
 * fundRules.property.test.ts: the red team's fund rules, as
 * properties over generated holdings, plus the worked cases (N-03 to N-06, N-14, N-15,
 * RT-14). The web suite holds the same cases through the real services
 * (`apps/web/test/red-team-2026-11*.test.ts`); these hold the engine alone.
 *
 * The row kinds a holding can carry, as the app maps them:
 *   - a transfer leg (money moved), flagged return when its category counts as return (a payout);
 *   - a plain row: growth (no flag, or flagged return) or money put in or taken out (flag false);
 *   - a valuation mark (growth, never money moved).
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import '../src/modules/index.js';
import { parseDate } from '../src/date.js';
import { Money } from '../src/money.js';
import { getModule } from '../src/aggregation/registry.js';
import { annualReturn, closedEndDate, holdingEarned, holdingFlows, lastValueDate, setsValue } from '../src/aggregation/annualReturn.js';
import type { AccountView } from '../src/aggregation/contract.js';
import type { Transaction } from '../src/transaction.js';

const INR = 'INR';
const END = parseDate('2030-12-31');
const DATES = ['2024-01-01', '2024-06-30', '2025-03-31', '2025-12-31', '2026-06-30'] as const;

type RowKind = 'transfer' | 'transferInvested' | 'payout' | 'plainGrowth' | 'plainReturn' | 'plainInvested' | 'mark';
const ROW_KINDS: readonly RowKind[] = ['transfer', 'transferInvested', 'payout', 'plainGrowth', 'plainReturn', 'plainInvested', 'mark'];

function row(id: string, date: string, sequence: number, paise: number, kind: RowKind): Transaction {
  const base = { id, accountId: 'h', date: parseDate(date), sequence, amount: Money.fromPaise(paise, INR) };
  switch (kind) {
    case 'transfer':
      return { ...base, transferPartnerId: `${id}-p` };
    case 'transferInvested':
      return { ...base, transferPartnerId: `${id}-p`, countsAsReturn: false };
    case 'payout':
      return { ...base, transferPartnerId: `${id}-p`, countsAsReturn: true };
    case 'plainGrowth':
      return base;
    case 'plainReturn':
      return { ...base, countsAsReturn: true };
    case 'plainInvested':
      return { ...base, countsAsReturn: false };
    case 'mark':
      return { ...base, kind: 'valuationMark' };
  }
}

function account(opening: number, transactions: Transaction[], type = 'mutualFunds', status: 'open' | 'closed' = 'open'): AccountView {
  return { id: 'h', type, currency: INR, status, opening: Money.fromPaise(opening, INR), transactions };
}

const fund = getModule('mutualFunds');
const basis = (a: AccountView, asOf = END) => getModule(a.type).costBasis(a, asOf).paise;
const value = (a: AccountView, asOf = END) => getModule(a.type).currentValue(a, asOf).paise;

/** Rows with unique ids and per-date sequences, amounts and kinds drawn freely. */
function rowsArb(kinds: readonly RowKind[], amount: fc.Arbitrary<number>): fc.Arbitrary<Transaction[]> {
  return fc
    .array(fc.record({ date: fc.constantFrom(...DATES), paise: amount, kind: fc.constantFrom(...kinds) }), { maxLength: 25 })
    .map((entries) => {
      const seq = new Map<string, number>();
      return entries.map((e, i) => {
        const s = seq.get(e.date) ?? 0;
        seq.set(e.date, s + 1);
        return row(`t${i}`, e.date, s, e.paise, e.kind);
      });
    });
}
const openingArb = fc.integer({ min: 0, max: 50_00_000_00 });
const inArb = fc.integer({ min: 1, max: 10_00_000_00 });
const anyArb = fc.integer({ min: -10_00_000_00, max: 10_00_000_00 });

const isGrowth = (t: Transaction) =>
  t.kind === 'valuationMark' || t.countsAsReturn === true || (t.transferPartnerId === undefined && t.countsAsReturn !== false);

describe('C3 (rule 2): what is money put in, and what is return', () => {
  it('with money only ever going in, return = Σ growth rows (marks, return-category rows, uncategorised rows)', () => {
    fc.assert(
      fc.property(openingArb, rowsArb(ROW_KINDS.filter((k) => k !== 'payout'), inArb), (opening, txs) => {
        const a = account(opening, txs);
        const growth = txs.filter(isGrowth).reduce((s, t) => s + t.amount.paise, 0);
        expect(value(a) - basis(a)).toBe(growth);
        expect(basis(a)).toBe(opening + txs.filter((t) => !isGrowth(t)).reduce((s, t) => s + t.amount.paise, 0));
      }),
    );
  });

  it('a payout (a transfer out whose category counts as return) never moves Invested', () => {
    fc.assert(
      fc.property(openingArb, rowsArb(ROW_KINDS, anyArb), inArb, (opening, txs, paid) => {
        const before = account(opening, txs);
        const after = account(opening, [...txs, row('payout', '2027-01-01', 0, -paid, 'payout')]);
        expect(basis(after)).toBe(basis(before));
        expect(value(after)).toBe(value(before) - paid);
      }),
    );
  });

  it('the cash flows are exactly the money moved: marks and growth rows are never a flow, payouts are', () => {
    fc.assert(
      fc.property(openingArb, rowsArb(ROW_KINDS, anyArb), (opening, txs) => {
        const a = account(opening, txs);
        const cf = fund.cashFlows(a, { from: parseDate('2000-01-01'), to: END });
        const moved = txs.filter((t) => !(t.kind === 'valuationMark' || (t.transferPartnerId === undefined && t.countsAsReturn !== false)));
        expect(cf.inflow.paise - cf.outflow.paise).toBe(moved.reduce((s, t) => s + t.amount.paise, 0));
      }),
    );
  });

  it("N-14: EPF's Salary typed inside the EPF is money put in, not return", () => {
    const epf = account(1_00_000_00, [row('sal', '2026-10-31', 0, 7_200_00, 'plainInvested')], 'otherAsset');
    expect(basis(epf)).toBe(1_07_200_00);
    expect(value(epf) - basis(epf)).toBe(0);
    // The same row uncategorised (no flag) stays growth, as before (no existing figure flips).
    const old = account(1_00_000_00, [row('sal', '2026-10-31', 0, 7_200_00, 'plainGrowth')], 'otherAsset');
    expect(value(old) - basis(old)).toBe(7_200_00);
  });

  it('a payout typed out of an FD lowers its value and leaves Invested (the reason C1 shows the stated rate instead)', () => {
    const fd = account(1_00_000_00, [row('p1', '2025-03-31', 0, -7_000_00, 'payout'), row('p2', '2026-03-31', 0, -7_000_00, 'payout')], 'fd');
    expect(value(fd)).toBe(86_000_00);
    expect(basis(fd)).toBe(1_00_000_00);
  });
});

describe('Rule 1: Invested after money taken out = the cost of what is still held', () => {
  it('Invested is never below 0 nor above the opening plus all money put in', () => {
    fc.assert(
      fc.property(openingArb, rowsArb(ROW_KINDS, anyArb), (opening, txs) => {
        const a = account(opening, txs);
        const putIn = txs.filter((t) => !isGrowth(t) && t.amount.paise > 0).reduce((s, t) => s + t.amount.paise, 0);
        expect(basis(a)).toBeGreaterThanOrEqual(0);
        expect(basis(a)).toBeLessThanOrEqual(opening + putIn);
      }),
    );
  });

  it('a withdrawal keeps the gain per rupee: Invested falls by the share of value taken out (to a paisa)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_00_00_000_00 }),
        fc.integer({ min: 1, max: 1_00_00_000_00 }),
        fc.integer({ min: 1, max: 1_00_00_000_00 }),
        (invested, worth, out) => {
          const taken = Math.min(out, worth);
          const a = account(invested, [
            row('m', '2025-01-01', 0, worth - invested, 'mark'),
            row('w', '2025-06-30', 0, -taken, 'transfer'),
          ]);
          // Invested × (1 − taken ÷ worth), in whole paise.
          expect(Math.abs(basis(a) - (invested * (worth - taken)) / worth)).toBeLessThanOrEqual(0.5);
        },
      ),
    );
  });

  it('taking out the whole value (or more) leaves Invested at 0; nothing more is taken off later', () => {
    fc.assert(
      fc.property(openingArb, inArb, fc.integer({ min: 0, max: 10_00_000_00 }), (opening, worth, extra) => {
        const a = account(opening, [
          row('m', '2025-01-01', 0, worth - opening, 'mark'),
          row('w', '2025-06-30', 0, -(worth + extra), 'transfer'),
          row('w2', '2025-07-31', 0, -1_000_00, 'transfer'), // value at or below 0 before it: skipped
        ]);
        expect(basis(a)).toBe(0);
        expect(value(a)).toBe(-extra - 1_000_00);
      }),
    );
  });

  it('rows are walked in (date, sequence) order whatever order they arrive in', () => {
    fc.assert(
      fc.property(openingArb, rowsArb(ROW_KINDS, anyArb), fc.integer(), (opening, txs, seed) => {
        const shuffled = [...txs].sort((x, y) => ((x.id.length * 31 + seed) % 7) - ((y.id.length * 17 + seed) % 5));
        expect(basis(account(opening, shuffled))).toBe(basis(account(opening, txs)));
      }),
    );
  });

  it('a loan keeps the old rule: money moved adds, floored at 0 (its basis is never shown)', () => {
    const loan = account(-5_00_000_00, [row('emi', '2025-01-05', 0, 10_379_00, 'transfer')], 'loan');
    expect(basis(loan)).toBe(0);
  });

  it('₹1L in, worth ₹2L, ₹1.5L redeemed: Invested ₹25,000, return ₹25,000 (+100 %)', () => {
    const mf = account(1_00_000_00, [row('m', '2026-06-30', 0, 1_00_000_00, 'mark'), row('w', '2026-07-15', 0, -1_50_000_00, 'transfer')]);
    expect(value(mf)).toBe(50_000_00);
    expect(basis(mf)).toBe(25_000_00);
  });

  it('₹1.5L taken from a fund recorded at ₹1L: Invested 0, the value below zero until updated', () => {
    const mf = account(1_00_000_00, [row('w', '2026-10-15', 0, -1_50_000_00, 'transfer')]);
    expect(basis(mf)).toBe(0);
    expect(value(mf)).toBe(-50_000_00);
  });
});

describe('Rule 3: the value is known at the last value update or growth typed inside', () => {
  it('the last value date is always a mark or a positive growth row, never money moved or a loss', () => {
    fc.assert(
      fc.property(openingArb, rowsArb(ROW_KINDS, anyArb), (opening, txs) => {
        const a = account(opening, txs);
        const last = lastValueDate(a, parseDate('2000-01-01'), END);
        const setters = txs.filter((t) => t.kind === 'valuationMark' || (t.transferPartnerId === undefined && t.countsAsReturn !== false && t.amount.paise > 0));
        expect(setters.every(setsValue)).toBe(true);
        if (setters.length === 0) expect(last).toBeNull();
        else expect(last?.toString()).toBe(setters.map((t) => t.date.toString()).sort().at(-1));
      }),
    );
  });

  it("an FD whose interest is typed inside it each year reads its own rate a year, however long it's held after", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 100, max: 1500 }), // rate in basis points
        fc.integer({ min: 10_000_00, max: 1_00_00_000_00 }),
        fc.integer({ min: 2, max: 6 }),
        fc.integer({ min: 0, max: 300 }), // days since the last interest row
        (bp, principal, years, idle) => {
          const r = bp / 10_000;
          const start = parseDate('2020-04-01');
          const rows: Transaction[] = [];
          let held = principal;
          for (let k = 1; k <= years; k++) {
            const interest = Math.round(principal * Math.pow(1 + r, k)) - held;
            held += interest;
            rows.push(row(`i${k}`, start.add({ years: k }).toString(), 0, interest, 'plainReturn'));
          }
          const fd = account(principal, rows, 'fd');
          const today = start.add({ years, days: idle });
          const end = lastValueDate(fd, start, today)!;
          expect(end.toString()).toBe(start.add({ years }).toString());
          const rate = annualReturn([holdingFlows(fd, start, end)!])!;
          expect(Math.abs(rate - r)).toBeLessThan(0.002); // a leap day moves it a little
        },
      ),
    );
  });

  it('a ₹0 value update is a value date and moves nothing', () => {
    const p = account(50_00_000_00, [row('z', '2026-11-01', 0, 0, 'mark')], 'property');
    expect(lastValueDate(p, parseDate('2020-01-01'), parseDate('2026-11-06'))?.toString()).toBe('2026-11-01');
    expect(value(p)).toBe(50_00_000_00);
    expect(basis(p)).toBe(50_00_000_00);
  });
});

describe('Rule 4 (N-15): a closed holding shows what it earned, money out minus money in', () => {
  it('earned = value + money out − opening − money in, and with the value at 0 it is the sum of its growth rows', () => {
    fc.assert(
      fc.property(openingArb, rowsArb(ROW_KINDS, anyArb), (opening, txs) => {
        const a = account(opening, txs);
        // Growth here is every row that isn't money moved (a payout is money moved: it left the holding).
        const notMoved = (t: Transaction) => t.kind === 'valuationMark' || (t.transferPartnerId === undefined && t.countsAsReturn !== false);
        const growth = txs.filter(notMoved).reduce((s, t) => s + t.amount.paise, 0);
        // value = opening + Σ all rows, so value − opening − Σ money moved = Σ growth rows.
        expect(holdingEarned(a, END)).toBe(growth);
        // Closed: a last row takes the value to 0 (Pay and close); what it earned doesn't change.
        const closed = account(opening, [...txs, row('close', '2027-01-01', 0, -value(a), 'transfer')], 'mutualFunds', 'closed');
        expect(value(closed)).toBe(0);
        expect(holdingEarned(closed, END)).toBe(growth);
      }),
    );
  });

  it('N-15: an FD with ₹14,490 of interest typed inside, paid to the bank and closed months later, earned ₹14,490 at its 7 %', () => {
    const fd = account(1_00_000_00, [
      row('i1', '2025-03-31', 0, 7_000_00, 'plainReturn'),
      row('i2', '2026-03-31', 0, 7_490_00, 'plainReturn'),
      row('pay', '2026-11-06', 0, -1_14_490_00, 'transfer'),
    ], 'fd', 'closed');
    expect(holdingEarned(fd, END)).toBe(14_490_00);
    const start = parseDate('2024-04-01');
    const end = closedEndDate(fd, start, END)!;
    expect(end.toString()).toBe('2026-03-31');
    expect(annualReturn([holdingFlows(fd, start, end)!])!).toBeCloseTo(0.07, 3);
  });

  it('written off after its interest, it lost ₹1,00,000 and has no rate (no money ever came out)', () => {
    const fd = account(1_00_000_00, [
      row('i1', '2025-03-31', 0, 7_000_00, 'plainReturn'),
      row('off', '2026-11-06', 0, -1_07_000_00, 'plainReturn'), // Balance adjustment counts as return
    ], 'fd', 'closed');
    expect(holdingEarned(fd, END)).toBe(-1_00_000_00);
    const start = parseDate('2024-04-01');
    const end = closedEndDate(fd, start, END)!;
    expect(end.toString()).toBe('2026-11-06');
    expect(annualReturn([holdingFlows(fd, start, end)!])).toBeNull();
  });

  it('a fund bought and sold with no value update ends at the sale, its rate from the money alone', () => {
    const mf = account(1_00_000_00, [row('sell', '2026-04-01', 0, -1_21_000_00, 'transfer'), row('adj', '2026-04-01', 1, 21_000_00, 'plainReturn')], 'mutualFunds', 'closed');
    expect(holdingEarned(mf, END)).toBe(21_000_00);
    const start = parseDate('2024-04-01');
    const end = closedEndDate(mf, start, END)!;
    expect(end.toString()).toBe('2026-04-01');
    expect(annualReturn([holdingFlows(mf, start, end)!])!).toBeCloseTo(0.1, 3);
  });
});
