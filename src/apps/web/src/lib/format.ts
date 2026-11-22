/**
 * format.ts — the app-wide number formatter (SET1 groundwork, centralized now).
 * ============================================================================
 * Money is integer paise everywhere in the domain; this is the ONE place that
 * divides by 100 to produce a display string — nothing upstream should ever do
 * that math itself. Indian (lakh/crore) grouping is the MVP-wide default; a
 * Western sibling exists so SET1 can later flip the preference without a
 * rewrite. `slicePercents` is the one place percentages are derived from paise
 * amounts for a pie/donut — it guarantees the slices sum to exactly 100.0%
 * (D2 failure case), which naive per-slice rounding cannot guarantee.
 *
 * MC3 (M9b): `formatMoney` grew an optional `currency` (default 'INR' for the pure
 * function; components format through `useMoney()`, which passes the instance's base). The digit-GROUPING style
 * (Indian vs Western, compact vs long) stays the one app-wide preference,
 * independent of currency — only the leading SYMBOL changes per `currencies.ts`.
 * This file does no FX conversion (that is `toBase`, packages/core/fx.ts,
 * fed via apps/web `rates.ts`) — it only ever renders a NATIVE figure that a
 * caller already resolved. `formatBaseApprox` is the one helper for MC3's
 * "≈ ₹X" secondary line, always in base (the setup choice) regardless of the primary
 * figure's own currency — the native-primary/base-secondary convention.
 * ============================================================================
 */
import { currencySymbol } from './currencies';

/** Group a non-negative integer-string in the Indian style: last 3, then 2s. */
function groupIndian(intStr: string): string {
	if (intStr.length <= 3) return intStr;
	const last3 = intStr.slice(-3);
	let rest = intStr.slice(0, -3);
	const groups: string[] = [];
	while (rest.length > 2) {
		groups.unshift(rest.slice(-2));
		rest = rest.slice(0, -2);
	}
	if (rest.length > 0) groups.unshift(rest);
	groups.push(last3);
	return groups.join(',');
}

/** Group a non-negative integer-string in the Western style: every 3 digits. */
function groupWestern(intStr: string): string {
	return intStr.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** A count (rows, transactions) grouped like amounts: 1,501, or 1,50,000 Indian / 150,000 Western. */
export function formatCount(n: number, western = false): string {
	const s = String(Math.trunc(Math.abs(n)));
	return (n < 0 ? MINUS : '') + (western ? groupWestern(s) : groupIndian(s));
}

export interface FormatMoneyOpts {
	/** Abbreviate to K/L/Cr (Indian) or K/M/B (Western). Default false. */
	readonly compact?: boolean;
	/** Use Western grouping/scale instead of the Indian default. Default false. */
	readonly western?: boolean;
	/** ISO-4217 code of the amount's OWN (native) currency. Default 'INR' — every
	 *  pre-M9b call site (no `currency` passed) renders exactly as before. */
	readonly currency?: string;
}

/** U+2212 MINUS SIGN — typographic minus for every displayed negative (DL-12): it
 *  matches the + width in tabular figures and never line-breaks away from the
 *  number the way a hyphen can. Display only; nothing parses these strings. */
export const MINUS = '−';

/** Compact units in paise, smallest first: Indian K / L / Cr, Western K / M / B. */
const INDIAN_UNITS: readonly (readonly [number, string])[] = [[1e5, 'K'], [1e7, 'L'], [1e9, 'Cr']];
const WESTERN_UNITS: readonly (readonly [number, string])[] = [[1e5, 'K'], [1e8, 'M'], [1e11, 'B']];

/**
 * Compact: {S}12.3K / {S}12.3L / {S}1.2Cr (or K / M / B); plain whole units below 1,000.
 * Rounds in whole paise, half away from zero (integers, never binary `toFixed`),
 * BEFORE the unit is picked, so a value that rounds up to the next unit reads in it: ₹99,96,000 is
 * ₹1Cr (not ₹100L), ₹999.60 is ₹1K, ₹1,45,000 and ₹2,45,000 are ₹1.5L and ₹2.5L alike, and
 * −₹0.40 is ₹0 (no minus on a zero).
 */
function formatCompact(abs: number, negative: boolean, symbol: string, units: readonly (readonly [number, string])[]): string {
	const whole = Math.floor((abs + 50) / 100);
	if (whole < 1000) return `${negative && whole > 0 ? MINUS : ''}${symbol}${whole}`;
	let i = units.length - 1;
	while (i > 0 && abs < units[i]![0]) i--;
	for (;;) {
		const [unit, suffix] = units[i]!;
		const tenths = Math.floor((abs * 10 + unit / 2) / unit);
		const next = units[i + 1];
		if (next && tenths >= (10 * next[0]) / unit) {
			i++;
			continue;
		}
		const text = tenths % 10 === 0 ? String(tenths / 10) : `${Math.floor(tenths / 10)}.${tenths % 10}`;
		return `${negative ? MINUS : ''}${symbol}${text}${suffix}`;
	}
}

/**
 * Paise (of `opts.currency`, default INR) -> a display string. Default: Indian
 * long form, two decimals, e.g. `₹12,34,567.00` (negatives: `-₹1,200.00`).
 * `opts.compact` abbreviates to K/L/Cr (or K/M/B with `opts.western`); compact
 * drops cents and shows plain units below {symbol}1,000. A foreign currency
 * (e.g. USD) swaps only the leading symbol (`$12,34,567.00` under the Indian
 * default preference) — the SAME grouping/compaction logic, since MC3 locks
 * "all amounts respect the one app-wide number-format preference" regardless
 * of which currency they're denominated in.
 */
export function formatMoney(paise: number, opts?: FormatMoneyOpts): string {
	const symbol = currencySymbol(opts?.currency ?? 'INR');
	const negative = paise < 0;
	const abs = Math.abs(paise);

	if (opts?.compact) return formatCompact(abs, negative, symbol, opts?.western ? WESTERN_UNITS : INDIAN_UNITS);

	const units = Math.floor(abs / 100);
	const cents = abs % 100;
	const grouped = opts?.western ? groupWestern(String(units)) : groupIndian(String(units));
	const decimals = String(cents).padStart(2, '0');
	return `${negative ? MINUS : ''}${symbol}${grouped}.${decimals}`;
}

/** Like `formatMoney`, but a positive amount carries an explicit leading "+" (for deltas). */
export function formatSignedMoney(paise: number, opts?: FormatMoneyOpts): string {
	const s = formatMoney(paise, opts);
	return paise > 0 ? `+${s}` : s;
}

/**
 * `formatMoney` plus a trailing ISO code — MC3's disambiguation for the spots
 * where a bare symbol is genuinely ambiguous ($ alone doesn't say USD vs AUD
 * vs SGD): the rate-management surface and cross-currency transfer legs. Not
 * used for ordinary INR amounts (the app-wide common case stays chrome-free).
 */
export function formatMoneyWithCode(paise: number, currency: string, opts?: FormatMoneyOpts): string {
	return `${formatMoney(paise, { ...opts, currency })} ${currency}`;
}

/**
 * MC3's "≈ ₹X" secondary line: a base-currency figure shown alongside a
 * foreign-native primary amount, in the instance's base (`currency`, rupees when
 * not passed; the bound formatter always passes the base). `null` in means "no
 * rate" (MC1's honest-gap rule); callers render "rate needed" for that case
 * themselves rather than calling this helper with a fabricated number.
 */
export function formatBaseApprox(basePaise: number, opts?: Pick<FormatMoneyOpts, 'compact' | 'western' | 'currency'>): string {
	return `≈ ${formatMoney(basePaise, opts)}`;
}

/**
 * A scaled-integer FX RATE (`scaled / 10^scale`, e.g. MC2's linkage rate or an
 * MC1/MC3 rate-surface row) -> a trimmed decimal string for display, e.g.
 * `83.5`, `90`, `0.006`. This is a RATIO, not money — no paise, no currency
 * symbol, plain division is fine (the domain math that actually MOVES money —
 * `toBase`/`resolveFx` — stays in BigInt server-side; this only ever
 * re-renders a value those already computed exactly).
 */
export function formatRate(scaled: number, scale: number): string {
	if (scale <= 0) return String(scaled); // integer rate — no fractional part to trim
	const value = scaled / 10 ** scale;
	// Trim only trailing FRACTIONAL zeros (a naive /0+$/ would turn "100" → "1").
	return value.toFixed(Math.min(scale, 6)).replace(/(\.\d*?)0+$/u, '$1').replace(/\.$/u, '');
}

/** A ratio (0.123 -> "12.3%") to one decimal. Negative ratios keep their sign. */
export function formatPercent(ratio: number): string {
	const v = (ratio * 100).toFixed(1);
	return `${v.startsWith('-') ? MINUS + v.slice(1) : v}%`;
}

/** A holder's share from basis points (10,000 = 100 %): "50%", "33.3%", "0%" (H2 RD8). */
export function formatShare(bp: number): string {
	const pct = bp / 100;
	return `${Number.isInteger(pct) ? pct : pct.toFixed(1)}%`;
}

/**
 * Largest-remainder apportionment: turns a list of paise amounts into
 * percentages (one decimal place) that sum to EXACTLY 100.0 — the D2 failure
 * case ("percentages must sum to 100%") that naive per-slice rounding cannot
 * guarantee. Non-positive total -> all zeros.
 */
export function slicePercents(amountsPaise: readonly number[]): number[] {
	const total = amountsPaise.reduce((sum, a) => sum + a, 0);
	if (total <= 0) return amountsPaise.map(() => 0);

	const TOTAL_TENTHS = 1000; // 100.0% expressed in tenths of a percent
	const raw = amountsPaise.map((a) => (a / total) * TOTAL_TENTHS);
	const floors = raw.map((r) => Math.floor(r));
	const allocated = floors.reduce((sum, f) => sum + f, 0);
	let remainder = TOTAL_TENTHS - allocated;

	const order = raw
		.map((r, i) => ({ i, frac: r - floors[i]! }))
		.sort((a, b) => b.frac - a.frac);

	const tenths = [...floors];
	for (let k = 0; k < order.length && remainder > 0; k++, remainder--) {
		tenths[order[k]!.i]! += 1;
	}
	return tenths.map((t) => t / 10);
}

/**
 * The colour of an amount (D1 RD7 B): every negative amount `--neg`, every positive
 * amount `--pos`, zero in the default text colour. The sign is printed too, so colour is
 * never the only carrier. Unsigned rows (a merged transfer) don't call this.
 */
export function toneClass(paise: number): string {
	return paise < 0 ? 'text-neg' : paise > 0 ? 'text-pos' : '';
}

/**
 * Neutral money (item 3 direction C, amends D1 RD7): colour only where it says
 * something. A LEVEL (a balance, net worth, value, subtotal) reads in the text colour; its sign says
 * which side. `toneClass` stays for changes, returns and nets (they say up or down).
 */
export function levelToneClass(paise: number): string {
	void paise; // the call names what is being coloured; a level never is
	return '';
}

/**
 * A register's running balance (item 7 (a), Actual's TransactionsTable): green
 * at zero or above, red below. The Withdrawal and Deposit columns stay in the text colour.
 */
export function balanceToneClass(paise: number): string {
	return paise < 0 ? 'text-neg' : 'text-pos';
}

/** A transaction in a list (C): money in green, money out in the text colour (the column or sign says it). */
export function flowToneClass(paise: number): string {
	return paise > 0 ? 'text-pos' : '';
}

/** A spend figure (printed unsigned, positive = money out; C): spending in the text colour, a net refund green. */
export function spendToneClass(spendPaise: number): string {
	return spendPaise < 0 ? 'text-pos' : '';
}
