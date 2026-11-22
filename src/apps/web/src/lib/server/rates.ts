/**
 * rates.ts — the MC1 aggregation-rate store (one current rate per foreign currency).
 * ============================================================================
 * MC1 locks the model: exactly ONE current `currency→base` rate per active
 * foreign currency, entered manually, shared by every account in that currency,
 * and applied across all of history (dated period-correct rates are v2). The base
 * is the instance's currency for totals, chosen at setup (`baseCurrency` in
 * settings.ts; rupees when none was chosen; MC1 RD2 amended). Rows are kept
 * per (currency, base), so only the instance's own base's rows are read. NO
 * converted amount is ever stored — this store holds only the
 * rate; conversion happens once at the aggregation boundary via the engine's
 * `toBase` (fx.ts), which this module feeds with a `RateTable`.
 *
 * Representation (matches the frozen `rates` schema): a rate is a scaled integer
 * `rate_scaled / 10^scale` base-per-1-foreign, so there is no float drift. MVP
 * uses SCALE = 6 (six decimal places — ample for any FX quote). We keep ONE row
 * per (currency, base) and upsert it; `as_of` doubles as the "last updated" date
 * MC3 surfaces. The unique index `uq_rates_currency_asof` is satisfied because a
 * currency has a single live row here.
 * ============================================================================
 */
import { randomUUID } from 'node:crypto';
import { and, eq, isNull, inArray } from 'drizzle-orm';
import { rateTable, formatDate, today } from '@miserly/core';
import { appClock } from './clock';
import type { RateTable } from '@miserly/core';
import * as schema from './db/schema';
import type { Db } from './db/client';
import { accountsVisibleTo } from './visibility';
import { baseCurrency } from './settings';
/** Decimal places a rate is stored at (base-per-1-foreign). Six is ample for FX. */
export const RATE_SCALE = 6;

type AppDb = Db['db'];

/** One currency's current rate, as MC3's rate-surface reads it. */
export interface RateRow {
  readonly currency: string;
  /** The human-facing rate value (base per 1 foreign), e.g. 83.5. */
  readonly rate: number;
  readonly scaled: number;
  readonly scale: number;
  /** 'YYYY-MM-DD' the rate was last set (MC3 "updated N days ago"). */
  readonly asOf: string;
}

/**
 * Parse a user-entered rate string ("83.5", "83.456789") into an exact scaled
 * integer at `RATE_SCALE`, WITHOUT floating point (string math only, so no
 * drift). Throws on a non-positive or malformed value. Extra decimal places
 * beyond the scale are rejected rather than silently truncated.
 */
export function parseRateToScaled(input: string): { scaled: number; scale: number } {
  const trimmed = input.trim();
  const m = /^(\d+)(?:\.(\d+))?$/u.exec(trimmed);
  // These three reach the screen under Settings' rate field (C7): plain words, no function name.
  if (!m) throw new Error('Enter a rate like 83.10');
  const whole = m[1]!;
  const frac = m[2] ?? '';
  if (frac.length > RATE_SCALE) {
    throw new Error(`Use at most ${RATE_SCALE} decimal places`);
  }
  const digits = whole + frac.padEnd(RATE_SCALE, '0');
  const scaled = Number(BigInt(digits)); // digits has fixed magnitude; exact
  if (!Number.isSafeInteger(scaled) || scaled <= 0) {
    throw new Error('Enter a rate above 0');
  }
  return { scaled, scale: RATE_SCALE };
}

/** Turn a stored scaled integer back into a display number (base per 1 foreign). */
/**
 * MC2's linkage rate from a transfer's two amounts (positive paise, each native to its own leg):
 * destination per 1 source, rounded half away from zero in BigInt (no float drift). A rate below
 * 1 (rupees into dollars, 0.011833…) keeps 10 places: at 6 it kept 4 significant digits. Both
 * amounts are the facts (the two statements); the rate follows from them (item 2.5).
 */
export function linkageRateFrom(sourcePaise: number, destPaise: number): { scaled: number; scale: number } {
  const scale = destPaise < sourcePaise ? 10 : RATE_SCALE;
  const num = BigInt(destPaise) * 10n ** BigInt(scale);
  const den = BigInt(sourcePaise);
  const q = num / den;
  const scaled = Number((num % den) * 2n >= den ? q + 1n : q);
  if (!Number.isSafeInteger(scaled) || scaled <= 0) throw new Error('linkageRateFrom: rate out of range');
  return { scaled, scale };
}

export function scaledToRate(scaled: number, scale: number): number {
  return scaled / 10 ** scale;
}

/**
 * Load the global aggregation `RateTable` (the instance's base + every currency's
 * current rate in it). Rates are per-currency and shared across all accounts, so this is not
 * viewer-scoped — the same rate values every screen through the one `toBase`.
 */
export function loadRateTable(db: AppDb): RateTable {
  const base = baseCurrency(db);
  const rows = db
    .select()
    .from(schema.rates)
    .where(and(eq(schema.rates.baseCurrency, base), isNull(schema.rates.deletedAt)))
    .all();
  return rateTable(
    base,
    rows.map((r) => [r.currency, { scaled: r.rateScaled, scale: r.scale }] as const),
  );
}

/** All current rate rows (for the MC3 rate-management surface), sorted by currency. */
export function listRates(db: AppDb): RateRow[] {
  const rows = db
    .select()
    .from(schema.rates)
    .where(and(eq(schema.rates.baseCurrency, baseCurrency(db)), isNull(schema.rates.deletedAt)))
    .all();
  return rows
    .map((r) => ({
      currency: r.currency,
      rate: scaledToRate(r.rateScaled, r.scale),
      scaled: r.rateScaled,
      scale: r.scale,
      asOf: r.asOf,
    }))
    .sort((a, b) => a.currency.localeCompare(b.currency));
}

/**
 * Upsert the single current rate for `currency` (base per 1 foreign). Sets
 * `as_of` to today (the "last updated" date). Rejects the base currency (always 1)
 * and a non-positive rate. Returns the stored representation.
 */
export function setRate(
  database: Db,
  currency: string,
  scaledRate: { scaled: number; scale: number },
): { scaled: number; scale: number; asOf: string } {
  const { db } = database;
  const code = currency.trim().toUpperCase();
  // An ISO 4217 code is three letters; any other text added rows without end.
  if (!/^[A-Z]{3}$/u.test(code)) throw new Error('rates: a currency is three letters, A to Z');
  const base = baseCurrency(db);
  if (code === base) throw new Error(`rates: the base currency (${base}) is always 1`);
  if (!Number.isSafeInteger(scaledRate.scaled) || scaledRate.scaled <= 0) {
    throw new Error('rates: rate must be a positive scaled integer');
  }
  const asOf = formatDate(today(appClock()));
  const nowIso = new Date().toISOString();

  const existing = db
    .select({ id: schema.rates.id })
    .from(schema.rates)
    .where(
      and(
        eq(schema.rates.currency, code),
        eq(schema.rates.baseCurrency, base),
        isNull(schema.rates.deletedAt),
      ),
    )
    .get();

  if (existing) {
    db.update(schema.rates)
      .set({ rateScaled: scaledRate.scaled, scale: scaledRate.scale, asOf, updatedAt: nowIso })
      .where(eq(schema.rates.id, existing.id))
      .run();
  } else {
    db.insert(schema.rates)
      .values({
        id: randomUUID(),
        currency: code,
        baseCurrency: base,
        rateScaled: scaledRate.scaled,
        scale: scaledRate.scale,
        asOf,
        createdAt: nowIso,
        updatedAt: nowIso,
      })
      .run();
  }
  return { scaled: scaledRate.scaled, scale: scaledRate.scale, asOf };
}

/**
 * The distinct FOREIGN currencies among the viewer's VISIBLE accounts — open or
 * historically-open (D3 counts closed accounts), so a closed USD account still
 * lists its currency for the rate surface. Visibility-gated (P0): a currency
 * only surfaces because the viewer holds an account in it. Excludes the base (so
 * rupees are listed when the base is another currency).
 */
export async function activeForeignCurrencies(db: AppDb, userId: string): Promise<string[]> {
  const visibleIds = await accountsVisibleTo(db, userId);
  if (visibleIds.length === 0) return [];
  const base = baseCurrency(db);
  const rows = db
    .selectDistinct({ currency: schema.accounts.currency })
    .from(schema.accounts)
    .where(and(inArray(schema.accounts.id, visibleIds), isNull(schema.accounts.deletedAt)))
    .all();
  return rows
    .map((r) => r.currency)
    .filter((c) => c !== base)
    .sort((a, b) => a.localeCompare(b));
}
