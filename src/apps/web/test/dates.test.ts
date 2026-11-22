/**
 * dates.test.ts — the one display-date format (DL-06): `6 Aug 2026`, compact
 * `06 Aug` (year appended outside the current year), timestamps use the date part.
 */
import { describe, expect, it } from 'vitest';
import { formatDate, formatDateShort, parseDate } from '../src/lib/dates';

describe('formatDate', () => {
	it('renders day month-abbrev year with no leading zero', () => {
		expect(formatDate('2026-08-06')).toBe('6 Aug 2026');
		expect(formatDate('2025-12-31')).toBe('31 Dec 2025');
	});
	it('uses only the date part of a timestamp', () => {
		expect(formatDate('2026-10-02T09:15:00.000Z')).toBe('2 Oct 2026');
	});
	it('returns unparseable input unchanged', () => {
		expect(formatDate('')).toBe('');
		expect(formatDate('soon')).toBe('soon');
	});
});

describe('formatDateShort', () => {
	it('drops the year inside the current year, zero-pads the day', () => {
		expect(formatDateShort('2026-08-06', '2026-10-02')).toBe('06 Aug');
	});
	it('keeps the year outside the current year', () => {
		expect(formatDateShort('2025-08-06', '2026-10-02')).toBe('06 Aug 25');
		expect(formatDateShort('2027-01-01', '2026-10-02')).toBe('01 Jan 27');
	});
});

describe('parseDate (DateField typed input, day-first)', () => {
	const today = '2026-10-02';
	it('accepts the display format, short forms and ISO', () => {
		expect(parseDate('6 Aug 2026', today)).toBe('2026-08-06');
		expect(parseDate('6 aug', today)).toBe('2026-08-06');
		expect(parseDate('06/08/2026', today)).toBe('2026-08-06');
		expect(parseDate('6-8-26', today)).toBe('2026-08-06');
		expect(parseDate('6.8', today)).toBe('2026-08-06');
		expect(parseDate('2026-08-06', today)).toBe('2026-08-06');
		expect(parseDate('29 February 2028', today)).toBe('2028-02-29');
	});
	it('rejects non-dates', () => {
		expect(parseDate('', today)).toBeNull();
		expect(parseDate('31/02/2026', today)).toBeNull();
		expect(parseDate('6 Foo 2026', today)).toBeNull();
		expect(parseDate('yesterday', today)).toBeNull();
	});
});
