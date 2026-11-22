/**
 * stocks.ts — the Stocks / Brokerage module.
 *
 * A semi-liquid holding asset, markable, reporting cost basis / return. Not cash:
 * shares have to be sold and settled before the money can be spent, so they sit
 * with mutual funds, not in "available now" ("i cant buy a can
 * of pepsi with stocks"). Manual marks in MVP; units × price + price lookup are v2
 * (S5). Shared holding math — see `holdingValued.ts`.
 */
import { createHoldingValuedModule } from './holdingValued.js';
import type { InstrumentModule } from '../aggregation/contract.js';

export const stocksModule: InstrumentModule = createHoldingValuedModule('stocks', {
  side: 'Asset',
  liquidity: 'Semi',
  cardinality: 'collection',
  accountClass: 'holding',
  markable: true,
});
