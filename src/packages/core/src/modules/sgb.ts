/**
 * sgb.ts — the Sovereign Gold Bond module (its own type for launch, S5 RD4
 * amended, RD13).
 *
 * A semi-liquid holding asset (exchange-traded; early exit from the 5th anniversary), markable: its
 * value follows the gold price and is typed with Update value. The 2.5 % interest is paid into a
 * bank account (RBI), so it is typed there and never touches this account. Grams, prices and the
 * issue date are DISPLAY-ONLY details. Shared holding math — see `holdingValued.ts`.
 */
import { createHoldingValuedModule } from './holdingValued.js';
import type { InstrumentModule } from '../aggregation/contract.js';

export const sgbModule: InstrumentModule = createHoldingValuedModule('sgb', {
  side: 'Asset',
  liquidity: 'Semi',
  cardinality: 'collection',
  accountClass: 'holding',
  markable: true,
});
