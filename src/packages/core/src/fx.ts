/**
 * fx.ts — the single `to_base` conversion boundary (M9 / MC1).
 * ============================================================================
 * The aggregation contract (contract.ts) always reserved this: values are
 * documented "in base currency", but the ONE place a foreign amount becomes a
 * base amount is here — and NOWHERE else. Every aggregate (net worth,
 * allocation, history) folds native `currentValue`s through `toBase` before it
 * sums, so a base-currency figure is always DERIVED and never stored — the same
 * single-source-of-truth rule that governs balances.
 *
 * Three invariants baked into these types, straight from MC1's failure cases:
 *
 *  1. NEVER a silent 1:1. A foreign currency with no rate converts to `null`
 *     (the "rate needed" signal the caller must surface), NEVER to the native
 *     number reinterpreted as base. That is the Firefly defect we reject.
 *
 *  2. Units are FIXED as base-per-1-foreign (₹ per 1 USD). `basePaise =
 *     nativePaise × rate`. There is no divide-by-rate path, so the upside-down
 *     confusion (foreign-per-base) cannot arise.
 *
 *  3. No float drift. A rate is a scaled integer `scaled / 10^scale`, and the
 *     conversion is computed in BigInt (nativePaise × scaled ÷ 10^scale, rounded
 *     half-away-from-zero), so neither a huge balance nor a many-dp rate loses a
 *     paise to floating point. Money stays integer paise end to end.
 *
 * The engine stays PURE: a `RateTable` is plain data the web layer builds from
 * the persisted `rates` table (apps/web) and hands in. fx.ts never reads a DB.
 * ============================================================================
 */
import { Money } from './money.js';
import type { CurrencyCode } from './money.js';

/**
 * One currency's current rate to base, as an exact scaled integer:
 * `value = scaled / 10^scale` base units per 1 foreign unit. Stored this way
 * (not as a float) so conversion never drifts. `scaled` must be > 0 (a zero or
 * negative rate is invalid data, not a "missing" rate — that is `undefined` in
 * the table); `scale` must be a non-negative integer.
 */
export interface Rate {
  readonly scaled: number;
  readonly scale: number;
}

/**
 * The set of current aggregation rates plus which currency is base. `rates` maps
 * a FOREIGN currency to its rate; base is implicitly ×1 and never appears here.
 * A currency absent from the map has NO rate → `toBase` returns `null` for it.
 */
export interface RateTable {
  readonly base: CurrencyCode;
  readonly rates: ReadonlyMap<CurrencyCode, Rate>;
}

/** Assert a rate is well-formed (positive scaled, non-negative integer scale). */
function assertRate(rate: Rate): void {
  if (!Number.isSafeInteger(rate.scaled) || rate.scaled <= 0) {
    throw new Error(`fx: rate.scaled must be a positive safe integer, got ${rate.scaled}`);
  }
  if (!Number.isInteger(rate.scale) || rate.scale < 0) {
    throw new Error(`fx: rate.scale must be a non-negative integer, got ${rate.scale}`);
  }
}

/**
 * Build a `RateTable`. Validates every rate up front (so a malformed rate fails
 * loudly at construction, not deep inside an aggregate). Base→base is never an
 * entry — it is always ×1.
 */
export function rateTable(
  base: CurrencyCode,
  entries: Iterable<readonly [CurrencyCode, Rate]> = [],
): RateTable {
  const rates = new Map<CurrencyCode, Rate>();
  for (const [currency, rate] of entries) {
    if (currency === base) continue; // base is implicitly ×1; ignore a stray self-rate
    assertRate(rate);
    rates.set(currency, rate);
  }
  return { base, rates };
}

/**
 * Convert `money` to the table's base currency.
 *
 *  - Same currency as base → returned unchanged (×1, the common all-INR case).
 *  - Foreign with a rate → `Money.fromPaise(round(paise × scaled / 10^scale))`.
 *  - Foreign with NO rate → `null` (the "rate needed" signal — NEVER 1:1).
 *
 * Rounding is half-away-from-zero on the magnitude (symmetric, no sign bias).
 * Throws if the exact result exceeds the safe-integer range (a ₹90-trillion+
 * aggregate — not a realistic balance, so a loud failure beats silent precision
 * loss).
 */
export function toBase(money: Money, rates: RateTable): Money | null {
  if (money.currency === rates.base) return money;
  const rate = rates.rates.get(money.currency);
  if (rate === undefined) return null;
  assertRate(rate);

  const num = BigInt(money.paise) * BigInt(rate.scaled);
  const den = 10n ** BigInt(rate.scale);
  const negative = num < 0n;
  const abs = negative ? -num : num;
  const q = abs / den;
  const r = abs % den;
  // half-away-from-zero: round up when the remainder is >= half the divisor.
  const roundedAbs = r * 2n >= den ? q + 1n : q;
  const signed = negative ? -roundedAbs : roundedAbs;

  if (signed > BigInt(Number.MAX_SAFE_INTEGER) || signed < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new Error(
      `fx.toBase: converted amount ${signed} exceeds safe-integer range ` +
        `(${money.paise} paise of ${money.currency} at rate ${rate.scaled}/1e${rate.scale})`,
    );
  }
  return Money.fromPaise(Number(signed), rates.base);
}

/** True iff `money` can be converted to base (base itself, or a rated foreign currency). */
export function hasRate(money: Money, rates: RateTable): boolean {
  return money.currency === rates.base || rates.rates.has(money.currency);
}
