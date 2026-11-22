/**
 * The savings rate on Income and spending (R3 RD16): net over income, for a month and for the
 * range. One rule for the headline, the month table and the CSV, so they never disagree.
 * Descriptive arithmetic on recorded figures: no colour, no judgement.
 */
import { MINUS } from '$lib/format';

/** The en dash the app shows where a figure can't be worked out (as in the register). */
export const NO_RATE = '–';

/** Net over income; null without income to divide by (none, or reversals beyond it). */
export function savingsRate(incomePaise: number, netPaise: number): number | null {
	return incomePaise > 0 ? netPaise / incomePaise : null;
}

/** The rate in tenths of a percent, rounded once for the screen and the CSV alike. */
function tenths(incomePaise: number, netPaise: number): number | null {
	if (incomePaise <= 0) return null;
	return Math.round((netPaise * 1000) / incomePaise) || 0; // `|| 0`: no minus on a zero
}

/** "72.0%", "−12.5%", or the en dash. */
export function savingsRateText(incomePaise: number, netPaise: number): string {
	const t = tenths(incomePaise, netPaise);
	if (t === null) return NO_RATE;
	return `${t < 0 ? MINUS : ''}${(Math.abs(t) / 10).toFixed(1)}%`;
}

/** The CSV's plain number (72, −12.5), or null for an empty cell. */
export function savingsRateCsv(incomePaise: number, netPaise: number): number | null {
	const t = tenths(incomePaise, netPaise);
	return t === null ? null : t / 10;
}
