/**
 * gold.ts — the Gold module (one module + a sub-type field, S5 RD4).
 *
 * A semi-liquid holding asset, markable. Sub-type (ETF / digital / physical /
 * SGB) and SGB maturity are DISPLAY-ONLY informational fields (S5) — live 24K
 * price and SGB ~2.5% interest auto are v2; in MVP the ~2.5% is recorded by the
 * user as a credit (return). Shared holding math — see `holdingValued.ts`.
 */
import { createHoldingValuedModule } from './holdingValued.js';
import type { InstrumentModule } from '../aggregation/contract.js';

export const goldModule: InstrumentModule = createHoldingValuedModule('gold', {
  side: 'Asset',
  liquidity: 'Semi',
  cardinality: 'collection',
  accountClass: 'holding',
  markable: true,
});
