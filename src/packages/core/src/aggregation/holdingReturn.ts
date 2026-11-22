/**
 * holdingReturn.ts — simple return for a holding (S2).
 *
 * Pure arithmetic over the aggregation contract: `return = currentValue −
 * costBasis` (absolute) and `pct = return ÷ costBasis`. Never stored, always
 * derived, so it can never disagree with the value/basis shown anywhere else
 * (S2 failure case: a return that doesn't reconcile with value − basis is a
 * defect). This is "total return" in the simple sense — anything that grew the
 * value beyond what was put in (market gains, reinvested interest/dividends)
 * shows as return.
 *
 * Guards the cost-basis = 0 case (a gifted/legacy holding only ever marked, no
 * contributions): percentage is UNDEFINED (`null`), shown as "—%" rather than a
 * divide-by-zero (S2 AC / edge case). Sign is honest: a holding worth less than
 * was invested returns a negative absolute and pct.
 */
import { Money } from '../money.js';
import type { AccountValuation } from './contract.js';

export interface HoldingReturn {
  /** value − costBasis, in the holding's currency. Negative when it lost money. */
  readonly amount: Money;
  /** return ÷ costBasis as a ratio (0.66 = +66%), or `null` when costBasis = 0. */
  readonly pct: number | null;
}

/**
 * Compute return + pct from a per-account valuation. `value` and `basis` must
 * share a currency (they always do — both come from the same account).
 */
export function holdingReturn(valuation: AccountValuation): HoldingReturn {
  const amount = valuation.currentValue.subtract(valuation.costBasis);
  const basis = valuation.costBasis.paise;
  return {
    amount,
    pct: basis === 0 ? null : amount.paise / basis,
  };
}
