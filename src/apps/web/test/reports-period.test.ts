/**
 * reports-period.test.ts — the R1 preset -> concrete-range resolver (period.ts).
 * ============================================================================
 * Proves the two failure-case magnets period.ts calls out, plus the rest of
 * the preset table:
 *   - INDIA FY = Apr 1 - Mar 31, NEVER Jan-Dec; "This FY" is the FY containing
 *     `today` (asserted in both a Jun-today and a Feb-today case).
 *   - AS-OF-TODAY: live "to-date" presets never resolve `to` past `today`.
 *   - `ytd` (calendar) vs `fytd` (India FY) genuinely differ (Jan 1 vs Apr 1).
 *   - `all` clamps `from` to `earliest`, and clamps further to `today` when
 *     `earliest` is (nonsensically) in the future.
 *   - `custom` passes a valid range through unclamped; an inverted range throws.
 * ============================================================================
 */
import { describe, expect, it } from 'vitest';
import { parseDate } from '@miserly/core';
import { resolvePeriod, presetLabel, PRESETS, type Preset } from '../src/lib/reports/period';

describe('resolvePeriod — thisMonth', () => {
	it('is month-to-date (1st -> today), not the full future month', () => {
		const p = resolvePeriod('thisMonth', parseDate('2026-08-15'));
		expect(p.from).toBe('2026-08-01');
		expect(p.to).toBe('2026-08-15'); // NOT 2026-08-31
	});
});

describe('resolvePeriod — lastMonth', () => {
	it('is the full previous month after a 31-day month', () => {
		// today in Aug (31 days) -> lastMonth = July (31 days) in full.
		const p = resolvePeriod('lastMonth', parseDate('2026-08-15'));
		expect(p.from).toBe('2026-07-01');
		expect(p.to).toBe('2026-07-31');
	});

	it('is the full previous month after February, leap year (29 days)', () => {
		const p = resolvePeriod('lastMonth', parseDate('2024-03-15'));
		expect(p.from).toBe('2024-02-01');
		expect(p.to).toBe('2024-02-29'); // 2024 is a leap year
	});

	it('is the full previous month after February, non-leap year (28 days)', () => {
		const p = resolvePeriod('lastMonth', parseDate('2026-03-15'));
		expect(p.from).toBe('2026-02-01');
		expect(p.to).toBe('2026-02-28');
	});
});

describe('resolvePeriod — thisFY (India FY, Apr 1 - Mar 31, containing today)', () => {
	it('in June resolves to the FY that started this April', () => {
		const p = resolvePeriod('thisFY', parseDate('2026-06-10'));
		expect(p.from).toBe('2026-04-01');
		expect(p.to).toBe('2027-03-31');
	});

	it('in February resolves to the FY that started LAST April (not this Jan)', () => {
		const p = resolvePeriod('thisFY', parseDate('2026-02-10'));
		expect(p.from).toBe('2025-04-01');
		expect(p.to).toBe('2026-03-31');
	});

	it('is never a Jan-Dec calendar-year window, across every month of the year', () => {
		for (let month = 1; month <= 12; month++) {
			const today = parseDate('2026-01-01').with({ month, day: 10 });
			const p = resolvePeriod('thisFY', today);
			expect(p.from.slice(5, 7)).toBe('04'); // always starts in April
			expect(p.to.slice(5, 7)).toBe('03'); // always ends in March
			expect(p.from.slice(0, 4)).not.toBe(p.to.slice(0, 4)); // spans two calendar years
		}
	});
});

describe('resolvePeriod — lastFY', () => {
	it('is the prior Apr-Mar year when today is mid-FY (June)', () => {
		const p = resolvePeriod('lastFY', parseDate('2026-06-10'));
		expect(p.from).toBe('2025-04-01');
		expect(p.to).toBe('2026-03-31');
	});

	it('is the prior Apr-Mar year when today is Jan-Mar (still in the FY that started last April)', () => {
		const p = resolvePeriod('lastFY', parseDate('2026-02-10'));
		expect(p.from).toBe('2024-04-01');
		expect(p.to).toBe('2025-03-31');
	});
});

describe('resolvePeriod — ytd vs fytd', () => {
	it('ytd is calendar Jan 1 -> today', () => {
		const p = resolvePeriod('ytd', parseDate('2026-06-10'));
		expect(p.from).toBe('2026-01-01');
		expect(p.to).toBe('2026-06-10');
	});

	it('fytd is India FY Apr 1 (of the current FY) -> today', () => {
		const p = resolvePeriod('fytd', parseDate('2026-06-10'));
		expect(p.from).toBe('2026-04-01');
		expect(p.to).toBe('2026-06-10');
	});

	it('ytd and fytd genuinely differ (e.g. in June, Jan 1 vs Apr 1)', () => {
		const today = parseDate('2026-06-10');
		const ytd = resolvePeriod('ytd', today);
		const fytd = resolvePeriod('fytd', today);
		expect(ytd.from).not.toBe(fytd.from);
		expect(ytd.to).toBe(fytd.to); // both run to today
	});
});

describe('resolvePeriod — all', () => {
	it('runs from the earliest activity date to today when earliest is in the past', () => {
		const p = resolvePeriod('all', parseDate('2026-08-15'), { earliest: '2022-03-01' });
		expect(p.from).toBe('2022-03-01');
		expect(p.to).toBe('2026-08-15');
	});

	it('clamps from to today when earliest is (nonsensically) in the future', () => {
		const p = resolvePeriod('all', parseDate('2026-08-15'), { earliest: '2030-01-01' });
		expect(p.from).toBe('2026-08-15');
		expect(p.to).toBe('2026-08-15');
	});

	it('falls back to a floor when no earliest is given (no activity yet)', () => {
		const p = resolvePeriod('all', parseDate('2026-08-15'));
		expect(p.from).toBe('1900-01-01');
		expect(p.to).toBe('2026-08-15');
	});
});

describe('resolvePeriod — custom', () => {
	it('passes a valid range through unchanged', () => {
		const p = resolvePeriod('custom', parseDate('2026-08-15'), { custom: { from: '2026-01-01', to: '2026-01-31' } });
		expect(p.from).toBe('2026-01-01');
		expect(p.to).toBe('2026-01-31');
	});

	it('passes a valid range through even when it extends past today (unclamped, per the service comment)', () => {
		const p = resolvePeriod('custom', parseDate('2026-08-15'), { custom: { from: '2026-01-01', to: '2030-01-01' } });
		expect(p.to).toBe('2030-01-01');
	});

	it('throws when the end is before the start', () => {
		expect(() =>
			resolvePeriod('custom', parseDate('2026-08-15'), { custom: { from: '2026-02-01', to: '2026-01-01' } })
		).toThrow();
	});

	it('throws when no custom range is supplied at all', () => {
		expect(() => resolvePeriod('custom', parseDate('2026-08-15'))).toThrow();
	});
});

describe('resolvePeriod — as-of-today clamp', () => {
	// thisFY is the one preset that deliberately resolves an UNCLAMPED full FY
	// window (the service clamps at query time, not here) — excluded here along
	// with `custom` (a static, user-chosen window, not a "live" to-date preset).
	const LIVE_PRESETS: Preset[] = PRESETS.filter((p) => p !== 'thisFY' && p !== 'custom');

	it.each(LIVE_PRESETS)('%s never resolves `to` past today', (preset) => {
		const today = parseDate('2026-08-15');
		const p = resolvePeriod(preset, today, { earliest: '2020-01-01', custom: { from: '2026-01-01', to: '2026-01-31' } });
		expect(p.to <= '2026-08-15').toBe(true);
	});
});

describe('presetLabel', () => {
	it('has a human label for every preset, including custom', () => {
		for (const preset of PRESETS) {
			expect(presetLabel(preset).length).toBeGreaterThan(0);
		}
	});
});
