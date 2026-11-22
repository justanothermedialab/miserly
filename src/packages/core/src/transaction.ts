/**
 * transaction.ts — the transaction model (pure data, no behaviour).
 *
 * Sign convention (carried by `amount: Money`): negative = outflow from
 * this account / liability-direction, positive = inflow. A transfer is
 * modelled elsewhere (a LATER milestone) as two linked rows — one negative
 * on the source account, one positive on the destination account — both
 * pointing at each other via `transferPartnerId`. This module only
 * DECLARES that field; it implements no transfer behaviour.
 *
 * `kind` distinguishes an ordinary transaction from a valuation-mark row
 * (the manual "now worth ₹X" adjustment described in architecture.md).
 * Only the shape is declared here — posting/creating a valuation mark is
 * later-milestone behaviour, not implemented in this module.
 */
import type { PlainDate } from './date.js';
import type { Money } from './money.js';

export type TransactionKind = 'ordinary' | 'valuationMark';

export interface Transaction {
  readonly id: string;
  readonly accountId: string;
  readonly date: PlainDate;
  /** Integer. Within-date ordering tiebreaker — see ordering.ts. Never an insert id. */
  readonly sequence: number;
  /** Signed amount; see sign convention above. */
  readonly amount: Money;

  // --- Forward-compatible optional fields (inert placeholders for later milestones) ---
  readonly categoryId?: string;
  readonly payeeId?: string;
  /** The linked row's transaction id, for double-entry transfers. No behaviour yet. */
  readonly transferPartnerId?: string;
  /** Who entered this row (Circle/multi-user authorship stamp). No behaviour yet. */
  readonly enteredBy?: string;
  /** 'ordinary' (default) or 'valuationMark'. No posting behaviour implemented here. */
  readonly kind?: TransactionKind;
  /**
   * Whether this row is growth (a gain or loss) rather than money put in or taken out
   * (C3 A; an optional field added to the frozen contract).
   * Set by the app from the row's category's "Counts as return" switch, or on a
   * transfer leg from its partner's category (a transfer's category sits on its spending-side
   * leg). Absent means the old rule: a transfer leg is money moved, any other row is growth.
   *   - `false` on a plain row: money put in or taken out (EPF's Salary typed inside the EPF).
   *   - `true` on a transfer leg: a payout (a dividend sent to the bank) that leaves Invested alone.
   */
  readonly countsAsReturn?: boolean;
}
