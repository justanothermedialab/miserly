/**
 * currencies.ts — the MC1/MC3 supported-currency list + display symbols.
 * ============================================================================
 * A small, FRAMEWORK-AGNOSTIC vocabulary shared by the client (the F1 currency
 * picker, MC3's rate-management select) and the server (F1's create-account
 * validation): "which ISO-4217 codes does Miserly offer", and "what symbol does
 * each render with". This is NOT the rates store (that's `lib/server/rates.ts`,
 * server-only, DB-backed) — this file has no persistence and no DB import, so it
 * is safe to pull into a `.svelte` component directly.
 *
 * Extending `SUPPORTED_CURRENCIES` is additive-only and needs no migration: it
 * is pure UI/validation surface. MC1 locks currency immutable-after-creation and
 * "one rate per active currency" — neither rule depends on list membership past
 * creation time, so adding a code here never reinterprets an existing account.
 * ============================================================================
 */

/**
 * The base currency of an instance set up before the choice existed (no `circle.base_currency`
 * row): rupees, as it always was. The live base is read per request on the server
 * (`baseCurrency` in `lib/server/settings.ts`) and handed to pages as `data.baseCurrency`; this is
 * only the fallback (MC1 RD2 amended).
 */
export const DEFAULT_BASE_CURRENCY = 'INR';

/**
 * ISO-4217 codes offered on account creation (MVP subset): rupees plus
 * the currencies the bullseye persona is likely to actually hold — US RSUs/
 * stocks chief among them — plus a handful of other common majors. Order here
 * is the picker's display order (base first, then alphabetical).
 */
export const SUPPORTED_CURRENCIES = [
  'INR',
  'AED',
  'AUD',
  'CAD',
  'CHF',
  'EUR',
  'GBP',
  'JPY',
  'SGD',
  'USD',
] as const;

export type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number];

/** True iff `code` is one of the offered ISO-4217 codes (case-sensitive, upper). */
export function isSupportedCurrency(code: string): code is SupportedCurrency {
  return (SUPPORTED_CURRENCIES as readonly string[]).includes(code);
}

/** Decimal places a currency's amounts carry (ISO 4217, through Intl): 2 for most, 0 for JPY. */
function minorDigits(code: string): number {
  return new Intl.NumberFormat('en', { style: 'currency', currency: code }).resolvedOptions().maximumFractionDigits ?? 2;
}

/**
 * The currencies setup offers as the "Currency for totals" (H1, MC1 RD2 amended): the supported
 * ones with two decimals. Money is whole hundredths everywhere (paise), so a 0- or 3-decimal base
 * (JPY, KWD) is outside it (sweep row A5). An account may still be held in JPY.
 */
export const BASE_CURRENCY_CHOICES: readonly SupportedCurrency[] = SUPPORTED_CURRENCIES.filter((c) => minorDigits(c) === 2);

/** True iff `code` may be an instance's base currency. */
export function isBaseCurrencyChoice(code: string): boolean {
  return (BASE_CURRENCY_CHOICES as readonly string[]).includes(code);
}

/** The month a financial year starts in: January or April. */
export type YearStartMonth = 1 | 4;

/** An instance set up before the choice: April to March, India's year (R1 RD amended). */
export const DEFAULT_YEAR_START: YearStartMonth = 4;

/** The year start setup preselects for a base currency: April for rupees, January otherwise. */
export function defaultYearStartFor(baseCurrency: string): YearStartMonth {
  return baseCurrency === 'INR' ? 4 : 1;
}

/** Parse a stored or posted year start ("1" or "4"); anything else is null. */
export function parseYearStart(value: string | null | undefined): YearStartMonth | null {
  return value === '1' ? 1 : value === '4' ? 4 : null;
}

/**
 * Display symbol per currency (the format.ts "native-primary" glyph). A "$"-
 * style symbol is inherently ambiguous across currencies (USD/AUD/CAD/SGD all
 * use it) — MC3's mitigation is to show the ISO CODE alongside wherever that
 * ambiguity matters (the rate surface, cross-currency transfer legs), not to
 * bake the code into every amount. Currencies with no distinct glyph (AED, CHF)
 * fall back to their code with a trailing space so the amount still reads
 * cleanly ("AED 1,000.00").
 */
export const CURRENCY_SYMBOLS: Record<string, string> = {
  INR: '₹',
  USD: '$',
  EUR: '€',
  GBP: '£',
  JPY: '¥',
  AUD: 'A$',
  CAD: 'C$',
  SGD: 'S$',
  AED: 'AED ',
  CHF: 'CHF ',
};

/**
 * A currency's display symbol: the table above (₹ for rupees; A$, C$, S$ where Intl's narrow
 * symbol would be a bare "$"), else Intl's narrow symbol, else `'<CODE> '`.
 */
export function currencySymbol(code: string): string {
  const mapped = CURRENCY_SYMBOLS[code];
  if (mapped !== undefined) return mapped;
  try {
    const sym = new Intl.NumberFormat('en', { style: 'currency', currency: code, currencyDisplay: 'narrowSymbol' })
      .formatToParts(0)
      .find((p) => p.type === 'currency')?.value;
    if (sym && sym !== code) return sym;
  } catch {
    // Not an ISO code Intl knows: fall through to the code itself.
  }
  return `${code} `;
}
