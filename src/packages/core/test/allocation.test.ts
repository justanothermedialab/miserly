/**
 * Tests for allocationByClass / allocationByLiquidity (D2).
 *
 * Uses the real v1 module set (barrel-registered): Bank (Liquid Asset), Gold
 * (Semi Asset), Property (Illiquid Asset), Stocks (Semi Asset) and Credit Card
 * (Liability) — enough distinct asset classes/liquidity bands to exercise the
 * bucketing without registering throwaway modules.
 */
import { describe, expect, it } from 'vitest';
import '../src/modules/index.js';
import { parseDate } from '../src/date.js';
import { Money } from '../src/money.js';
import {
  allocationByClass,
  allocationByLiquidity,
  allocationBySide,
} from '../src/aggregation/networth.js';
import { rateTable } from '../src/fx.js';
import type { AccountView } from '../src/aggregation/contract.js';
import type { Transaction } from '../src/transaction.js';

const INR = 'INR';
/** All-INR base table (no foreign rates) — every value converts ×1. */
const INR_RATES = rateTable(INR);
const asOf = parseDate('2024-01-15');

function acct(
  id: string,
  type: string,
  status: 'open' | 'closed',
  amountPaise: number,
): AccountView {
  const tx: Transaction = {
    id: `${id}-tx`,
    accountId: id,
    date: parseDate('2024-01-02'),
    sequence: 0,
    amount: Money.fromPaise(amountPaise, INR),
  };
  return { id, type, currency: INR, status, opening: Money.zero(INR), transactions: [tx] };
}

describe('allocationByClass', () => {
  it('buckets assets by module type and excludes liabilities from the pie', () => {
    const accounts = [
      acct('b1', 'bank', 'open', 100000),
      acct('b2', 'bank', 'open', 50000),
      acct('s1', 'stocks', 'open', 200000),
      acct('cc', 'creditCard', 'open', -30000), // liability: never a slice
    ];
    const byClass = allocationByClass(accounts, asOf, INR_RATES).result;
    expect(byClass.get('bank')?.paise).toBe(150000);
    expect(byClass.get('stocks')?.paise).toBe(200000);
    expect(byClass.has('creditCard')).toBe(false);
  });

  it('an overdrawn asset account nets within its own class (D2 RD5)', () => {
    const accounts = [acct('b1', 'bank', 'open', 100000), acct('b2', 'bank', 'open', -40000)];
    expect(allocationByClass(accounts, asOf, INR_RATES).result.get('bank')?.paise).toBe(60000);
  });

  it('excludes closed accounts (as-of-today, open-only)', () => {
    const accounts = [acct('b1', 'bank', 'open', 100000), acct('s1', 'stocks', 'closed', 200000)];
    const byClass = allocationByClass(accounts, asOf, INR_RATES).result;
    expect(byClass.get('bank')?.paise).toBe(100000);
    expect(byClass.has('stocks')).toBe(false);
  });

  it('Σ class buckets reconciles to allocationBySide(...).Asset (the pie can never disagree with the hero)', () => {
    const accounts = [
      acct('b1', 'bank', 'open', 100000),
      acct('s1', 'stocks', 'open', 200000),
      acct('g1', 'gold', 'open', 75000),
      acct('cc', 'creditCard', 'open', -30000),
    ];
    const sumOfSlices = [...allocationByClass(accounts, asOf, INR_RATES).result.values()].reduce(
      (acc, m) => acc.add(m),
      Money.zero(INR),
    );
    expect(sumOfSlices.paise).toBe(allocationBySide(accounts, asOf, INR_RATES).result.Asset.paise);
  });
});

describe('allocationByLiquidity', () => {
  it('buckets assets by liquidity band', () => {
    const accounts = [
      acct('b1', 'bank', 'open', 100000), // Liquid
      acct('g1', 'gold', 'open', 75000), // Semi
      acct('p1', 'property', 'open', 200000), // Illiquid
      acct('cc', 'creditCard', 'open', -30000), // liability excluded
    ];
    const byLiq = allocationByLiquidity(accounts, asOf, INR_RATES).result;
    expect(byLiq.get('Liquid')?.paise).toBe(100000);
    expect(byLiq.get('Semi')?.paise).toBe(75000);
    expect(byLiq.get('Illiquid')?.paise).toBe(200000);
    // liquid % of total assets = 100000 / 375000
    const totalAssets = [...byLiq.values()].reduce((a, m) => a.add(m), Money.zero(INR)).paise;
    expect(totalAssets).toBe(375000);
  });

  it('empty when there are no asset accounts', () => {
    const accounts = [acct('cc', 'creditCard', 'open', -30000)];
    expect(allocationByLiquidity(accounts, asOf, INR_RATES).result.size).toBe(0);
  });
});
