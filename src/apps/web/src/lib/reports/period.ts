/**
 * period.ts — the R1 preset → concrete-range resolver (pure, no DB).
 * ============================================================================
 * R1 locks ONE shared period model driving every report: a handful of presets
 * users return to + a custom static range, resolved against "today". This is the
 * single function that maps a preset to an inclusive `[from, to]` calendar-date
 * window (R1 Operational: "Preset → concrete-range resolver, one function").
 *
 * Two failure-case magnets R1 calls out, handled HERE:
 *   1. THE YEAR START is the instance's, chosen at setup (R1): April (India's
 *      Apr 1 – Mar 31, the default and every instance set up before the choice) or
 *      January. "This FY" is the year CONTAINING today: with April, in Jun 2026 →
 *      Apr 2026–Mar 2027 and in Feb 2026 → Apr 2025–Mar 2026; with January, the
 *      calendar year. PPF's own year is not this one (lib/modules.ts, the law's April).
 *   2. AS-OF-TODAY: live "to-date" presets never extend past today. Month/quarter/
 *      FY presets that would run into the future resolve their upper bound to
 *      today (R1 RD2: "This month" = 1st → today, month-to-date). The service
 *      also clamps at query time (defense in depth), so a stale `to` can never
 *      leak future-dated rows.
 *
 * Pure + deterministic: `today` is injected as a `PlainDate` (the route passes
 * `today(systemClock())`), so every branch is unit-testable without a clock.
 * Dates are 'YYYY-MM-DD' strings on the wire (what the ledger stores + what the
 * URL carries); Temporal.PlainDate is used only for the arithmetic here.
 * ============================================================================
 */
import { parseDate, formatDate, compareDates } from '@miserly/core';
import type { PlainDate } from '@miserly/core';
import { DEFAULT_YEAR_START, type YearStartMonth } from '../currencies';
import { nearestRealDate } from '../dates';

/** The live presets + `custom`. `fytd` = FY-to-date (Apr 1 → today), distinct from `ytd` (Jan 1 → today). */
export type Preset =
  | 'last3m'
  | 'last6m'
  | 'last12m'
  | 'thisMonth'
  | 'lastMonth'
  | 'thisQuarter'
  | 'lastQuarter'
  | 'thisFY'
  | 'lastFY'
  | 'ytd'
  | 'fytd'
  | 'all'
  | 'custom';

export const PRESETS: readonly Preset[] = [
  'last3m',
  'last6m',
  'last12m',
  'thisMonth',
  'lastMonth',
  'thisQuarter',
  'lastQuarter',
  'thisFY',
  'lastFY',
  'ytd',
  'fytd',
  'all',
  'custom',
];

// Spelled out for members: "financial year", not "FY".
const PRESET_LABELS: Record<Preset, string> = {
  last3m: 'Last 3 months',
  last6m: 'Last 6 months',
  last12m: 'Last 12 months',
  thisMonth: 'This month',
  lastMonth: 'Last month',
  thisQuarter: 'This quarter',
  lastQuarter: 'Last quarter',
  thisFY: 'This financial year',
  lastFY: 'Last financial year',
  ytd: 'Year to date (from Jan)',
  fytd: 'Financial year to date (from Apr)',
  all: 'All time',
  custom: 'Custom',
};

// A January year is the calendar year, so it is named plainly; its "to date" is `ytd`'s.
const JANUARY_LABELS: Partial<Record<Preset, string>> = {
  thisFY: 'This year',
  lastFY: 'Last year',
  fytd: PRESET_LABELS.ytd,
};

export function presetLabel(preset: Preset, yearStart: YearStartMonth = DEFAULT_YEAR_START): string {
  return (yearStart === 1 ? JANUARY_LABELS[preset] : undefined) ?? PRESET_LABELS[preset];
}

/** A tooltip for a preset whose span isn't in its name (plain words for members). */
export function presetHint(preset: Preset, yearStart: YearStartMonth = DEFAULT_YEAR_START): string | undefined {
  if (yearStart === 1) return undefined; // "This year" says it
  return preset === 'thisFY' || preset === 'lastFY' ? 'April to March' : undefined;
}

/** The presets a year start offers: a January year has no separate "financial year to date". */
export function presetsFor(list: readonly Preset[], yearStart: YearStartMonth = DEFAULT_YEAR_START): Preset[] {
  return yearStart === 1 ? list.filter((p) => p !== 'fytd') : [...list];
}

/** A resolved reporting window: inclusive `[from, to]` (ISO), plus the preset it came from. */
export interface ResolvedPeriod {
  readonly preset: Preset;
  /** Inclusive lower bound 'YYYY-MM-DD'. */
  readonly from: string;
  /** Inclusive upper bound 'YYYY-MM-DD' (never past `today` for live presets). */
  readonly to: string;
  readonly label: string;
}

export interface ResolveOpts {
  /** Custom range (used only when preset === 'custom'). Both 'YYYY-MM-DD'. */
  readonly custom?: { from: string; to: string };
  /** Earliest activity date for 'all' (from the ledger); defaults to a floor. */
  readonly earliest?: string;
  /** The month the instance's year starts in (setup); April when not given. */
  readonly yearStart?: YearStartMonth;
}

/** The year starting in month `start` (April: India's FY) CONTAINING `d`, as a first-day PlainDate. */
function fyStartOf(d: PlainDate, start: YearStartMonth): PlainDate {
  // With April, Jan–Mar (month 1–3) belong to the year that began the PREVIOUS April.
  const startYear = d.month >= start ? d.year : d.year - 1;
  return d.with({ year: startYear, month: start, day: 1 });
}

/** First day of the calendar quarter containing `d`. */
function quarterStartOf(d: PlainDate): PlainDate {
  const startMonth = Math.floor((d.month - 1) / 3) * 3 + 1;
  return d.with({ month: startMonth, day: 1 });
}

/** Last day of `d`'s month. */
function monthEnd(d: PlainDate): PlainDate {
  return d.with({ day: d.daysInMonth });
}

/** min(a, b) by calendar date — the as-of-today clamp for live upper bounds. */
function earlier(a: PlainDate, b: PlainDate): PlainDate {
  return compareDates(a, b) <= 0 ? a : b;
}

/**
 * Resolve a preset to a concrete inclusive `[from, to]` window against `today`.
 * Live presets are clamped so `to` never exceeds today (R1 as-of-today rule).
 * `custom` passes its fixed window through (validated: end ≥ start). Throws only
 * on an invalid custom range — every live preset always resolves.
 */
export function resolvePeriod(preset: Preset, today: PlainDate, opts: ResolveOpts = {}): ResolvedPeriod {
  const yearStart = opts.yearStart ?? DEFAULT_YEAR_START;
  const label = presetLabel(preset, yearStart);
  const iso = (d: PlainDate): string => formatDate(d);

  switch (preset) {
    case 'last3m':
    case 'last6m':
    case 'last12m': {
      // R1 RD6: the current month to date plus the full months before it, so "Last 6 months"
      // is five full months and this one so far; never a future row.
      const n = preset === 'last3m' ? 3 : preset === 'last6m' ? 6 : 12;
      const start = today.with({ day: 1 }).subtract({ months: n - 1 });
      return { preset, from: iso(start), to: iso(today), label };
    }
    case 'thisMonth': {
      // Month-to-date: 1st → today (R1 RD2), never the full future month.
      return { preset, from: iso(today.with({ day: 1 })), to: iso(today), label };
    }
    case 'lastMonth': {
      const prev = today.subtract({ months: 1 });
      return { preset, from: iso(prev.with({ day: 1 })), to: iso(monthEnd(prev)), label };
    }
    case 'thisQuarter': {
      // Quarter-to-date, consistent with month-to-date live semantics.
      return { preset, from: iso(quarterStartOf(today)), to: iso(today), label };
    }
    case 'lastQuarter': {
      const prevQ = quarterStartOf(today).subtract({ months: 3 });
      const end = quarterStartOf(today).subtract({ days: 1 });
      return { preset, from: iso(prevQ), to: iso(end), label };
    }
    case 'thisFY': {
      // The FULL FY window (Apr 1 – Mar 31) as the RESOLVED label range (R1 alt
      // path shows "1 Apr 2026 – 31 Mar 2027"); the service clamps queries at
      // today so no future data appears. Distinct from `fytd` below.
      const start = fyStartOf(today, yearStart);
      const end = start.add({ years: 1 }).subtract({ days: 1 });
      return { preset, from: iso(start), to: iso(end), label };
    }
    case 'lastFY': {
      const thisStart = fyStartOf(today, yearStart);
      const start = thisStart.subtract({ years: 1 });
      const end = thisStart.subtract({ days: 1 });
      return { preset, from: iso(start), to: iso(end), label };
    }
    case 'ytd': {
      // Calendar year-to-date: Jan 1 → today.
      return { preset, from: iso(today.with({ month: 1, day: 1 })), to: iso(today), label };
    }
    case 'fytd': {
      // FY-to-date: the current year's first day (Apr 1 by default, R1 RD3) → today.
      return { preset, from: iso(fyStartOf(today, yearStart)), to: iso(today), label };
    }
    case 'all': {
      // From the earliest ledger activity (passed by the service) to today; a
      // floor keeps it valid when there is no activity yet.
      const earliest = opts.earliest ?? '1900-01-01';
      // A stored date that isn't a day of the calendar reads as the nearest that is (H2).
      const from = earlier(parseDate(nearestRealDate(earliest)), today); // never after today
      return { preset, from: iso(from), to: iso(today), label };
    }
    case 'custom': {
      const c = opts.custom;
      if (!c) throw new Error('resolvePeriod: custom preset requires a { from, to } range');
      const from = parseDate(c.from);
      const to = parseDate(c.to);
      if (compareDates(to, from) < 0) {
        throw new Error('resolvePeriod: custom range end must be on/after start');
      }
      // Static window passes through UNCLAMPED — a custom future end simply has
      // no data beyond today (the service clamps the query), preserving the
      // user's explicit choice of window in the displayed dates.
      return { preset, from: iso(from), to: iso(to), label };
    }
  }
}

/**
 * The window just before `period`, for "less than the 6 months before" (R2 RD7): the same number
 * of whole months when the window starts on the 1st (a rolling, quarter or FY window), otherwise
 * the same number of days. `label` names it in words.
 */
export function previousPeriod(period: { from: string; to: string }): { from: string; to: string; label: string } {
  const from = parseDate(period.from);
  const to = parseDate(period.to);
  if (from.day === 1) {
    const months = (to.year - from.year) * 12 + (to.month - from.month) + 1;
    const start = from.subtract({ months });
    const end = from.subtract({ days: 1 });
    const label = months === 1 ? 'the month before' : `the ${months} months before`;
    return { from: formatDate(start), to: formatDate(end), label };
  }
  const days = to.since(from).days + 1;
  const start = from.subtract({ days });
  const end = from.subtract({ days: 1 });
  return { from: formatDate(start), to: formatDate(end), label: `the ${days} days before` };
}

