/**
 * networth.ts — the aggregation service.
 *
 * Reads ONLY the contract + the module registry — NEVER a concrete module
 * (the ESLint import-boundary rule enforces this at `packages/core/src/
 * aggregation/**`). Every function here is "for each account, look up its
 * module via the registry, ask the module, fold the result" — the whole
 * point of the aggregation contract is that this code never needs an
 * `if (account.type === 'FD')` to do that.
 *
 * M9 (MC1): every fold converts a native `currentValue` to base through the ONE
 * `toBase` boundary (fx.ts) before summing. A foreign account whose currency has
 * NO rate is EXCLUDED from the sum and its currency recorded in `rateNeeded` —
 * never folded at a silent 1:1 (the Firefly defect). Each fold therefore returns
 * an `Aggregated<T>`: the (partial) result plus the set of currencies whose
 * missing rate makes that result incomplete, so the caller can flag the total
 * honestly instead of showing a wrong-but-plausible number.
 */
import { getModule } from './registry.js';
import { Money } from '../money.js';
import type { CurrencyCode } from '../money.js';
import { toBase } from '../fx.js';
import type { RateTable } from '../fx.js';
import type { PlainDate } from '../date.js';
import type { AccountValuation, AccountView, Liquidity, Side } from './contract.js';

/**
 * A base-currency aggregate plus the "rate needed" signal. `rateNeeded` is the
 * set of foreign currencies that were EXCLUDED because they have no rate; when
 * non-empty the caller must surface "rate needed" rather than trust the number.
 */
export interface Aggregated<T> {
  readonly result: T;
  readonly rateNeeded: ReadonlySet<CurrencyCode>;
}

/**
 * Add a native amount to a base-currency running total via the single `toBase`
 * boundary. A currency with no rate is NOT added (never 1:1) — it is recorded in
 * `missing` so the enclosing aggregate can report itself incomplete.
 */
function addToBase(
  total: Money,
  native: Money,
  rates: RateTable,
  missing: Set<CurrencyCode>,
): Money {
  const converted = toBase(native, rates);
  if (converted === null) {
    missing.add(native.currency);
    return total;
  }
  return total.add(converted);
}

/**
 * The flattened per-account valuation bundle: combines the per-account
 * `currentValue`/`costBasis` (from the account's module) with the module's
 * static metadata and the account's own instance metadata, into the ONE
 * uniform shape aggregation code deals in. NATIVE-currency (no conversion) — it
 * describes one account; base conversion happens only when accounts are summed.
 */
export function valuationOf(account: AccountView, asOf: PlainDate): AccountValuation {
  const module = getModule(account.type);
  return {
    accountId: account.id,
    currentValue: module.currentValue(account, asOf),
    costBasis: module.costBasis(account, asOf),
    side: module.metadata.side,
    liquidity: module.metadata.liquidity,
    accountClass: module.metadata.accountClass,
    currency: account.currency,
    status: account.status,
  };
}

/**
 * Net worth = Σ `currentValue` (converted to base) over OPEN accounts.
 * `currentValue` already carries the natural signed value (a credit-card balance
 * is negative), so this sum needs NO per-side branching — that is what makes
 * "net worth is invariant under transfers" and "no `if module===`" true by
 * construction. A foreign currency with no rate is excluded and flagged.
 */
export function netWorth(
  accounts: readonly AccountView[],
  asOf: PlainDate,
  rates: RateTable,
): Aggregated<Money> {
  const missing = new Set<CurrencyCode>();
  let total = Money.zero(rates.base);
  for (const account of accounts) {
    if (account.status !== 'open') continue;
    const module = getModule(account.type);
    total = addToBase(total, module.currentValue(account, asOf), rates, missing);
  }
  return { result: total, rateNeeded: missing };
}

/**
 * Sum of OPEN accounts' natural-signed `currentValue` (converted to base),
 * bucketed by `side` (read from the account's module metadata via the registry —
 * no type-branching). `Asset.add(Liability)` reconciles to `netWorth(...)` (both
 * exclude the same unrated accounts).
 */
export function allocationBySide(
  accounts: readonly AccountView[],
  asOf: PlainDate,
  rates: RateTable,
): Aggregated<Record<Side, Money>> {
  const missing = new Set<CurrencyCode>();
  const totals: Record<Side, Money> = {
    Asset: Money.zero(rates.base),
    Liability: Money.zero(rates.base),
  };
  for (const account of accounts) {
    if (account.status !== 'open') continue;
    const module = getModule(account.type);
    const side = module.metadata.side;
    totals[side] = addToBase(totals[side], module.currentValue(account, asOf), rates, missing);
  }
  return { result: totals, rateNeeded: missing };
}

/**
 * Allocation of ASSETS by a chosen bucketing key, as-of a date, over OPEN
 * accounts (D2), converted to base. Liabilities are NEVER slices — they are a
 * separate figure (the `Liability` side of `allocationBySide`); an earlier prototype forced
 * them in via `abs()`, which is dropped. Slices carry the natural signed
 * `currentValue`, so an overdrawn asset account nets within its bucket (D2 RD5)
 * rather than distorting the total. `Σ buckets === allocationBySide(...).Asset`
 * by construction (both fold the same converted Asset-side `currentValue` and
 * exclude the same unrated accounts), which is what makes "the pie can never
 * disagree with the hero's asset total" true.
 *
 * The key is read from module metadata via the registry — never an
 * `if (type === …)` branch.
 */
function allocateAssets<K>(
  accounts: readonly AccountView[],
  asOf: PlainDate,
  rates: RateTable,
  keyOf: (account: AccountView) => K,
): Aggregated<Map<K, Money>> {
  const missing = new Set<CurrencyCode>();
  const buckets = new Map<K, Money>();
  for (const account of accounts) {
    if (account.status !== 'open') continue;
    const module = getModule(account.type);
    if (module.metadata.side !== 'Asset') continue;
    const key = keyOf(account);
    const running = buckets.get(key) ?? Money.zero(rates.base);
    buckets.set(key, addToBase(running, module.currentValue(account, asOf), rates, missing));
  }
  return { result: buckets, rateNeeded: missing };
}

/**
 * Allocation by asset class — bucketed by the account's module type (the
 * registry key, e.g. 'bank', 'stocks'), which is D2 RD2's granular "by
 * module" grouping. Display labels for each key are an app-layer concern.
 */
export function allocationByClass(
  accounts: readonly AccountView[],
  asOf: PlainDate,
  rates: RateTable,
): Aggregated<Map<string, Money>> {
  return allocateAssets(accounts, asOf, rates, (account) => account.type);
}

/** Allocation by liquidity (Liquid / Semi / Illiquid) — read from module metadata. */
export function allocationByLiquidity(
  accounts: readonly AccountView[],
  asOf: PlainDate,
  rates: RateTable,
): Aggregated<Map<Liquidity, Money>> {
  return allocateAssets(
    accounts,
    asOf,
    rates,
    (account) => getModule(account.type).metadata.liquidity,
  );
}
