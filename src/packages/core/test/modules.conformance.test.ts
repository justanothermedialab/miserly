/**
 * Conformance + ledger-specific reconciliation tests for the Bank and
 * Credit Card modules. The universal checks (in `conformance.ts`) prove
 * each module satisfies the shape of the contract; the reconciliation
 * checks here are the drift/`if module===`/insert-order catcher — they
 * prove the module's `currentValue` is EXACTLY `balanceAsOf`, including
 * under a back-dated insert and a same-date reorder.
 */
import { describe, expect, it } from 'vitest';
import '../src/modules/index.js';
import { parseDate } from '../src/date.js';
import { Money } from '../src/money.js';
import { balanceAsOf } from '../src/ledger.js';
import { bankModule } from '../src/modules/bank.js';
import { creditCardModule } from '../src/modules/creditCard.js';
import { assertModuleConforms } from './conformance.js';
import type { AccountView, InstrumentModule, Period } from '../src/aggregation/contract.js';
import type { Transaction } from '../src/transaction.js';

const INR = 'INR';

function tx(id: string, dateIso: string, sequence: number, amountPaise: number): Transaction {
  return {
    id,
    accountId: 'acc-1',
    date: parseDate(dateIso),
    sequence,
    amount: Money.fromPaise(amountPaise, INR),
  };
}

function makeAccount(type: string, transactions: Transaction[]): AccountView {
  return {
    id: 'acc-1',
    type,
    currency: INR,
    status: 'open',
    opening: Money.fromPaise(1000_00, INR),
    transactions,
  };
}

const asOf = parseDate('2024-01-15');
const period: Period = { from: parseDate('2024-01-01'), to: parseDate('2024-01-31') };

// Mixed +/- txs, including one future-dated relative to `asOf`.
const sampleTxs: Transaction[] = [
  tx('a', '2024-01-02', 0, 50_00),
  tx('b', '2024-01-05', 0, -20_00),
  tx('c', '2024-02-01', 0, 999_00), // future-dated relative to asOf
];

describe.each<{ name: string; module: InstrumentModule }>([
  { name: 'bank', module: bankModule },
  { name: 'creditCard', module: creditCardModule },
])('$name module: universal conformance', ({ module }) => {
  it('conforms to the aggregation contract', () => {
    const account = makeAccount(module.type, sampleTxs);
    assertModuleConforms(module, account, asOf, period);
  });
});

describe.each<{ name: string; module: InstrumentModule }>([
  { name: 'bank', module: bankModule },
  { name: 'creditCard', module: creditCardModule },
])('$name module: ledger reconciliation', ({ module }) => {
  it('currentValue exactly equals balanceAsOf', () => {
    const account = makeAccount(module.type, sampleTxs);
    const expected = balanceAsOf(account.opening, account.transactions, asOf);
    expect(module.currentValue(account, asOf).equals(expected)).toBe(true);
  });

  it('costBasis equals currentValue (cash has no unrealized gain)', () => {
    const account = makeAccount(module.type, sampleTxs);
    expect(module.costBasis(account, asOf).equals(module.currentValue(account, asOf))).toBe(true);
  });

  it('reconciles under a back-dated insert', () => {
    const original = makeAccount(module.type, [
      tx('x', '2024-01-02', 0, 50_00),
      tx('y', '2024-01-03', 0, -20_00),
    ]);
    const backdated = tx('z', '2024-01-01', 0, 100_00);
    const withBackdated = makeAccount(module.type, [...original.transactions, backdated]);

    const expected = balanceAsOf(withBackdated.opening, withBackdated.transactions, asOf);
    expect(module.currentValue(withBackdated, asOf).equals(expected)).toBe(true);
  });

  it('reconciles under a same-date reorder', () => {
    const orderingA = makeAccount(module.type, [
      tx('p', '2024-01-10', 0, 300_00),
      tx('q', '2024-01-10', 1, -100_00),
    ]);
    const orderingB = makeAccount(module.type, [
      tx('q', '2024-01-10', 0, -100_00),
      tx('p', '2024-01-10', 1, 300_00),
    ]);

    const expectedA = balanceAsOf(orderingA.opening, orderingA.transactions, asOf);
    const expectedB = balanceAsOf(orderingB.opening, orderingB.transactions, asOf);

    expect(module.currentValue(orderingA, asOf).equals(expectedA)).toBe(true);
    expect(module.currentValue(orderingB, asOf).equals(expectedB)).toBe(true);
    expect(expectedA.equals(expectedB)).toBe(true);
  });

  it('cashFlows: exact inflow/outflow magnitudes, out-of-period txs excluded', () => {
    const account = makeAccount(module.type, [
      tx('in1', '2024-01-05', 0, 200_00), // in period
      tx('out1', '2024-01-10', 0, -75_00), // in period
      tx('in2', '2023-12-31', 0, 500_00), // before period
      tx('out2', '2024-02-01', 0, -10_00), // after period
      tx('zero', '2024-01-15', 0, 0), // zero, in period, contributes to neither
      tx('edgeFrom', '2024-01-01', 0, 10_00), // exactly period.from, inclusive
      tx('edgeTo', '2024-01-31', 0, -10_00), // exactly period.to, inclusive
    ]);

    const flows = module.cashFlows(account, period);
    expect(flows.inflow.paise).toBe(200_00 + 10_00);
    expect(flows.outflow.paise).toBe(75_00 + 10_00);
  });
});
