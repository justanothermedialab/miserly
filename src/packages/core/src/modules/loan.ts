/**
 * loan.ts — the Loans module (home / car / personal / gold-loan / LAS).
 *
 * A holding LIABILITY: its natural-signed `currentValue` is negative (money
 * owed), so it lowers net worth by construction with no per-side branching. It
 * is markable — the user marks the real OUTSTANDING (which includes accrued
 * interest and rarely equals opening − payments, S3 RD2); payments are C3
 * transfers from a bank. Original principal, rate and secured-vs-unsecured are
 * display-only (S5); the S4 linked-asset net-equity view is deferred. Shared
 * holding math — see `holdingValued.ts`.
 */
import { createHoldingValuedModule } from './holdingValued.js';
import type { InstrumentModule } from '../aggregation/contract.js';

export const loanModule: InstrumentModule = createHoldingValuedModule('loan', {
  side: 'Liability',
  liquidity: 'Illiquid',
  cardinality: 'collection',
  accountClass: 'holding',
  markable: true,
});
