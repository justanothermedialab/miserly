/**
 * settings.ts — the M11 settings store (SET1 per-user prefs + H1 instance name).
 * ============================================================================
 * Two scopes, one small service (SET1 Circle addendum: settings split into
 * INSTANCE-wide vs PER-USER):
 *   - PER-USER display preferences (`user_preferences`): the number system, the
 *     long/compact default, foreign-grouping mode, theme. DISPLAY-ONLY — reading
 *     or writing these never touches a stored amount, rate or derived value
 *     (SET1 "display-only" AC), so there is no migration and no invalidation.
 *   - INSTANCE-wide singletons (`instance_settings`): the Circle display name
 *     (H1), and the currency for totals and the year start, both chosen once at
 *     setup (MC1 RD2 amended, R1; changing them comes later). A named
 *     key→value store, NOT a `circle` entity — the Circle IS the instance (H1 RD5).
 *
 * The number system's FIRST-RUN default (SET1 RD2, amended 2026-10-02): an INR
 * base currency ⇒ Indian (lakh/crore); otherwise DERIVED FROM DEVICE LOCALE — a
 * South-Asian `Accept-Language` (en-IN, hi, …) ⇒ Indian, else Western. Always
 * user-changeable afterwards. The DB column default ('indian') only ever applies to
 * an explicitly-written row; an ABSENT row is resolved here through
 * `defaultUserPrefs(localeHint, baseCurrency)` so a brand-new user gets the right
 * grouping before they ever open Settings.
 *
 * R8 async-service convention: every DB-touching export is async (better-sqlite3
 * is sync underneath) so route code has one calling shape.
 * ============================================================================
 */
import { eq } from 'drizzle-orm';
import * as schema from './db/schema';
import type { Db } from './db/client';
import { ACCENTS, defaultUserPrefs, normalizeAccent, type UserPrefs } from '../prefs';
import {
  DEFAULT_BASE_CURRENCY,
  DEFAULT_YEAR_START,
  isBaseCurrencyChoice,
  parseYearStart,
  type YearStartMonth,
} from '../currencies';

type AppDb = Db['db'];

export type { UserPrefs } from '../prefs';

const NUMBER_SYSTEMS: ReadonlySet<string> = new Set(['indian', 'western']);
const FOREIGN_GROUPINGS: ReadonlySet<string> = new Set(['preference', 'native-locale']);
const THEMES: ReadonlySet<string> = new Set(['system', 'light', 'dark', 'black']);

/** Instance-setting keys (typed so callers can't fat-finger a key). */
export const INSTANCE_KEYS = {
  circleName: 'circle.name',
  /** The currency totals are in, chosen at setup (MC1 RD2 amended); absent = rupees. */
  baseCurrency: 'circle.base_currency',
  /** The month the financial year starts in, '1' or '4', chosen at setup (R1); absent = April. */
  yearStart: 'circle.year_start',
} as const;

/** One instance setting, read synchronously (better-sqlite3), for the per-request readers below. */
function readInstanceSetting(db: AppDb, key: string): string | null {
  return (
    db
      .select({ value: schema.instanceSettings.value })
      .from(schema.instanceSettings)
      .where(eq(schema.instanceSettings.key, key))
      .get()?.value ?? null
  );
}

/**
 * The instance's base currency, read from `settings` on each call (so per request): the one
 * chosen at setup, or rupees for an instance set up before the choice (no row is ever back-filled,
 * so its figures don't change). Sync, unlike the R8 convention, because the aggregates that need
 * it (`loadRateTable`, the report folds) are sync; it is one indexed single-row read.
 */
export function baseCurrency(db: AppDb): string {
  const v = readInstanceSetting(db, INSTANCE_KEYS.baseCurrency);
  return v !== null && isBaseCurrencyChoice(v) ? v : DEFAULT_BASE_CURRENCY;
}

/** The month the instance's financial year starts in (1 or 4): the setup choice, else April. */
export function yearStartMonth(db: AppDb): YearStartMonth {
  return parseYearStart(readInstanceSetting(db, INSTANCE_KEYS.yearStart)) ?? DEFAULT_YEAR_START;
}

/**
 * The viewer's resolved display preferences. Returns the stored row if present,
 * otherwise the first-run defaults (INR base ⇒ Indian, else locale-derived), so a
 * new user's very first render is already right, before they touch Settings.
 */
export async function getUserPrefs(
  db: AppDb,
  userId: string,
  localeHint?: string | null,
  base?: string,
): Promise<UserPrefs> {
  const row = db
    .select()
    .from(schema.userPreferences)
    .where(eq(schema.userPreferences.userId, userId))
    .get();
  if (!row) return defaultUserPrefs(localeHint, base ?? baseCurrency(db));
  return {
    numberSystem: row.numberSystem,
    compact: row.compact,
    foreignGrouping: row.foreignGrouping,
    theme: row.theme,
    accent: normalizeAccent(row.accent),
  };
}

/**
 * Upsert one or more of the viewer's preferences (partial patch). Unknown enum
 * values are rejected (defense — the form should only ever submit valid ones).
 * A first write materialises the row from the current defaults + the patch.
 */
export async function setUserPrefs(
  db: AppDb,
  userId: string,
  patch: Partial<UserPrefs>,
  localeHint?: string | null,
): Promise<UserPrefs> {
  if (patch.numberSystem !== undefined && !NUMBER_SYSTEMS.has(patch.numberSystem)) {
    throw new Error(`setUserPrefs: invalid numberSystem '${patch.numberSystem}'`);
  }
  if (patch.foreignGrouping !== undefined && !FOREIGN_GROUPINGS.has(patch.foreignGrouping)) {
    throw new Error(`setUserPrefs: invalid foreignGrouping '${patch.foreignGrouping}'`);
  }
  if (patch.theme !== undefined && !THEMES.has(patch.theme)) {
    throw new Error(`setUserPrefs: invalid theme '${patch.theme}'`);
  }
  if (patch.accent !== undefined && !(ACCENTS as readonly string[]).includes(patch.accent)) {
    throw new Error(`setUserPrefs: invalid accent '${patch.accent}'`);
  }

  const current = await getUserPrefs(db, userId, localeHint);
  const next: UserPrefs = { ...current, ...patch };
  const nowIso = new Date().toISOString();

  db.insert(schema.userPreferences)
    .values({
      userId,
      numberSystem: next.numberSystem,
      compact: next.compact,
      foreignGrouping: next.foreignGrouping,
      theme: next.theme,
      accent: next.accent,
      updatedAt: nowIso,
    })
    .onConflictDoUpdate({
      target: schema.userPreferences.userId,
      set: {
        numberSystem: next.numberSystem,
        compact: next.compact,
        foreignGrouping: next.foreignGrouping,
        theme: next.theme,
        accent: next.accent,
        updatedAt: nowIso,
      },
    })
    .run();

  return next;
}

// ── Instance-wide settings ──────────────────────────────────────────────────

/** Raw read of one instance-wide setting; `null` when unset. */
export async function getInstanceSetting(db: AppDb, key: string): Promise<string | null> {
  const row = db
    .select({ value: schema.instanceSettings.value })
    .from(schema.instanceSettings)
    .where(eq(schema.instanceSettings.key, key))
    .get();
  return row?.value ?? null;
}

/** Upsert one instance-wide setting. */
export async function setInstanceSetting(db: AppDb, key: string, value: string): Promise<void> {
  const nowIso = new Date().toISOString();
  db.insert(schema.instanceSettings)
    .values({ key, value, updatedAt: nowIso })
    .onConflictDoUpdate({
      target: schema.instanceSettings.key,
      set: { value, updatedAt: nowIso },
    })
    .run();
}

/** The Circle's display name (H1), or `null` if never set. */
export async function getCircleName(db: AppDb): Promise<string | null> {
  return getInstanceSetting(db, INSTANCE_KEYS.circleName);
}

/**
 * Set (or clear) the Circle's display name. A blank/whitespace value removes it
 * (the name is optional free text — H1: it merely labels the instance). Trimmed.
 */
export async function setCircleName(db: AppDb, name: string): Promise<void> {
  const trimmed = name.trim();
  if (trimmed === '') {
    db.delete(schema.instanceSettings)
      .where(eq(schema.instanceSettings.key, INSTANCE_KEYS.circleName))
      .run();
    return;
  }
  await setInstanceSetting(db, INSTANCE_KEYS.circleName, trimmed);
}
