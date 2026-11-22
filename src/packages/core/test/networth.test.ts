/**
 * Example-based (hand-worked) tests for aggregation/networth.ts.
 */
import { describe, expect, it } from 'vitest';
import '../src/modules/index.js';
import { parseDate } from '../src/date.js';
import { Money } from '../src/money.js';
import { netWorth, allocationBySide } from '../src/aggregation/networth.js';
import { rateTable } from '../src/fx.js';
import type { AccountView } from '../src/aggregation/contract.js';
import type { Transaction } from '../src/transaction.js';

const INR = 'INR';
/** All-INR base table (no foreign rates) — every value converts ×1. */
const INR_RATES = rateTable(INR);
const asOf = parseDate('2024-01-15');

function tx(id: string, dateIso: string, amountPaise: number): Transaction {
  return {
    id,
    accountId: 'acc',
    date: parseDate(dateIso),
    sequence: 0,
    amount: Money.fromPaise(amountPaise, INR),
  };
}

function bankAccount(id: string, status: 'open' | 'closed', amountPaise: number): AccountView {
  return {
    id,
    type: 'bank',
    currency: INR,
    status,
    opening: Money.zero(INR),
    transactions: [tx(`${id}-tx`, '2024-01-02', amountPaise)],
  };
}

function creditCardAccount(id: string, status: 'open' | 'closed', amountPaise: number): AccountView {
  return {
    id,
    type: 'creditCard',
    currency: INR,
    status,
    opening: Money.zero(INR),
    transactions: [tx(`${id}-tx`, '2024-01-02', amountPaise)],
  };
}

describe('netWorth: hand-worked example', () => {
  it('bank +1000 and credit card -300 net to 700', () => {
    const accounts = [bankAccount('bank-1', 'open', 100000), creditCardAccount('cc-1', 'open', -30000)];
    expect(netWorth(accounts, asOf, INR_RATES).result.paise).toBe(70000);
  });

  it('allocationBySide separates Asset (1000) and Liability (-300)', () => {
    const accounts = [bankAccount('bank-1', 'open', 100000), creditCardAccount('cc-1', 'open', -30000)];
    const allocation = allocationBySide(accounts, asOf, INR_RATES).result;
    expect(allocation.Asset.paise).toBe(100000);
    expect(allocation.Liability.paise).toBe(-30000);
  });

  it('a credit card debt LOWERS net worth, with zero type-branching in the caller', () => {
    const withoutDebt = netWorth([bankAccount('bank-1', 'open', 100000)], asOf, INR_RATES).result;
    const withDebt = netWorth(
      [bankAccount('bank-1', 'open', 100000), creditCardAccount('cc-1', 'open', -30000)],
      asOf,
      INR_RATES,
    ).result;
    expect(withDebt.paise).toBeLessThan(withoutDebt.paise);
    expect(withDebt.paise).toBe(withoutDebt.paise - 30000);
  });

  it('a closed credit card is excluded from net worth', () => {
    const accounts = [bankAccount('bank-1', 'open', 100000), creditCardAccount('cc-1', 'closed', -30000)];
    expect(netWorth(accounts, asOf, INR_RATES).result.paise).toBe(100000);
  });

  it('an empty account set has zero net worth', () => {
    expect(netWorth([], asOf, INR_RATES).result.paise).toBe(0);
  });
});
