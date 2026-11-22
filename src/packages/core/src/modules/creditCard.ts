/**
 * creditCard.ts — the Credit Card module.
 *
 * Identical valuation math to Bank (see `ledgerValued.ts`) — the only
 * difference is `side: 'Liability'`: a credit card's natural-signed ledger
 * balance is negative when money is owed, so it lowers net worth by
 * construction, with no per-type branching in aggregation. Liquid,
 * `collection` cardinality, `spending` account class, not markable.
 */
import { createLedgerValuedModule } from './ledgerValued.js';
import type { InstrumentModule } from '../aggregation/contract.js';

export const creditCardModule: InstrumentModule = createLedgerValuedModule('creditCard', {
  side: 'Liability',
  liquidity: 'Liquid',
  cardinality: 'collection',
  accountClass: 'spending',
  markable: false,
});
