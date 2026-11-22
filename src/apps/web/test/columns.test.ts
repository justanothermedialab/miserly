/**
 * columns.test.ts — the register's and All transactions' column widths (Fluent's
 * min/ideal Table columns): a text column fits its longest text between its minimum and maximum,
 * an empty one keeps its minimum, and a table too narrow for them squashes the last text column
 * first, never below a minimum.
 */
import { describe, expect, it } from 'vitest';
import { dragWidth, fittedWidths, fitToContainer, parseColsCookie, textWidth, type ColumnSpec } from '../src/lib/register/columns.svelte';

const SPECS: ColumnSpec[] = [
	{ id: 'check', fixed: 40 },
	{ id: 'date', fixed: 84 },
	{ id: 'account', min: 96, max: 280 },
	{ id: 'payee', fill: true, min: 140 },
	{ id: 'category', min: 96, max: 220 },
	{ id: 'notes', min: 80, max: 360 },
	{ id: 'outflow', min: 104, max: 200, squash: false },
	{ id: 'inflow', min: 104, max: 200, squash: false }
];

describe('text widths', () => {
	it('match the font as Edge measured it (14 px Segoe UI Variable Text, Arial where wider)', () => {
		// Edge: Segoe 136.2 / Arial 143.9 for "HDFC (Bank accounts)"; Segoe 129.5 / Arial 132.3.
		expect(textWidth('HDFC (Bank accounts)')).toBeGreaterThanOrEqual(144);
		expect(textWidth('HDFC (Bank accounts)')).toBeLessThan(155);
		expect(textWidth('HDFC (Mutual funds)')).toBeGreaterThanOrEqual(133);
		expect(textWidth('Uncategorized')).toBeGreaterThanOrEqual(90);
	});
});

describe('fitted widths', () => {
	it("Account fits the owner's longest label, an empty Notes keeps its minimum, amounts fit a lakh figure", () => {
		const w = fittedWidths(SPECS, {
			account: ['HDFC (Mutual funds)', 'HDFC (Bank accounts)', 'Apartment'],
			category: ['Uncategorized', 'Transfer', ''],
			notes: ['', ''],
			outflow: ['₹22,46,700.00', '₹444.00', ''],
			inflow: ['']
		});
		// 12 px cell padding and the edit button's 4 px, each side
		expect(w.account).toBe(textWidth('HDFC (Bank accounts)') + 32);
		expect(w.category).toBe(textWidth('Uncategorized') + 32);
		expect(w.notes).toBe(80);
		expect(w.outflow).toBe(textWidth('₹22,46,700.00') + 32); // was a fixed 104: the figure ran into the padding
		expect(w.outflow).toBeGreaterThan(104);
		expect(w.inflow).toBe(104);
		expect(w.payee).toBeUndefined(); // the fill column takes the rest
	});
	it("fits the entry row's picker on its starting text, chevron and all, whatever the cells hold", () => {
		const specs: ColumnSpec[] = [{ id: 'category', min: 96, max: 220, field: ['Uncategorized'] }];
		// The Car register: only "Transfer" in the cells (96 px), the entry row starts on "Uncategorized"
		expect(fittedWidths(specs, { category: ['Transfer'] }).category).toBe(textWidth('Uncategorized') + 48);
		expect(fittedWidths(specs, { category: ['Uncategorized'] }).category).toBeGreaterThan(textWidth('Uncategorized') + 32);
		expect(fittedWidths(specs, { category: ['x'.repeat(40)] }).category).toBe(220);
	});
	it('a long text stops at the maximum', () => {
		expect(fittedWidths(SPECS, { notes: ['x'.repeat(200)] }).notes).toBe(360);
	});
});

describe("Fluent's squash when the table is narrow", () => {
	const wide = { account: 200, category: 200, notes: 300, outflow: 104, inflow: 104 };
	it('a wide table keeps every fitted width', () => {
		expect(fitToContainer(SPECS, wide, 1400)).toEqual(wide);
		expect(fitToContainer(SPECS, wide, 0)).toEqual(wide); // on the server: nothing to fit yet
	});
	it('a narrow one gives way from the last text column, down to minimums, keeping Payee its minimum', () => {
		// fixed 332 + 700 + Payee's 140 = 1172; at 1000, 172 must go: all of it from Notes (300 -> 128).
		expect(fitToContainer(SPECS, wide, 1000)).toEqual({ ...wide, notes: 128 });
		// at 800, 372 must go: Notes to 80 (220), Category to 96 (104), Account 48 (to 152).
		expect(fitToContainer(SPECS, wide, 800)).toEqual({ ...wide, account: 152, category: 96, notes: 80 });
		// too narrow even at minimums: every text column at its minimum, the amounts kept whole,
		// the table overflows
		expect(fitToContainer(SPECS, wide, 500)).toEqual({ ...wide, account: 96, category: 96, notes: 80 });
	});
});

describe('All transactions at 1232 wide', () => {
	// Account and Category give way together, the wider first, once Notes is at its minimum: with
	// 60-character account names Category was cut to "Uncateg…" (96 px) while Account kept 190.
	const ALL: ColumnSpec[] = SPECS.map((s) => (s.id === 'account' || s.id === 'category' ? { ...s, squash: 'level' } : s));
	// The exe at 1232 x 720: the table 903 px with the sidebar open; crore amounts 122 px each.
	it('Account gives way before Category is cut', () => {
		const fitted = { account: 280, category: 141, notes: 80, outflow: 122, inflow: 122 };
		// fixed 124 + amounts 244 + Notes 80 + Payee 140 leave 315: Category keeps 141, Account 174
		expect(fitToContainer(ALL, fitted, 903)).toEqual({ ...fitted, account: 174 });
	});
	it('two wide columns share what is left', () => {
		const fitted = { account: 280, category: 220, notes: 80, outflow: 122, inflow: 122 };
		const w = fitToContainer(ALL, fitted, 903);
		expect(w.account! + w.category!).toBe(315);
		expect(Math.abs(w.account! - w.category!)).toBeLessThanOrEqual(1);
	});
	it('Notes still gives way first, and a minimum still holds', () => {
		const fitted = { account: 280, category: 141, notes: 300, outflow: 122, inflow: 122 };
		expect(fitToContainer(ALL, fitted, 1100)).toEqual({ ...fitted, notes: 171 });
		expect(fitToContainer(ALL, fitted, 500)).toEqual({ ...fitted, account: 96, category: 96, notes: 80 });
	});
});

describe('a drag on a heading edge', () => {
	// The 2026-11-09 exe run, All transactions at 1232 px: the table 903 px with the sidebar open,
	// 1135 px folded; Account dragged from 178 px by 60.
	const fitted = { account: 178, category: 126, notes: 80, outflow: 122, inflow: 122 };
	it('keeps the width on screen when the window stops it, not the pointer\'s', () => {
		// 60 px wanted, 49 px short: Category gives 30 (to its 96), then Account itself 19
		expect(dragWidth(SPECS, fitted, 'account', 238, 903)).toBe(219);
		expect(fitToContainer(SPECS, { ...fitted, account: 219 }, 903)).toEqual({ ...fitted, account: 219, category: 96 });
	});
	it('keeps the pointer\'s width when there is room', () => {
		expect(dragWidth(SPECS, fitted, 'account', 238, 1135)).toBe(238);
		expect(dragWidth(SPECS, fitted, 'account', 238, 0)).toBe(238); // before the table is measured
	});
});

describe('the widths cookie', () => {
	it('keeps numbers in range and drops anything else', () => {
		expect(parseColsCookie('{"transactions":{"account":180,"notes":"x","category":5},"register":{}}')).toEqual({ transactions: { account: 180 } });
		expect(parseColsCookie('not json')).toEqual({});
		// the table's width when last seen, so the server squashes as the browser will: wider range
		expect(parseColsCookie('{"_table":{"w":2400,"x":5},"transactions":{"account":219}}')).toEqual({ _table: { w: 2400 }, transactions: { account: 219 } });
		expect(parseColsCookie('{"_table":{"w":50},"transactions":{"account":219}}')).toEqual({ transactions: { account: 219 } });
		expect(parseColsCookie(undefined)).toEqual({});
	});
});
