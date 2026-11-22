/**
 * Tests for the holding valuation model (S2): cost basis = opening + Σ transfer
 * legs (marks excluded); current value = opening + Σall; return = value − basis.
 *
 * The keystone distinction — a CONTRIBUTION (transfer leg, has transferPartnerId)
 * moves cost basis AND value; a MARK (non-transfer) moves value ONLY — is what
 * makes returns correct with zero intelligence. These tests pin exactly that.
 */
import { describe, expect, it } from 'vitest';
import '../src/modules/index.js';
import { parseDate } from '../src/date.js';
import { Money } from '../src/money.js';
import { getModule } from '../src/aggregation/registry.js';
import { valuationOf } from '../src/aggregation/networth.js';
import { holdingReturn } from '../src/aggregation/holdingReturn.js';
import type { AccountView } from '../src/aggregation/contract.js';
import type { Transaction } from '../src/transaction.js';

const INR = 'INR';
const asOf = parseDate('2024-12-31');

/** A contribution/withdrawal leg (transfer). */
function contrib(id: string, date: string, paise: number): Transaction {
  return {
    id,
    accountId: 'h1',
    date: parseDate(date),
    sequence: 0,
    amount: Money.fromPaise(paise, INR),
    transferPartnerId: `${id}-partner`,
  };
}

/** A valuation mark (non-transfer adjustment). */
function mark(id: string, date: string, paise: number): Transaction {
  return {
    id,
    accountId: 'h1',
    date: parseDate(date),
    sequence: 1,
    amount: Money.fromPaise(paise, INR),
    kind: 'valuationMark',
  };
}

function holding(opening: number, txs: Transaction[]): AccountView {
  return {
    id: 'h1',
    type: 'mutualFunds',
    currency: INR,
    status: 'open',
    opening: Money.fromPaise(opening, INR),
    transactions: txs,
  };
}

describe('holdingValued cost basis', () => {
  it('a contribution moves BOTH value and cost basis', () => {
    const acc = holding(0, [contrib('c1', '2024-01-01', 1000000)]);
    const v = valuationOf(acc, asOf);
    expect(v.currentValue.paise).toBe(1000000);
    expect(v.costBasis.paise).toBe(1000000);
    expect(holdingReturn(v).amount.paise).toBe(0);
  });

  it('a mark moves value ONLY, never cost basis (unrealized gain)', () => {
    const acc = holding(0, [
      contrib('c1', '2024-01-01', 1000000),
      mark('m1', '2024-06-01', 150000), // now worth 11,500
    ]);
    const v = valuationOf(acc, asOf);
    expect(v.currentValue.paise).toBe(1150000);
    expect(v.costBasis.paise).toBe(1000000);
    const r = holdingReturn(v);
    expect(r.amount.paise).toBe(150000);
    expect(r.pct).toBeCloseTo(0.15, 10);
  });

  it('opening is the onboarded invested (initial cost basis)', () => {
    // Onboard: invested 300000, marked up to 500000.
    const acc = holding(300000, [mark('m1', '2024-01-01', 200000)]);
    const v = valuationOf(acc, asOf);
    expect(v.currentValue.paise).toBe(500000);
    expect(v.costBasis.paise).toBe(300000);
    expect(holdingReturn(v).pct).toBeCloseTo(200000 / 300000, 10);
  });

  it('a withdrawal reduces value and cost basis (net-contributions)', () => {
    const acc = holding(0, [
      contrib('c1', '2024-01-01', 1000000),
      contrib('w1', '2024-03-01', -500000),
    ]);
    const v = valuationOf(acc, asOf);
    expect(v.currentValue.paise).toBe(500000);
    expect(v.costBasis.paise).toBe(500000);
  });

  it('a withdrawal takes out its share of value from cost basis (S2 RD3/RD5 amended, the red team\'s rule 1)', () => {
    const acc = holding(0, [
      contrib('c1', '2024-01-01', 1000000),
      mark('m1', '2024-02-01', 1000000), // gained: value now 2,000,000
      contrib('w1', '2024-03-01', -1500000), // sold 75 % of the value, more than was put in
    ]);
    const v = valuationOf(acc, asOf);
    expect(v.currentValue.paise).toBe(500000); // real remaining value
    expect(v.costBasis.paise).toBe(250000); // the cost of the 25 % still held (it was floored at 0)
  });

  it('respects asOf: a future contribution/mark is excluded from both', () => {
    const acc = holding(0, [
      contrib('c1', '2024-01-01', 1000000),
      mark('m1', '2025-06-01', 999999), // after asOf
    ]);
    const v = valuationOf(acc, parseDate('2024-12-31'));
    expect(v.currentValue.paise).toBe(1000000);
    expect(v.costBasis.paise).toBe(1000000);
  });

  it('return pct is null (not a divide-by-zero) when cost basis is 0', () => {
    const acc = holding(0, [mark('m1', '2024-01-01', 500000)]); // gifted, only marked
    const v = valuationOf(acc, asOf);
    expect(v.costBasis.paise).toBe(0);
    expect(holdingReturn(v).pct).toBeNull();
    expect(holdingReturn(v).amount.paise).toBe(500000);
  });

  it('cashFlows fold transfer legs only, marks excluded', () => {
    const mod = getModule('mutualFunds');
    const acc = holding(0, [
      contrib('c1', '2024-02-01', 1000000),
      mark('m1', '2024-02-15', 300000),
      contrib('w1', '2024-02-20', -400000),
    ]);
    const cf = mod.cashFlows(acc, { from: parseDate('2024-02-01'), to: parseDate('2024-02-28') });
    expect(cf.inflow.paise).toBe(1000000);
    expect(cf.outflow.paise).toBe(400000); // the mark's 300000 is NOT a cash flow
  });
});
