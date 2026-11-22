/**
 * contract.ts — the aggregation contract (the sacred interface).
 *
 * ┌───────────────────────────────────────────────────────────────────────┐
 * │ FROZEN at the end of M2.                                               │
 * │ Every instrument module (the 11-module v1 set, and every v2 module)    │
 * │ implements this SAME interface. Aggregation — net worth, allocation,   │
 * │ growth, FX — reads ONLY this contract + the module registry, and NEVER │
 * │ branches on a concrete module type. `if (module.type === 'FD')` in an  │
 * │ aggregation path is a DEFECT (architecture.md §5). Changing anything   │
 * │ here ripples across every module and every aggregate — it is a         │
 * │ deliberate act, not a casual edit.                                     │
 * └───────────────────────────────────────────────────────────────────────┘
 *
 * See docs/product/architecture.md §5.
 *
 * Amended (as a frozen-interface change): the
 * `Transaction` it carries gains ONE optional field, `countsAsReturn` (transaction.ts), so a module
 * can tell money put in from growth on rows that aren't transfers (EPF's Salary) and a payout from
 * a withdrawal. Optional, absent = the old rule; no method or type here changed.
 *
 * Two design keystones baked into these types:
 *
 *  1. Metadata split. `side` / `liquidity` / `cardinality` / `markable` /
 *     `accountClass` are PER-MODULE (static, on `ModuleMetadata`).
 *     `currency` / `status` are PER-ACCOUNT (instance-level, on `AccountView`).
 *     Aggregation consumes a flattened per-account `AccountValuation` so it
 *     never has to know which datum came from where.
 *
 *  2. Sign convention. `currentValue` carries the NATURAL SIGNED value — a
 *     credit-card ledger is negative when money is owed. Therefore
 *     net worth = Σ currentValue with NO per-side branching; `side` drives
 *     allocation/display grouping only, never the net-worth sum. This makes
 *     "net worth is invariant under transfers" and "no `if module===`" true
 *     by construction.
 *
 * FX note: values are documented "in base currency", but the single
 * `to_base` conversion boundary is a LATER milestone (M9). Until then the
 * engine is single-currency (INR) and MUST NOT silently assume a 1:1 rate
 * for a foreign currency — that is the Firefly anti-pattern we reject.
 */
import type { CurrencyCode, Money } from '../money.js';
import type { PlainDate } from '../date.js';
import type { Transaction } from '../transaction.js';

/** Which side of the balance sheet a module sits on. Drives allocation/display grouping, NOT the net-worth sum. */
export type Side = 'Asset' | 'Liability';

/** How readily an asset can be converted to cash. `Illiquid` still counts toward net worth. */
export type Liquidity = 'Liquid' | 'Semi' | 'Illiquid';

/**
 * Whether a module holds many independent accounts (`collection`) or at most
 * one active account per instance (`single-active`). No v1 module uses
 * `single-active`; it is kept as a registry dimension purely as the v2
 * PPF/EPF slot — proof the registry is pluggable (architecture.md §5).
 */
export type Cardinality = 'collection' | 'single-active';

/** Account lifecycle. Closed accounts are excluded from current net worth (they still appear in history). */
export type AccountStatus = 'open' | 'closed';

/**
 * Spending accounts (Bank, Credit Card) feed cashflow/spending analytics;
 * holding accounts (everything else) are net-worth-only. Type-derived, read
 * by reports (R2/R3, M10). (architecture.md §6.)
 */
export type AccountClass = 'spending' | 'holding';

/** Static, per-module metadata — the same for every account a module values. */
export interface ModuleMetadata {
  readonly side: Side;
  readonly liquidity: Liquidity;
  readonly cardinality: Cardinality;
  readonly accountClass: AccountClass;
  /** Whether a valuation mark ("now worth ₹X") can be posted against this account. Mark POSTING is a later milestone. */
  readonly markable: boolean;
}

/**
 * The pure-data view of one account a module values. DB-free by design: it
 * carries the opening balance and the transaction list directly, so the
 * engine never reaches for a driver. `type` is the registry key routing this
 * account to its module — a module never branches on it (it IS that module).
 */
export interface AccountView {
  readonly id: string;
  /** Registry key — which module values this account (e.g. 'bank', 'creditCard'). */
  readonly type: string;
  readonly currency: CurrencyCode;
  readonly status: AccountStatus;
  readonly opening: Money;
  readonly transactions: readonly Transaction[];
}

/** An inclusive `[from, to]` calendar-date window for period-scoped queries. */
export interface Period {
  readonly from: PlainDate;
  readonly to: PlainDate;
}

/**
 * Money in / out over a period, each a NON-NEGATIVE magnitude.
 * Net flow = `inflow.subtract(outflow)`. (For cashflow + savings rate.)
 */
export interface CashFlows {
  readonly inflow: Money;
  readonly outflow: Money;
}

/**
 * The sacred contract. Every module exposes exactly this, as-of a date.
 *
 * - `currentValue` — the only thing net worth / allocation / growth read.
 *   Natural signed value (see the sign-convention keystone above).
 * - `costBasis` — what was put into what is still held (a withdrawal takes out its share of
 *   value, S2 RD3); return = value − basis.
 *   For pure-cash modules (Bank, Credit Card) basis === value (no unrealized
 *   gain), so their return is zero by construction.
 * - `cashFlows` — money in/out over a period.
 */
export interface InstrumentModule {
  /** Registry key. Unique per module. */
  readonly type: string;
  readonly metadata: ModuleMetadata;
  currentValue(account: AccountView, asOf: PlainDate): Money;
  costBasis(account: AccountView, asOf: PlainDate): Money;
  cashFlows(account: AccountView, period: Period): CashFlows;
}

/**
 * The flattened per-account bundle aggregation reads. Combines the
 * per-account valuation (`currentValue` / `costBasis`) with the per-module
 * metadata (`side` / `liquidity` / `accountClass`) and the per-account
 * instance metadata (`currency` / `status`) — so aggregation code deals in
 * ONE uniform shape and never touches a concrete module. Produced by a
 * bridging helper in the aggregation layer, typed here so the shape is frozen.
 */
export interface AccountValuation {
  readonly accountId: string;
  readonly currentValue: Money;
  readonly costBasis: Money;
  readonly side: Side;
  readonly liquidity: Liquidity;
  readonly accountClass: AccountClass;
  readonly currency: CurrencyCode;
  readonly status: AccountStatus;
}
