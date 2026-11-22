/**
 * Property tests for aggregation/networth.ts — net worth and allocation
 * over generated sets of bank/credit-card accounts.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import '../src/modules/index.js';
import { parseDate } from '../src/date.js';
import { Money } from '../src/money.js';
import { balanceAsOf } from '../src/ledger.js';
import { allocationBySide, netWorth } from '../src/aggregation/networth.js';
import { rateTable } from '../src/fx.js';
import { CURRENCY, dateIsoArb, makeTx, openingArb } from './generators.js';
import { accountsArb } from './aggregation-generators.js';
import type { AccountView } from '../src/aggregation/contract.js';

const BASE_CURRENCY = CURRENCY;
/** All-base rate table (no foreign rates) — these single-currency props convert ×1. */
const BASE_RATES = rateTable(BASE_CURRENCY);

describe('networth property: netWorth = Σ currentValue over OPEN accounts', () => {
  it('matches an independent fold oracle over open accounts', () => {
    fc.assert(
      fc.property(accountsArb, dateIsoArb, (accounts, asOfIso) => {
        const asOf = parseDate(asOfIso);

        // Independent oracle: fold balanceAsOf over open accounts directly,
        // bypassing the registry/module lookup entirely.
        const oracle = accounts
          .filter((a) => a.status === 'open')
          .reduce(
            (acc, a) => acc.add(balanceAsOf(a.opening, a.transactions, asOf)),
            Money.zero(BASE_CURRENCY),
          );

        const result = netWorth(accounts, asOf, BASE_RATES).result;
        expect(result.equals(oracle)).toBe(true);
      }),
    );
  });
});

describe('networth property: matched-pair invariance (transfer-shaped arithmetic)', () => {
  it('appending a +X/-X pair of open bank accounts leaves netWorth unchanged', () => {
    fc.assert(
      fc.property(accountsArb, dateIsoArb, openingArb, (accounts, asOfIso, x) => {
        const asOf = parseDate(asOfIso);
        const before = netWorth(accounts, asOf, BASE_RATES).result;

        const plusAccount: AccountView = {
          id: 'pair-plus',
          type: 'bank',
          currency: BASE_CURRENCY,
          status: 'open',
          opening: Money.zero(BASE_CURRENCY),
          transactions: [makeTx({ id: 'pair-plus-tx', dateIso: asOfIso, sequence: 0, paise: x.paise })],
        };
        const minusAccount: AccountView = {
          id: 'pair-minus',
          type: 'bank',
          currency: BASE_CURRENCY,
          status: 'open',
          opening: Money.zero(BASE_CURRENCY),
          transactions: [
            makeTx({ id: 'pair-minus-tx', dateIso: asOfIso, sequence: 0, paise: -x.paise }),
          ],
        };

        const after = netWorth([...accounts, plusAccount, minusAccount], asOf, BASE_RATES).result;
        expect(after.equals(before)).toBe(true);
      }),
    );
  });
});

describe('networth property: closed accounts excluded', () => {
  it('appending a CLOSED account with a non-zero balance does not change netWorth', () => {
    fc.assert(
      fc.property(accountsArb, dateIsoArb, openingArb, (accounts, asOfIso, opening) => {
        const asOf = parseDate(asOfIso);
        const before = netWorth(accounts, asOf, BASE_RATES).result;

        const closedAccount: AccountView = {
          id: 'closed-nonzero',
          type: 'bank',
          currency: BASE_CURRENCY,
          status: 'closed',
          opening,
          transactions: [
            makeTx({ id: 'closed-nonzero-tx', dateIso: asOfIso, sequence: 0, paise: 12_345_00 }),
          ],
        };

        const after = netWorth([...accounts, closedAccount], asOf, BASE_RATES).result;
        expect(after.equals(before)).toBe(true);
      }),
    );
  });
});

describe('networth property: allocation reconciles with net worth', () => {
  it('allocationBySide(...).Asset + Liability === netWorth(...)', () => {
    fc.assert(
      fc.property(accountsArb, dateIsoArb, (accounts, asOfIso) => {
        const asOf = parseDate(asOfIso);
        const allocation = allocationBySide(accounts, asOf, BASE_RATES).result;
        const reconciled = allocation.Asset.add(allocation.Liability);
        const total = netWorth(accounts, asOf, BASE_RATES).result;
        expect(reconciled.equals(total)).toBe(true);
      }),
    );
  });
});
