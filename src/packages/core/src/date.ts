/**
 * date.ts — a small, typed adapter over `Temporal.PlainDate`.
 *
 * Node 24 does not yet expose `Temporal` natively, so we depend on the
 * `temporal-polyfill` package. The engine only ever deals in calendar dates
 * (no time-of-day, no timezone) via `Temporal.PlainDate`.
 *
 * The engine must stay pure and deterministic: nothing in this module (or
 * anywhere else in packages/core) reads the system clock directly. Callers
 * that need "today" must inject a `Clock`.
 */
import { Temporal } from 'temporal-polyfill';

/** Re-exported type alias so callers don't need to import `temporal-polyfill` directly. */
export type PlainDate = Temporal.PlainDate;

/** A source of "today", injected by the caller so the engine stays deterministic/testable. */
export interface Clock {
  today(): PlainDate;
}

/**
 * A `Clock` backed by the real system clock. Intended for use at the app's edge, not in tests.
 * `timeZone` (an IANA name) says whose calendar "today" is: a hosted server runs on UTC, but
 * the person using it lives in theirs. Omitted, it is the process's own zone.
 */
export function systemClock(timeZone?: string): Clock {
  return {
    today(): PlainDate {
      return timeZone ? Temporal.Now.plainDateISO(timeZone) : Temporal.Now.plainDateISO();
    },
  };
}

/** True if `timeZone` is an IANA zone the runtime knows (so `systemClock(timeZone)` won't throw). */
export function isTimeZone(timeZone: string): boolean {
  try {
    Temporal.Now.plainDateISO(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** Parse a `'YYYY-MM-DD'` string into a `PlainDate`. Throws on malformed input. */
export function parseDate(iso: string): PlainDate {
  return Temporal.PlainDate.from(iso);
}

/** Format a `PlainDate` back to `'YYYY-MM-DD'`. */
export function formatDate(date: PlainDate): string {
  return date.toString();
}

/** −1 if a < b, 0 if equal, 1 if a > b. */
export function compareDates(a: PlainDate, b: PlainDate): -1 | 0 | 1 {
  const result = Temporal.PlainDate.compare(a, b);
  if (result < 0) return -1;
  if (result > 0) return 1;
  return 0;
}

export function datesEqual(a: PlainDate, b: PlainDate): boolean {
  return a.equals(b);
}

/** Convenience: "today" per an injected clock. */
export function today(clock: Clock): PlainDate {
  return clock.today();
}
