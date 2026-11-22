/**
 * format-context.ts — the ONE place the user's number-format preference (SET1)
 * meets the shared formatter, delivered SSR-safely via Svelte context.
 * ============================================================================
 * SET1 locks "one shared formatter, zero holdouts": every money figure app-wide
 * respects the viewer's chosen number system. The preference is per-user (SET1
 * Circle addendum), so it MUST be request-scoped — a module-level global would
 * bleed one user's preference into another's during concurrent SSR. Svelte
 * `setContext`/`getContext` is exactly that request-scoped channel.
 *
 * Wiring: the root `+layout.svelte` calls `setFormatContext(getPrefs, getBase)`
 * once from layout data; every component calls `const m = useMoney()` and formats
 * through `m.money(...)` / `m.signedMoney(...)` / etc. — NEVER `formatMoney`
 * directly (that would re-introduce a hardcoded-grouping holdout). The bound
 * helpers inject the correct `western` per amount via the pure `isWesternGrouping`
 * policy (which also honours the `native-locale` foreign-grouping preference).
 *
 * REACTIVE by design (SET1 "every figure re-renders"): the bound
 * formatter reads its prefs through a GETTER, not a captured snapshot. The layout
 * holds the viewer's prefs in a `$state` (per-request on SSR — still no
 * module-level global, so no cross-user bleed) and passes `() => prefs`. Because
 * every `m.money(...)` call reads that `$state` at call-time, flipping the
 * number-format in Settings re-groups every figure app-wide instantly, no reload.
 * The `setPrefsController` channel lets the Settings page push that live change up
 * into the layout's reactive prefs (child→parent); the `?/setDisplay` POST still
 * persists the choice.
 *
 * LEDGER-EXACTNESS GUARD (SET1, non-negotiable): `money()`/`signedMoney()` default
 * to LONG form (full precision incl. paise) — registers, balances, transaction
 * amounts call these and are ALWAYS exact. `compact` is opt-in per call; a
 * glanceable surface (hero secondary, chart label) passes `compact: m.compact` to
 * honour the user's long/compact preference. `m.compact` exposes that preference.
 * ============================================================================
 */
import { getContext, setContext } from 'svelte';
import {
  formatMoney,
  formatSignedMoney,
  formatMoneyWithCode,
  formatBaseApprox,
  formatCount,
  type FormatMoneyOpts,
} from './format';
import { isWesternGrouping, type UserPrefs } from './prefs';
import { DEFAULT_BASE_CURRENCY } from './currencies';

/** Per-call formatting options a component passes (currency + optional compact). */
export interface MoneyCallOpts {
  /** Abbreviate (K/L/Cr · K/M/B). Opt-in — omit for the always-exact ledger form. */
  readonly compact?: boolean;
  /** ISO-4217 code of the amount's own currency. Default: the instance's base. */
  readonly currency?: string;
}

/** The bound formatter exposed to components — grouping already resolved from prefs. */
export interface BoundMoney {
  /** Long by default (ledger-exact); pass `compact` for glanceable surfaces. */
  money(paise: number, opts?: MoneyCallOpts): string;
  /** Like `money`, positive amounts carry an explicit leading "+". */
  signedMoney(paise: number, opts?: MoneyCallOpts): string;
  /** `money` plus a trailing ISO code (MC3 disambiguation surfaces). */
  moneyWithCode(paise: number, currency: string, opts?: Pick<MoneyCallOpts, 'compact'>): string;
  /** MC3 "≈ X" base-currency secondary line (always base, with the base's symbol). */
  baseApprox(basePaise: number, opts?: Pick<MoneyCallOpts, 'compact'>): string;
  /** A count (transactions, rows) grouped in the viewer's number system. */
  count(n: number): string;
  /** The viewer's long/compact preference (SET1) — glanceable surfaces read this. */
  readonly compact: boolean;
  /** The viewer's full resolved prefs (theme, number system, …). */
  readonly prefs: UserPrefs;
}

const MONEY_CONTEXT = Symbol('miserly.money');

/**
 * The defaults (Indian, compact summaries per SET1 RD5, preference grouping, system theme) — used
 * as the no-provider fallback in `useMoney()` and as a null-safe coalesce target
 * when the layout's reactive prefs aren't populated yet (unauthenticated chrome).
 */
export const DEFAULT_PREFS: UserPrefs = {
  numberSystem: 'indian',
  compact: true,
  foreignGrouping: 'preference',
  theme: 'system',
  accent: 'ink',
};

/**
 * The shared factory: build a bound formatter that reads its prefs + base
 * currency through GETTERS. Static and reactive callers differ only in whether
 * the getters return a snapshot or a live `$state` — the format logic is one
 * place. `compact`/`prefs` are getters so a reactive prefs source keeps
 * `m.compact` / `m.prefs.numberSystem` (e.g. the top-bar chip) live too.
 */
function makeBound(getPrefs: () => UserPrefs, getBase: () => string): BoundMoney {
  const optsFor = (opts?: MoneyCallOpts): FormatMoneyOpts => {
    const currency = opts?.currency ?? getBase();
    return {
      compact: opts?.compact ?? false,
      western: isWesternGrouping(getPrefs(), currency, getBase()),
      currency,
    };
  };
  return {
    money: (paise, opts) => formatMoney(paise, optsFor(opts)),
    signedMoney: (paise, opts) => formatSignedMoney(paise, optsFor(opts)),
    moneyWithCode: (paise, currency, opts) =>
      formatMoneyWithCode(paise, currency, optsFor({ ...opts, currency })),
    baseApprox: (basePaise, opts) =>
      formatBaseApprox(basePaise, {
        compact: opts?.compact ?? false,
        western: isWesternGrouping(getPrefs(), getBase(), getBase()),
        currency: getBase(),
      }),
    count: (n) => formatCount(n, getPrefs().numberSystem === 'western'),
    get compact() {
      return getPrefs().compact;
    },
    get prefs() {
      return getPrefs();
    },
  };
}

/** Build the bound formatter for a fixed set of prefs (pure snapshot — for tests). */
export function boundMoney(prefs: UserPrefs, baseCurrency = DEFAULT_BASE_CURRENCY): BoundMoney {
  return makeBound(
    () => prefs,
    () => baseCurrency,
  );
}

/** Build a bound formatter that tracks a reactive prefs source (instant apply). */
export function boundMoneyFrom(
  getPrefs: () => UserPrefs,
  getBaseCurrency: () => string,
): BoundMoney {
  return makeBound(getPrefs, getBaseCurrency);
}

/**
 * Root-layout wiring: publish a bound formatter into context ONCE. The getters
 * are read on every format call, so a reactive prefs source (a layout `$state`)
 * makes every figure re-render the instant the preference changes.
 */
export function setFormatContext(
  getPrefs: () => UserPrefs,
  getBaseCurrency: () => string,
): BoundMoney {
  const bound = boundMoneyFrom(getPrefs, getBaseCurrency);
  setContext(MONEY_CONTEXT, bound);
  return bound;
}

/**
 * A tiny channel so the Settings page can push a live number-format change up
 * into the layout's reactive prefs (child→parent) — instant app-wide re-render
 * without a reload. The `?/setDisplay` POST still persists the choice; this only
 * updates the in-memory view. Absent when no provider is set (e.g. isolated
 * component tests) — callers no-op via `?.`.
 */
export interface PrefsController {
  /** The layout's current (possibly-optimistic) prefs. */
  readonly current: UserPrefs;
  /** Merge a partial change into the live prefs (does not persist). */
  set(patch: Partial<UserPrefs>): void;
}

const PREFS_CONTROLLER = Symbol('miserly.prefsController');

/** Layout-side: publish the controller so descendants can live-update prefs. */
export function setPrefsController(controller: PrefsController): void {
  setContext(PREFS_CONTROLLER, controller);
}

/** Settings-side: the live-prefs controller, or undefined if none was published. */
export function usePrefsController(): PrefsController | undefined {
  return getContext<PrefsController | undefined>(PREFS_CONTROLLER);
}

/**
 * Component accessor: the viewer's bound formatter. Falls back to Indian-long
 * defaults if no context was set (e.g. an isolated component test) so a missing
 * provider degrades to the pre-M11 behaviour rather than throwing.
 */
export function useMoney(): BoundMoney {
  return getContext<BoundMoney | undefined>(MONEY_CONTEXT) ?? boundMoney(DEFAULT_PREFS);
}
