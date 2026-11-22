/**
 * ledgerValued.ts — shared factory for "ledger-valued" (cash-like) modules.
 *
 * Bank and Credit Card are both, at the domain-math level, nothing more than
 * a signed running ledger: `currentValue` is just `balanceAsOf`, there is no
 * unrealized gain/loss (so `costBasis === currentValue`), and cash flows are
 * a straight split of the period's transactions into non-negative in/out
 * magnitudes. The ONLY thing that distinguishes Bank from Credit Card is
 * `ModuleMetadata` (`side: 'Asset'` vs `side: 'Liability'`, etc.) — this
 * factory makes that "same computation, metadata-differentiated" thesis
 * vivid, and is the mechanism by which the 11-module v1 set adds new
 * ledger-valued modules with zero `if module===` branching anywhere.
 */
import { balanceAsOf } from '../ledger.js';
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

/**
 * Build an `InstrumentModule` for a cash-like account type. `type` is the
 * registry key; `metadata` is the module's static per-module metadata.
 */
export function createLedgerValuedModule(
  type: string,
  metadata: ModuleMetadata,
): InstrumentModule {
  return {
    type,
    metadata,

    /** The natural SIGNED ledger balance, derived on read — never stored. */
    currentValue(account: AccountView, asOf: PlainDate): Money {
      return balanceAsOf(account.opening, account.transactions, asOf);
    },

    /**
     * Cash has no unrealized gain/loss: every paise of value came from a
     * contribution or a withdrawal, never a "mark". So cost basis equals
     * current value exactly, making return = value − basis = 0 by
     * construction for every ledger-valued module.
     */
    costBasis(account: AccountView, asOf: PlainDate): Money {
      return balanceAsOf(account.opening, account.transactions, asOf);
    },

    /**
     * Fold the transactions falling within `[period.from, period.to]`
     * (inclusive) into non-negative inflow/outflow magnitudes. Zero-amount
     * rows contribute to neither bucket.
     */
    cashFlows(account: AccountView, period: Period): CashFlows {
      let inflow = Money.zero(account.currency);
      let outflow = Money.zero(account.currency);
      for (const tx of account.transactions) {
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
