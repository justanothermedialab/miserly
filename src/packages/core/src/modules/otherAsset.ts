/**
 * otherAsset.ts — the Other-asset catch-all module (S5 RD2).
 *
 * A markable holding asset so nothing is un-trackable: anything without a type of its own (crypto,
 * ESOPs, bonds, a ULIP at its fund value). Illiquid (S5 RD6: "counts but not
 * accessible yet"). PPF, EPF and NPS, once held here, have types of their own. Shared holding
 * math — see `holdingValued.ts`.
 */
import { createHoldingValuedModule } from './holdingValued.js';
import type { InstrumentModule } from '../aggregation/contract.js';

export const otherAssetModule: InstrumentModule = createHoldingValuedModule('otherAsset', {
  side: 'Asset',
  liquidity: 'Illiquid',
  cardinality: 'collection',
  accountClass: 'holding',
  markable: true,
});
