/**
 * npsTier2.ts — the National Pension System Tier II module (Tier I and Tier II
 * are separate accounts in one NPS section).
 *
 * Tier II has no lock-in: a withdrawal reaches the bank in about 3 working days, so it is Semi
 * ("available soon"), as a fund is, where Tier I (`nps.ts`) is Illiquid. Markable: the value is
 * typed from the CRA statement. Shared holding math, see `holdingValued.ts`.
 */
import { createHoldingValuedModule } from './holdingValued.js';
import type { InstrumentModule } from '../aggregation/contract.js';

export const npsTier2Module: InstrumentModule = createHoldingValuedModule('npsTier2', {
  side: 'Asset',
  liquidity: 'Semi',
  cardinality: 'collection',
  accountClass: 'holding',
  markable: true,
});
