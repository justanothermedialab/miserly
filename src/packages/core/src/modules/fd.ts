/**
 * fd.ts — the Fixed Deposit module.
 *
 * A semi-liquid holding asset (breakable, with a penalty), markable. Rate,
 * maturity date and cumulative/payout are DISPLAY-ONLY informational fields
 * (S5) — no interest accrual or maturity auto-value in MVP (v2). Shared holding
 * math — see `holdingValued.ts`.
 */
import { createHoldingValuedModule } from './holdingValued.js';
import type { InstrumentModule } from '../aggregation/contract.js';

export const fdModule: InstrumentModule = createHoldingValuedModule('fd', {
  side: 'Asset',
  liquidity: 'Semi',
  cardinality: 'collection',
  accountClass: 'holding',
  markable: true,
});
