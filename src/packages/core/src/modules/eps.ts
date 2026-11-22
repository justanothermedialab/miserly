/**
 * eps.ts — the Employees' Pension Scheme module, an EPF's EPS ("it is still your
 * money, even if inaccessible till retirement", counted at what was paid in; S5 RD16).
 *
 * An illiquid holding asset that is NOT markable: EPFO shows no balance for EPS (it becomes a
 * pension after 10 years' service, before that a withdrawal benefit by a table), so there is no
 * value to type. Its rows are the employer's pension contributions under Salary, money put in by
 * the shared rule, so value = Invested = what was paid in and its return is nil. No rule of its own.
 */
import { createHoldingValuedModule } from './holdingValued.js';
import type { InstrumentModule } from '../aggregation/contract.js';

export const epsModule: InstrumentModule = createHoldingValuedModule('eps', {
  side: 'Asset',
  liquidity: 'Illiquid',
  cardinality: 'collection',
  accountClass: 'holding',
  markable: false,
});
