/**
 * property.ts — the Property module.
 *
 * An illiquid holding asset (counts toward net worth, not readily converted),
 * markable — the user re-marks its value periodically (S3). Purchase cost is the
 * invested/cost basis; address/note is display-only (S5). Linked-loan net equity
 * is S4 (build deferred). Shared holding math — see `holdingValued.ts`.
 */
import { createHoldingValuedModule } from './holdingValued.js';
import type { InstrumentModule } from '../aggregation/contract.js';

export const propertyModule: InstrumentModule = createHoldingValuedModule('property', {
  side: 'Asset',
  liquidity: 'Illiquid',
  cardinality: 'collection',
  accountClass: 'holding',
  markable: true,
});
