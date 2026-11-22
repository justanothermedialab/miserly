/**
 * The launch-list modules (S5 RD13, 2026-11-10): PPF and SGB are registered holdings that conform
 * to the contract and value by the shared holding rule, with no rule of their own.
 */
import { describe, expect, it } from 'vitest';
import '../src/modules/index.js';
import { parseDate } from '../src/date.js';
import { Money } from '../src/money.js';
import { getModule } from '../src/aggregation/registry.js';
import { assertModuleConforms } from './conformance.js';
import type { AccountView } from '../src/aggregation/contract.js';
import type { Transaction } from '../src/transaction.js';

const INR = 'INR';
const asOf = parseDate('2026-11-10');
const row = (id: string, date: string, paise: number, extra: Partial<Transaction> = {}): Transaction => ({
  id,
  accountId: 'p1',
  date: parseDate(date),
  sequence: 0,
  amount: Money.fromPaise(paise, INR),
  ...extra,
});
const account = (type: string, opening: number, transactions: Transaction[]): AccountView => ({
  id: 'p1',
  type,
  currency: INR,
  status: 'open',
  opening: Money.fromPaise(opening, INR),
  transactions,
});

describe('launch-list modules', () => {
  it.each([
    ['ppf', 'Illiquid'],
    ['sgb', 'Semi'],
    // NPS: Tier I is locked to 60 or 15 years; Tier II has no
    // lock-in (withdrawn in about 3 days), so it is a type of its own, available soon like a fund.
    ['nps', 'Illiquid'],
    ['npsTier2', 'Semi'],
  ])('%s is a registered markable asset holding (%s)', (type, liquidity) => {
    const m = getModule(type);
    expect(m.metadata).toEqual({ side: 'Asset', liquidity, cardinality: 'collection', accountClass: 'holding', markable: true });
    assertModuleConforms(m, account(type, 100_00, [row('a', '2026-05-04', 50_00, { transferPartnerId: 'x' })]), asOf, {
      from: parseDate('2026-04-01'),
      to: parseDate('2027-03-31'),
    });
  });

  it('PPF: deposits from a bank are Invested, the 31 March interest typed inside is return', () => {
    const ppf = account('ppf', 4_10_000_00, [
      row('i', '2026-03-31', 28_700_00, { countsAsReturn: true }),
      row('d1', '2026-05-04', 75_000_00, { transferPartnerId: 'b1' }),
      row('d2', '2026-08-04', 75_000_00, { transferPartnerId: 'b2' }),
    ]);
    const m = getModule('ppf');
    expect(m.costBasis(ppf, asOf).paise).toBe(5_60_000_00);
    expect(m.currentValue(ppf, asOf).paise).toBe(5_88_700_00);
  });

  it('EPF is a markable illiquid holding; EPS is not markable (S5 RD16)', () => {
    expect(getModule('epf').metadata).toEqual({ side: 'Asset', liquidity: 'Illiquid', cardinality: 'collection', accountClass: 'holding', markable: true });
    expect(getModule('eps').metadata).toEqual({ side: 'Asset', liquidity: 'Illiquid', cardinality: 'collection', accountClass: 'holding', markable: false });
  });

  it('EPF: Salary rows are money put in, interest typed inside is return', () => {
    const epf = account('epf', 10_40_000_00 - 3 * 27_550_00, [
      row('s1', '2026-07-31', 27_550_00, { countsAsReturn: false }),
      row('s2', '2026-08-31', 27_550_00, { countsAsReturn: false }),
      row('s3', '2026-09-30', 27_550_00, { countsAsReturn: false }),
      row('i', '2026-03-31', 84_610_00, { countsAsReturn: true }),
    ]);
    expect(getModule('epf').costBasis(epf, asOf).paise).toBe(10_40_000_00);
    expect(getModule('epf').currentValue(epf, asOf).paise).toBe(11_24_610_00);
  });

  it('EPS: counted at what was paid in, so value equals Invested and its return is nil', () => {
    const eps = account('eps', 1_44_107_00, [
      row('p1', '2026-07-31', 1_250_00, { countsAsReturn: false }),
      row('p2', '2026-10-31', 2_083_00, { countsAsReturn: false }),
    ]);
    const m = getModule('eps');
    expect(m.currentValue(eps, asOf).paise).toBe(1_47_440_00);
    expect(m.costBasis(eps, asOf).paise).toBe(1_47_440_00);
  });

  it("NPS: the employer's Salary rows and transfers from a bank are Invested; a statement's value update moves value only", () => {
    const nps = account('nps', 2_00_000_00, [
      row('e', '2026-07-31', 8_400_00, { countsAsReturn: false }), // the employer pays straight in
      row('t', '2026-08-05', 50_000_00, { transferPartnerId: 'b1' }), // your own, from a bank
      row('m', '2026-10-31', 31_600_00, { kind: 'valuationMark' }),
    ]);
    const m = getModule('nps');
    expect(m.costBasis(nps, asOf).paise).toBe(2_58_400_00);
    expect(m.currentValue(nps, asOf).paise).toBe(2_90_000_00);
  });

  it('SGB: a gold-price update moves value only', () => {
    const sgb = account('sgb', 1_23_980_00, [row('m', '2026-09-30', 1_25_273_00, { kind: 'valuationMark' })]);
    const m = getModule('sgb');
    expect(m.costBasis(sgb, asOf).paise).toBe(1_23_980_00);
    expect(m.currentValue(sgb, asOf).paise).toBe(2_49_253_00);
  });
});
