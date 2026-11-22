/**
 * otherLiability.ts — the Other-liability catch-all module (S5 RD2).
 *
 * A markable holding liability for any debt without a dedicated profile. Its
 * natural-signed `currentValue` is negative (owed), lowering net worth with no
 * per-side branching. Shared holding math — see `holdingValued.ts`.
 */
import { createHoldingValuedModule } from './holdingValued.js';
import type { InstrumentModule } from '../aggregation/contract.js';

export const otherLiabilityModule: InstrumentModule = createHoldingValuedModule('otherLiability', {
  side: 'Liability',
  liquidity: 'Illiquid',
  cardinality: 'collection',
  accountClass: 'holding',
  markable: true,
});
