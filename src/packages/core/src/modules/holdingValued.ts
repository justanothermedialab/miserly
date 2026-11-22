/**
 * holdingValued.ts — shared factory for "holding" (investment-like) modules.
 *
 * Mutual Funds, Stocks, FD, RD, Property, Gold, Loans, Other-asset and
 * Other-liability are all, at the domain-math level, the same thing: a signed
 * running ledger whose value can DRIFT from the cash put into it (market
 * movement, accrued interest, a loan's growing outstanding). Two numbers matter
 * for every holding (S2):
 *
 *   - current value = `opening + Σtx` — the usual derived balance, identical to
 *     every other account (single source of truth). It moves with contributions,
 *     withdrawals AND valuation marks.
 *   - cost basis   = the cash the user committed to what is still held: money put in
 *     adds, money taken out lowers it by its share of the value (average cost, the
 *     red team's rule 1). Money moved is a TRANSFER LEG (it has a
 *     `transferPartnerId`, C3) or a plain row whose category isn't return (C3 A); a
 *     VALUATION MARK (S3) and other growth rows move value ONLY, never cost basis.
 *     That moved-vs-growth distinction is the whole mechanism that makes returns
 *     correct with zero intelligence (S2 business context).
 *
 * return = value − cost basis is pure arithmetic and lives in `holdingReturn.ts`.
 *
 * The ONLY thing that distinguishes one holding module from another is
 * `ModuleMetadata` (side/liquidity/…), exactly as `ledgerValued.ts` does it for
 * the cash-like modules — so the 9-module v1 holding set is 9 thin declarations
 * over this one factory, with zero `if module===` branching anywhere.
 *
 * The `opening` balance is treated as the holding's initial contribution (the
 * onboarding "amount invested", S2 RD1), so a freshly onboarded holding with no
 * transactions already reports cost basis = value = opening (0% return). An
 * initial invested→value gap is recorded as an initial valuation mark, which —
 * being a non-transfer row — lifts value above cost basis exactly as a real gain.
 */
import { balanceAsOf } from '../ledger.js';
import { sortTransactions } from '../ordering.js';
import { compareDates } from '../date.js';
import { Money } from '../money.js';
import type {
  AccountView,
  CashFlows,
  InstrumentModule,
  ModuleMetadata,
  Period,
} from '../aggregation/contract.js';
import type { PlainDate } from '../date.js';
import type { Transaction } from '../transaction.js';

/** A transfer leg (contribution/withdrawal) — carries a partner id (C3). A
 *  valuation mark or any other adjustment does NOT, so it is excluded from cost
 *  basis and from cash flows (a mark is not a cash flow — S3). */
function isTransferLeg(tx: Transaction): boolean {
  return tx.transferPartnerId !== undefined && tx.transferPartnerId !== null;
}

/**
 * Money moved into or out of the holding (C3 A): every transfer leg, and a plain
 * row whose category says it is not return (`countsAsReturn === false`: EPF's Salary typed inside
 * the EPF). A valuation mark never is; an uncategorised plain row (no flag) stays growth, as before.
 * These are the investor's cash flows (return per year reads them).
 */
function isMoneyMoved(tx: Transaction): boolean {
  if (tx.kind === 'valuationMark') return false;
  return isTransferLeg(tx) || tx.countsAsReturn === false;
}

/**
 * Money moved that changes Invested: all of the above but a payout, a transfer out whose category
 * counts as return (a dividend sent to the bank), which leaves Invested alone (C3 A).
 */
function movesInvested(tx: Transaction): boolean {
  return isMoneyMoved(tx) && tx.countsAsReturn !== true;
}

/** `whole × part ÷ of` in whole paise, half up (all three positive; exact in BigInt). */
function shareOf(whole: number, part: number, of: number): number {
  const w = BigInt(whole);
  const p = BigInt(part);
  const o = BigInt(of);
  return Number((2n * w * p + o) / (2n * o));
}

/**
 * Build an `InstrumentModule` for a holding account type. `type` is the registry
 * key; `metadata` is the module's static per-module metadata (side/liquidity/…).
 */
export function createHoldingValuedModule(
  type: string,
  metadata: ModuleMetadata,
): InstrumentModule {
  return {
    type,
    metadata,

    /**
     * The natural SIGNED derived balance — identical to every account. Moves
     * with contributions, withdrawals AND valuation marks. Never stored.
     */
    currentValue(account: AccountView, asOf: PlainDate): Money {
      return balanceAsOf(account.opening, account.transactions, asOf);
    },

    /**
     * Cost basis (Invested) = the cost of what is still held (S2 RD3 and RD5, amended by the red
     * team's rule 1). Walked in `(date, sequence)` order over the rows dated ≤ asOf:
     *   - money put in (`movesInvested`, amount > 0) adds its amount;
     *   - on an ASSET, money taken out lowers Invested by Invested × withdrawn ÷ value just before
     *     (average cost in money: the share of value withdrawn stands in for the share of units
     *     sold), the ratio at most 1, skipped when the value before is ₹0 or less. The realised gain
     *     leaves with the money; the gain still held stays as return;
     *   - on a LIABILITY, money moved adds as it always did (a loan's basis is never shown).
     * Marks and other growth rows move value only, never Invested. Floored at 0.
     */
    costBasis(account: AccountView, asOf: PlainDate): Money {
      const asset = metadata.side === 'Asset';
      let basis = account.opening.paise;
      let value = account.opening.paise;
      for (const tx of sortTransactions(account.transactions)) {
        if (compareDates(tx.date, asOf) > 0) break;
        const amount = tx.amount.paise;
        if (movesInvested(tx)) {
          if (asset && amount < 0) {
            if (value > 0 && basis > 0) basis -= shareOf(basis, Math.min(-amount, value), value);
          } else {
            basis += amount;
          }
        }
        value += amount;
      }
      return Money.fromPaise(basis < 0 ? 0 : basis, account.currency);
    },

    /**
     * Cash flows fold only MONEY MOVED (`isMoneyMoved`: transfer legs, payouts included, and plain
     * rows whose category isn't return) within `[period.from, period.to]` into non-negative
     * in/out magnitudes — the real money moved into/out of the holding. Valuation marks and other
     * growth rows are deliberately excluded: a mark is unrealized gain/loss, not a cash flow (S3).
     */
    cashFlows(account: AccountView, period: Period): CashFlows {
      let inflow = Money.zero(account.currency);
      let outflow = Money.zero(account.currency);
      for (const tx of account.transactions) {
        if (!isMoneyMoved(tx)) continue;
        if (compareDates(tx.date, period.from) < 0 || compareDates(tx.date, period.to) > 0) {
          continue;
        }
        if (tx.amount.paise > 0) {
          inflow = inflow.add(tx.amount);
        } else if (tx.amount.paise < 0) {
          outflow = outflow.add(tx.amount.negate());
        }
      }
      return { inflow, outflow };
    },
  };
}
