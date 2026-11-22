/**
 * epf.ts — the Employees' Provident Fund module (launch list, S5 RD16).
 *
 * An illiquid holding asset, markable: the passbook balance is typed with Update value. Each month's
 * contribution is a row typed as income from the employer (category Salary, "Counts as return" off),
 * so it counts as money put in (the shared rule, C3); the yearly interest is typed under Interest or
 * arrives as the gap in the next Update value. Its EPS is a separate `eps` account linked to it.
 * Shared holding math — see `holdingValued.ts`.
 */
import { createHoldingValuedModule } from './holdingValued.js';
import type { InstrumentModule } from '../aggregation/contract.js';

export const epfModule: InstrumentModule = createHoldingValuedModule('epf', {
  side: 'Asset',
  liquidity: 'Illiquid',
  cardinality: 'collection',
  accountClass: 'holding',
  markable: true,
});
