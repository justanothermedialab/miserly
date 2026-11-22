/**
 * bank.ts — the Bank module.
 *
 * A liquid asset, cardinality `collection` (a user can have many bank
 * accounts), part of the `spending` account class (feeds cashflow/spending
 * analytics), and not markable (valuation marks are for holdings whose
 * value can drift from its ledger, which a bank account's cannot). All
 * valuation math is the shared ledger-valued computation — see
 * `ledgerValued.ts`.
 */
import { createLedgerValuedModule } from './ledgerValued.js';
import type { InstrumentModule } from '../aggregation/contract.js';

export const bankModule: InstrumentModule = createLedgerValuedModule('bank', {
  side: 'Asset',
  liquidity: 'Liquid',
  cardinality: 'collection',
  accountClass: 'spending',
  markable: false,
});
