/**
 * Tests for aggregation/annualReturn.ts: the return per year (S2 RD6) and the value / invested
 * series (chart I1). The solver is checked against a closed form and a published spreadsheet
 * figure; the flows against the transfer-vs-mark rule (a mark is value, never a cash flow).
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import '../src/modules/index.js';
import { parseDate } from '../src/date.js';
import { Money } from '../src/money.js';
import {
  annualReturn,
  holdingFlows,
  lastValueDate,
  valueInvestedSeries,
  xirr,
} from '../src/aggregation/annualReturn.js';
import type { AccountView } from '../src/aggregation/contract.js';
import type { Transaction } from '../src/transaction.js';

const INR = 'INR';
const d = parseDate;

function transfer(id: string, date: string, paise: number): Transaction {
  return { id, accountId: 'mf', date: d(date), sequence: 0, amount: Money.fromPaise(paise, INR), transferPartnerId: `p-${id}` };
}
function mark(id: string, date: string, paise: number): Transaction {
  return { id, accountId: 'mf', date: d(date), sequence: 1, amount: Money.fromPaise(paise, INR), kind: 'valuationMark' };
}
function fund(opening: number, txs: Transaction[], type = 'mutualFunds'): AccountView {
  return { id: 'mf', type, currency: INR, status: 'open', opening: Money.fromPaise(opening, INR), transactions: txs };
}

describe('xirr', () => {
  it('is the plain annual rate for one flow in and one out a year apart', () => {
    const r = xirr([
      { date: d('2023-01-01'), paise: -100_000 },
      { date: d('2024-01-01'), paise: 110_000 },
    ]);
    // 2023 has 365 days, so one year exactly: 10 %.
    expect(r).toBeCloseTo(0.1, 9);
  });

  it("matches Excel's documented XIRR example (0.373362535)", () => {
    // support.microsoft.com XIRR: -10,000 on 1 Jan 2008, then 2,750 / 4,250 / 3,250 / 2,750.
    const r = xirr([
      { date: d('2008-01-01'), paise: -1_000_000 },
      { date: d('2008-03-01'), paise: 275_000 },
      { date: d('2008-10-30'), paise: 425_000 },
      { date: d('2009-02-15'), paise: 325_000 },
      { date: d('2009-04-01'), paise: 275_000 },
    ]);
    expect(r).toBeCloseTo(0.373362535, 6);
  });

  it('is null when every flow has one sign', () => {
    expect(xirr([{ date: d('2023-01-01'), paise: -1 }, { date: d('2024-01-01'), paise: -1 }])).toBeNull();
  });

  it('handles a loss', () => {
    const r = xirr([
      { date: d('2023-01-01'), paise: -100_000 },
      { date: d('2024-01-01'), paise: 80_000 },
    ]);
    expect(r).toBeCloseTo(-0.2, 9);
  });

  it('recovers any rate it was built from (property)', () => {
    fc.assert(
      fc.property(fc.double({ min: -0.9, max: 3, noNaN: true }), fc.integer({ min: 366, max: 3000 }), (rate, days) => {
        const start = d('2020-01-01');
        const out = Math.round(10_000_000_000 * Math.pow(1 + rate, days / 365));
        fc.pre(out > 1_000_000); // whole paise: a tiny end value can't carry the rate to 4 places
        const r = xirr([
          { date: start, paise: -10_000_000_000 },
          { date: start.add({ days }), paise: out },
        ]);
        expect(r).not.toBeNull();
        expect(r!).toBeCloseTo(rate, 4);
      }),
    );
  });
});

describe('holdingFlows', () => {
  it('starts with the opening day value, takes transfers as flows and ends on the value', () => {
    const acct = fund(100_000, [
      mark('m0', '2023-01-01', 20_000), // same-day mark: value already there, inside the start flow
      transfer('t1', '2023-06-01', 50_000),
      mark('m1', '2024-01-01', 30_000),
    ]);
    const h = holdingFlows(acct, d('2023-01-01'), d('2024-01-01'))!;
    expect(h.flows.map((f) => [f.date.toString(), f.paise])).toEqual([
      ['2023-01-01', -120_000],
      ['2023-06-01', -50_000],
      ['2024-01-01', 200_000],
    ]);
  });

  it('never counts a mark as a cash flow', () => {
    const acct = fund(100_000, [mark('m1', '2023-06-01', 10_000), mark('m2', '2024-02-01', 5_000)]);
    const h = holdingFlows(acct, d('2023-01-01'), d('2024-02-01'))!;
    expect(h.flows).toHaveLength(2);
  });

  it('is null for a liability', () => {
    expect(holdingFlows(fund(-100_000, [], 'loan'), d('2023-01-01'), d('2024-01-01'))).toBeNull();
  });
});

describe('annualReturn', () => {
  it('is null under one year', () => {
    const acct = fund(100_000, [mark('m1', '2023-12-01', 10_000)]);
    expect(annualReturn([holdingFlows(acct, d('2023-01-01'), d('2023-12-01'))!])).toBeNull();
  });

  it('a lump sum that grew 10 % over a year returns 10 %', () => {
    const acct = fund(100_000, [mark('m1', '2024-01-01', 10_000)]);
    expect(annualReturn([holdingFlows(acct, d('2023-01-01'), d('2024-01-01'))!])).toBeCloseTo(0.1, 9);
  });

  it('two holdings merged give one rate between theirs', () => {
    const a = holdingFlows(fund(100_000, [mark('m1', '2024-01-01', 10_000)]), d('2023-01-01'), d('2024-01-01'))!;
    const b = holdingFlows(fund(100_000, [mark('m1', '2024-01-01', 30_000)]), d('2023-01-01'), d('2024-01-01'))!;
    const both = annualReturn([a, b])!;
    expect(both).toBeCloseTo(0.2, 9);
  });
});

describe('lastValueDate', () => {
  it('finds the newest mark after the start and on or before today', () => {
    const acct = fund(0, [mark('a', '2023-01-01', 1), mark('b', '2023-05-01', 1), mark('c', '2030-01-01', 1)]);
    expect(lastValueDate(acct, d('2023-01-01'), d('2024-01-01'))?.toString()).toBe('2023-05-01');
    expect(lastValueDate(acct, d('2023-05-01'), d('2024-01-01'))).toBeNull();
  });
  it('also stops at growth typed inside (interest), and at a ₹0 update; not at money moved or a loss (rule 3)', () => {
    const plain = (id: string, date: string, paise: number, countsAsReturn?: boolean) => ({
      id, accountId: 'f', date: d(date), sequence: 0, amount: Money.fromPaise(paise, 'INR'), ...(countsAsReturn === undefined ? {} : { countsAsReturn }),
    });
    const acct = fund(0, [
      plain('int', '2023-03-31', 7_000, true),
      mark('zero', '2023-06-30', 0),
      plain('fee', '2023-07-31', -500, true),
      plain('salary', '2023-08-31', 7_200, false),
      transfer('sip', '2023-09-30', 10_000),
    ]);
    expect(lastValueDate(acct, d('2023-01-01'), d('2023-05-01'))?.toString()).toBe('2023-03-31');
    expect(lastValueDate(acct, d('2023-01-01'), d('2024-01-01'))?.toString()).toBe('2023-06-30');
  });
});

describe('valueInvestedSeries', () => {
  it('value moves with marks and transfers, invested with transfers only', () => {
    const acct = fund(100_000, [transfer('t1', '2023-03-15', 50_000), mark('m1', '2023-04-10', 20_000)]);
    const s = valueInvestedSeries(acct, [d('2023-02-28'), d('2023-03-31'), d('2023-04-30')]);
    expect(s.map((p) => [p.valuePaise, p.investedPaise])).toEqual([
      [100_000, 100_000],
      [150_000, 150_000],
      [170_000, 150_000],
    ]);
  });
});
