/**
 * format.test.ts — the app-wide number formatter (SET1 groundwork).
 * ============================================================================
 * Proves: Indian long-form grouping incl. the lakh/crore boundaries and
 * negatives; compact K/L/Cr abbreviation; `slicePercents` sums to EXACTLY
 * 100.0% (the D2 failure case) for asymmetric inputs and the empty/zero case.
 * ============================================================================
 */
import { describe, expect, it } from 'vitest';
import {
	formatMoney,
	formatSignedMoney,
	formatMoneyWithCode,
	formatBaseApprox,
	formatPercent,
	slicePercents
} from '../src/lib/format';

describe('formatMoney — Indian long form (default)', () => {
	it('groups small amounts with no separator needed', () => {
		expect(formatMoney(85000)).toBe('₹850.00'); // 850 rupees
	});

	it('groups thousands as 2,2,...,3', () => {
		expect(formatMoney(1234567 * 100)).toBe('₹12,34,567.00');
	});

	it('handles the lakh boundary (1,00,000)', () => {
		expect(formatMoney(100000 * 100)).toBe('₹1,00,000.00');
	});

	it('handles the crore boundary (1,00,00,000)', () => {
		expect(formatMoney(10000000 * 100)).toBe('₹1,00,00,000.00');
	});

	it('handles a value just under 1,000', () => {
		expect(formatMoney(999 * 100)).toBe('₹999.00');
	});

	it('renders negatives with a leading sign before the ₹', () => {
		expect(formatMoney(-1200 * 100)).toBe('−₹1,200.00');
	});

	it('renders zero', () => {
		expect(formatMoney(0)).toBe('₹0.00');
	});

	it('keeps paise as two decimal digits', () => {
		expect(formatMoney(150055)).toBe('₹1,500.55');
	});
});

describe('formatMoney — Indian compact', () => {
	it('shows plain rupees below 1,000', () => {
		expect(formatMoney(85000, { compact: true })).toBe('₹850');
	});

	it('abbreviates thousands as K, dropping a trailing .0', () => {
		expect(formatMoney(12300 * 100, { compact: true })).toBe('₹12.3K');
		expect(formatMoney(12000 * 100, { compact: true })).toBe('₹12K');
	});

	it('abbreviates lakhs as L', () => {
		expect(formatMoney(1234567 * 100, { compact: true })).toBe('₹12.3L');
	});

	it('abbreviates crores as Cr', () => {
		expect(formatMoney(12345678 * 100, { compact: true })).toBe('₹1.2Cr');
	});

	it('keeps the negative sign in compact form', () => {
		expect(formatMoney(-1234567 * 100, { compact: true })).toBe('−₹12.3L');
	});
});

describe('formatMoney — Western sibling', () => {
	it('groups every three digits', () => {
		expect(formatMoney(12345678 * 100, { western: true })).toBe('₹12,345,678.00');
	});

	it('compacts to M/B/K', () => {
		expect(formatMoney(12300 * 100, { western: true, compact: true })).toBe('₹12.3K');
		expect(formatMoney(12300000 * 100, { western: true, compact: true })).toBe('₹12.3M');
		expect(formatMoney(1200000000 * 100, { western: true, compact: true })).toBe('₹1.2B');
	});
});

describe('formatSignedMoney', () => {
	it('adds an explicit + for positive amounts', () => {
		expect(formatSignedMoney(120000)).toBe('+₹1,200.00');
	});

	it('keeps the existing - for negative amounts', () => {
		expect(formatSignedMoney(-120000)).toBe('−₹1,200.00');
	});

	it('shows no sign for zero', () => {
		expect(formatSignedMoney(0)).toBe('₹0.00');
	});
});

describe('formatMoney — foreign currency (MC3)', () => {
	it('defaults to INR when no currency is given (unchanged behavior)', () => {
		expect(formatMoney(123456)).toBe(formatMoney(123456, { currency: 'INR' }));
	});

	it('swaps the symbol for USD but keeps Indian grouping by default', () => {
		expect(formatMoney(1234567 * 100, { currency: 'USD' })).toBe('$12,34,567.00');
	});

	it('renders EUR/GBP/JPY with their own symbols', () => {
		expect(formatMoney(100000, { currency: 'EUR' })).toBe('€1,000.00');
		expect(formatMoney(100000, { currency: 'GBP' })).toBe('£1,000.00');
		expect(formatMoney(100000, { currency: 'JPY' })).toBe('¥1,000.00');
	});

	it('falls back to a spaced code for a currency with no distinct glyph', () => {
		expect(formatMoney(100000, { currency: 'CHF' })).toBe('CHF 1,000.00');
		expect(formatMoney(100000, { currency: 'AED' })).toBe('AED 1,000.00');
	});

	it('falls back to the raw code for an unmapped currency (never a blank glyph)', () => {
		expect(formatMoney(100000, { currency: 'XYZ' })).toBe('XYZ 1,000.00');
	});

	it('respects Western grouping/compaction for a foreign currency too', () => {
		expect(formatMoney(12345678 * 100, { currency: 'USD', western: true })).toBe('$12,345,678.00');
		expect(formatMoney(12300000 * 100, { currency: 'USD', western: true, compact: true })).toBe('$12.3M');
	});

	it('keeps the negative sign before the foreign symbol', () => {
		expect(formatMoney(-120000, { currency: 'USD' })).toBe('−$1,200.00');
	});
});

describe('formatMoneyWithCode', () => {
	it('appends the ISO code after the formatted amount', () => {
		expect(formatMoneyWithCode(100000, 'USD')).toBe('$1,000.00 USD');
	});

	it('works for INR too (rate-surface base row)', () => {
		expect(formatMoneyWithCode(100000, 'INR')).toBe('₹1,000.00 INR');
	});
});

describe('formatBaseApprox', () => {
	it('renders a quiet "≈ ₹X" secondary line, always in INR', () => {
		expect(formatBaseApprox(830000)).toBe('≈ ₹8,300.00');
	});

	it('respects compact/western opts like formatMoney', () => {
		expect(formatBaseApprox(12345678 * 100, { compact: true })).toBe('≈ ₹1.2Cr');
	});
});

describe('formatPercent', () => {
	it('formats a ratio to one decimal', () => {
		expect(formatPercent(0.123)).toBe('12.3%');
	});

	it('keeps the sign for a negative ratio', () => {
		expect(formatPercent(-0.05)).toBe('−5.0%');
	});
});

describe('slicePercents — largest-remainder apportionment', () => {
	it('sums to exactly 100.0 for an asymmetric 3-way split', () => {
		const result = slicePercents([1, 1, 1]);
		const sum = result.reduce((s, p) => s + p, 0);
		expect(Math.round(sum * 10)).toBe(1000);
		// each third rounds to 33.3 with the remainder tenth going to exactly one slice
		expect(result).toEqual([33.4, 33.3, 33.3]);
	});

	it('sums to exactly 100.0 for an awkward 7-way split', () => {
		const amounts = [713, 211, 4, 998, 1, 3120, 57];
		const result = slicePercents(amounts);
		const sum = result.reduce((s, p) => s + p, 0);
		expect(Math.round(sum * 10)).toBe(1000);
	});

	it('sums to exactly 100.0 when one slice dominates', () => {
		const result = slicePercents([999997, 1, 1, 1]);
		const sum = result.reduce((s, p) => s + p, 0);
		expect(Math.round(sum * 10)).toBe(1000);
	});

	it('returns all zeros when the total is zero', () => {
		expect(slicePercents([0, 0, 0])).toEqual([0, 0, 0]);
	});

	it('returns all zeros when the total is negative', () => {
		expect(slicePercents([-5, 2])).toEqual([0, 0]);
	});

	it('returns an empty array for empty input', () => {
		expect(slicePercents([])).toEqual([]);
	});
});
