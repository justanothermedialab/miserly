/**
 * prefs.ts — CLIENT-SAFE display-preference types + pure policy (SET1).
 * ============================================================================
 * This holds the parts of the number-format preference that BOTH the server
 * service (`server/settings.ts`) and the client formatter context
 * (`format-context.ts`) need — the types, the locale-derived default, and the
 * pure "which grouping applies to this amount" policy. It imports NOTHING from
 * `$lib/server` (SvelteKit would reject a server import in client code), touches
 * no DB, and no stored value — it is pure render policy (SET1 "display-only").
 * ============================================================================
 */
export type NumberSystem = 'indian' | 'western';
export type ForeignGrouping = 'preference' | 'native-locale';
export type Theme = 'system' | 'light' | 'dark' | 'black';
/** The curated accent colours (SET1 RD6): Ink (default),
 *  Gold, the person's own Windows accent (desktop only), Teal and Lime. */
export type Accent = 'ink' | 'gold' | 'windows' | 'teal' | 'lime';
export const ACCENTS: readonly Accent[] = ['ink', 'gold', 'windows', 'teal', 'lime'];

/** A stored accent, the retired choices mapped to the one that took their slot (blue and indigo to
 *  teal, purple, plum and coral to lime: the column is plain text, so no migration), anything else to Ink. */
export function normalizeAccent(a: string | null | undefined): Accent {
  if (a === 'blue' || a === 'indigo') return 'teal';
  if (a === 'purple' || a === 'plum' || a === 'coral') return 'lime';
  return (ACCENTS as readonly string[]).includes(a ?? '') ? (a as Accent) : 'ink';
}

/** A user's resolved display preferences (SET1). Never touches financial data. */
export interface UserPrefs {
  readonly numberSystem: NumberSystem;
  readonly compact: boolean;
  readonly foreignGrouping: ForeignGrouping;
  readonly theme: Theme;
  readonly accent: Accent;
}

/**
 * Languages/regions that read natively in lakh/crore (SET1 RD2 locale default,
 * and the `native-locale` foreign-grouping rule). Currencies of these regions
 * (PKR/BDT/LKR/NPR/INR) group 2-2-3 like the Rupee; everyone else groups by 3s.
 */
const SOUTH_ASIAN_LANGS = new Set(['hi', 'bn', 'ta', 'te', 'mr', 'gu', 'kn', 'ml', 'pa', 'ur', 'or', 'as', 'ne', 'si']);
const SOUTH_ASIAN_REGIONS = new Set(['IN', 'PK', 'BD', 'LK', 'NP']);
/** ISO-4217 codes that use Indian-style 2-2-3 grouping natively. */
const SOUTH_ASIAN_CURRENCIES = new Set(['INR', 'PKR', 'BDT', 'LKR', 'NPR']);

/** Number system from a device-locale hint (e.g. an Accept-Language value) — the fallback when the base currency doesn't decide. */
export function defaultNumberSystemForLocale(localeHint?: string | null): NumberSystem {
  if (!localeHint) return 'western';
  // Highest-priority tag only (before any ';q=' weight or comma-separated list).
  const primary = localeHint.split(',')[0]!.split(';')[0]!.trim().toLowerCase();
  const [lang, region] = primary.split('-');
  if (lang && SOUTH_ASIAN_LANGS.has(lang)) return 'indian';
  if (region && SOUTH_ASIAN_REGIONS.has(region.toUpperCase())) return 'indian';
  return 'western';
}

/**
 * First-run number system (SET1 RD2, amended): an INR base
 * currency ⇒ Indian, whatever the device says (most Indian Windows desktops report
 * `en-US`); otherwise fall back to the device-locale rule.
 */
export function defaultNumberSystem(localeHint?: string | null, baseCurrency?: string | null): NumberSystem {
  if (baseCurrency?.toUpperCase() === 'INR') return 'indian';
  return defaultNumberSystemForLocale(localeHint);
}

/** The preferences of a user with NO stored row — base-currency/locale-derived, safe defaults. */
export function defaultUserPrefs(localeHint?: string | null, baseCurrency?: string | null): UserPrefs {
  return {
    numberSystem: defaultNumberSystem(localeHint, baseCurrency),
    compact: true, // SET1 RD5: summaries compact by default
    foreignGrouping: 'preference',
    theme: 'system',
    accent: 'ink',
  };
}

/**
 * THE grouping policy: does this amount render with Western (3-digit) grouping?
 * Base rule = the user's chosen number system. Exception (SET1 RD3): when
 * `foreignGrouping = 'native-locale'`, a FOREIGN amount instead groups by ITS
 * OWN currency's native style (a South-Asian currency stays 2-2-3, everything
 * else is 3-digit) — independent of the user's system. The base currency (INR)
 * always follows the user's system.
 */
export function isWesternGrouping(prefs: UserPrefs, currency: string, baseCurrency: string): boolean {
  const systemWestern = prefs.numberSystem === 'western';
  if (prefs.foreignGrouping === 'preference' || currency === baseCurrency) {
    return systemWestern;
  }
  // native-locale for a foreign currency: group by that currency's own style.
  return !SOUTH_ASIAN_CURRENCIES.has(currency.toUpperCase());
}
