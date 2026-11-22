/**
 * ppf.ts — the Public Provident Fund module (undeferred for launch, S5 RD13).
 *
 * An illiquid holding asset (15 years, partial withdrawal only from year 7), markable: the
 * passbook balance is typed with Update value. Deposits are transfers in from a bank (Invested);
 * the interest the bank credits on 31 March is typed as a row (return) or arrives as the gap in the
 * next Update value. The opening date ("Opened on") and the yearly ₹1.5 lakh are DISPLAY-ONLY
 * details (the app shows dates and sums worked out from them, never an interest figure). Shared
 * holding math — see `holdingValued.ts`.
 */
import { createHoldingValuedModule } from './holdingValued.js';
import type { InstrumentModule } from '../aggregation/contract.js';

export const ppfModule: InstrumentModule = createHoldingValuedModule('ppf', {
  side: 'Asset',
  liquidity: 'Illiquid',
  cardinality: 'collection',
  accountClass: 'holding',
  markable: true,
});
