/**
 * mutualFunds.ts — the Mutual Funds module.
 *
 * A semi-liquid holding asset: value can drift from cost (market movement), so
 * it is markable (S3) and reports cost basis / return (S2). Valuation is manual
 * marks in MVP — units × NAV and NAV lookup are v2 behind the same
 * `currentValue()` contract (S5). All math is the shared holding computation —
 * see `holdingValued.ts`.
 */
import { createHoldingValuedModule } from './holdingValued.js';
import type { InstrumentModule } from '../aggregation/contract.js';

export const mutualFundsModule: InstrumentModule = createHoldingValuedModule('mutualFunds', {
  side: 'Asset',
  liquidity: 'Semi',
  cardinality: 'collection',
  accountClass: 'holding',
  markable: true,
});
