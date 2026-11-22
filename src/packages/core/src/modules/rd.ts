/**
 * rd.ts — the Recurring Deposit module.
 *
 * A semi-liquid holding asset, markable. Monthly installment, rate and maturity
 * date are DISPLAY-ONLY (S5) — installment accrual / maturity auto-value are v2.
 * Shared holding math — see `holdingValued.ts`.
 */
import { createHoldingValuedModule } from './holdingValued.js';
import type { InstrumentModule } from '../aggregation/contract.js';

export const rdModule: InstrumentModule = createHoldingValuedModule('rd', {
  side: 'Asset',
  liquidity: 'Semi',
  cardinality: 'collection',
  accountClass: 'holding',
  markable: true,
});
