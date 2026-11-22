/**
 * The savings rate on Income and spending (R3 RD16): net over income, one decimal, an en dash
 * when there is no income to divide by. One rule for the headline, the table and the CSV.
 */
import { describe, expect, it } from 'vitest';
import { savingsRate, savingsRateText, savingsRateCsv } from '../src/lib/reports/savings-rate';

describe('savings rate (R3 RD16)', () => {
	it('is net over income, with one decimal', () => {
		expect(savingsRate(100_000, 72_000)).toBe(0.72);
		expect(savingsRateText(100_000, 72_000)).toBe('72.0%');
		expect(savingsRateText(300_000, 100_000)).toBe('33.3%');
		expect(savingsRateCsv(300_000, 100_000)).toBe(33.3);
	});

	it('a deficit is a negative rate with the minus sign, never a colour', () => {
		expect(savingsRateText(400_000, -50_000)).toBe('−12.5%');
		expect(savingsRateCsv(400_000, -50_000)).toBe(-12.5);
		// Rounds to nothing: no minus on a zero.
		expect(savingsRateText(1_000_000, -10)).toBe('0.0%');
	});

	it('the screen and the CSV round the same way', () => {
		// 0.12345 → 12.3; 0.00125 (x.x5 in binary) → both say the same.
		for (const [inc, net] of [
			[100_000, 12_345],
			[80_000, 100],
			[160_000, 2]
		] as const) {
			expect(savingsRateText(inc, net)).toBe(`${savingsRateCsv(inc, net)!.toFixed(1)}%`);
		}
	});

	it('no income (zero, or reversals beyond it) is an en dash on screen and empty in the CSV', () => {
		expect(savingsRate(0, -40_000)).toBe(null);
		expect(savingsRateText(0, -40_000)).toBe('–');
		expect(savingsRateText(0, 0)).toBe('–');
		expect(savingsRateCsv(0, 0)).toBe(null);
		expect(savingsRateText(-5_000, -45_000)).toBe('–');
	});
});
