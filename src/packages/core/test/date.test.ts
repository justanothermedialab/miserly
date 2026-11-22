import { describe, expect, it } from 'vitest';
import { compareDates, datesEqual, formatDate, isTimeZone, parseDate, systemClock, today } from '../src/date.js';
import type { Clock, PlainDate } from '../src/date.js';

describe('date: parse/format/compare round-trip', () => {
  it('parses and formats back to the same ISO string', () => {
    const iso = '2024-03-17';
    const parsed = parseDate(iso);
    expect(formatDate(parsed)).toBe(iso);
  });

  it('compareDates orders chronologically', () => {
    const early = parseDate('2024-01-01');
    const late = parseDate('2024-12-31');
    expect(compareDates(early, late)).toBe(-1);
    expect(compareDates(late, early)).toBe(1);
    expect(compareDates(early, early)).toBe(0);
  });

  it('datesEqual matches same calendar date', () => {
    const a = parseDate('2024-06-01');
    const b = parseDate('2024-06-01');
    const c = parseDate('2024-06-02');
    expect(datesEqual(a, b)).toBe(true);
    expect(datesEqual(a, c)).toBe(false);
  });

  it('throws on malformed input', () => {
    expect(() => parseDate('not-a-date')).toThrow();
  });
});

describe('date: injected Clock (no ambient Temporal.Now in engine logic)', () => {
  it('today() returns exactly what the injected clock provides', () => {
    const fixed: PlainDate = parseDate('2026-07-11');
    const fakeClock: Clock = { today: () => fixed };
    expect(today(fakeClock).equals(fixed)).toBe(true);
  });
});

// A hosted server runs on UTC; "today" must be the viewer's calendar day.
describe('date: systemClock in a time zone', () => {
  it('reads today in the given zone (UTC+14 and UTC-12 are always on different days)', () => {
    const east = systemClock('Pacific/Kiritimati').today();
    const west = systemClock('Etc/GMT+12').today();
    expect(compareDates(east, west)).toBe(1);
  });

  it('knows real IANA zones and rejects junk', () => {
    expect(isTimeZone('Asia/Kolkata')).toBe(true);
    expect(isTimeZone('Not/AZone')).toBe(false);
    expect(isTimeZone('')).toBe(false);
  });
});
