/**
 * nps.ts — the National Pension System Tier I module (in the first
 * release).
 *
 * An illiquid holding asset (locked until 60, or 15 years for non-government subscribers; partial
 * withdrawals capped at a quarter of your own contributions), markable: the total from the CRA
 * statement (units × NAV across the schemes) is typed with Update value. Your own contributions are
 * transfers in from a bank; the employer's are rows filed under Salary, money put in, as with EPF.
 * Tier II has no lock-in and is its own module (`npsTier2.ts`). Shared holding math, see
 * `holdingValued.ts`.
 */
import { createHoldingValuedModule } from './holdingValued.js';
import type { InstrumentModule } from '../aggregation/contract.js';

export const npsModule: InstrumentModule = createHoldingValuedModule('nps', {
  side: 'Asset',
  liquidity: 'Illiquid',
  cardinality: 'collection',
  accountClass: 'holding',
  markable: true,
});
