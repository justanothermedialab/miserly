/**
 * Shared fast-check generators for aggregation (net worth / allocation)
 * property tests. Builds `AccountView`s on top of the M1 ledger generators
 * (`generators.ts`), restricted to the two M2 module types.
 */
import fc from 'fast-check';
import type { AccountStatus, AccountView } from '../src/aggregation/contract.js';
import type { Transaction } from '../src/transaction.js';
import { CURRENCY, dateIsoArb, makeTx, openingArb, paiseArb } from './generators.js';

/** The two module types registered in M2. */
export const MODULE_TYPES = ['bank', 'creditCard'] as const;

export const moduleTypeArb = fc.constantFrom<(typeof MODULE_TYPES)[number]>(...MODULE_TYPES);

export const statusArb: fc.Arbitrary<AccountStatus> = fc.constantFrom('open', 'closed');

/**
 * Transactions for one generated account: unique ids scoped to
 * `accountIndex`, with monotonically-assigned per-date sequences (same
 * same-date-collision shape as `transactionsArb` in `generators.ts`).
 */
function accountTransactionsArb(accountIndex: number): fc.Arbitrary<Transaction[]> {
  return fc
    .array(fc.record({ dateIso: dateIsoArb, paise: paiseArb }), { minLength: 0, maxLength: 10 })
    .map((entries) => {
      const seqByDate = new Map<string, number>();
      return entries.map((entry, i) => {
        const seq = seqByDate.get(entry.dateIso) ?? 0;
        seqByDate.set(entry.dateIso, seq + 1);
        return makeTx({
          id: `acc-${accountIndex}-tx-${i}`,
          dateIso: entry.dateIso,
          sequence: seq,
          paise: entry.paise,
        });
      });
    });
}

/**
 * An array of `AccountView`s with unique ids (`acc-0`, `acc-1`, …), random
 * `type` (bank | creditCard), random `status`, random `opening`, and
 * per-account random transactions. Currency is fixed to `CURRENCY` ('INR')
 * so `Money.add` never throws on a currency mismatch within the generated
 * set (cross-currency is a LATER milestone, M9).
 */
export const accountsArb: fc.Arbitrary<AccountView[]> = fc
  .array(fc.tuple(moduleTypeArb, statusArb, openingArb), { minLength: 0, maxLength: 15 })
  .chain((specs) =>
    fc.tuple(...specs.map((_, i) => accountTransactionsArb(i))).map((allTxs) =>
      specs.map(([type, status, opening], i) => ({
        id: `acc-${i}`,
        type,
        currency: CURRENCY,
        status,
        opening,
        transactions: allTxs[i]!,
      })),
    ),
  );
