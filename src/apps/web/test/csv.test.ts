import { describe, expect, it } from 'vitest';
import { toCsv, rupees } from '$lib/register/csv';

// ACTUAL-PARITY #10: the export opens in Excel as typed, and a payee can't become a formula.
describe('CSV export', () => {
	it('quotes, escapes and guards formulas; numbers stay numbers', () => {
		const out = toCsv([
			['Date', 'Payee', 'Amount'],
			['2026-10-15', 'Swiggy, Koramangala', rupees(-45000)],
			['2026-10-15', '=HYPERLINK("x")', rupees(12050)],
			['2026-10-15', 'Say "hi"', null]
		]);
		expect(out.startsWith('﻿')).toBe(true);
		expect(out.split('\r\n')).toEqual([
			'﻿Date,Payee,Amount',
			'2026-10-15,"Swiggy, Koramangala",-450',
			`2026-10-15,"'=HYPERLINK(""x"")",120.5`,
			'2026-10-15,"Say ""hi""",',
			''
		]);
	});
});
