/**
 * s4-services.test.ts: the session 4 report services.
 * ============================================================================
 *   - monthToDateSpending: cumulative spend by day this month and last month on the R2
 *     predicate (transfers, neutral categories and marks excluded), the same-day figure;
 *   - spendingByCategoryByMonth: per-category monthly nets whose total reconciles with
 *     spendingByCategory for the same window, colours carried, zero months present;
 *   - netWorthByClass: per-class month-end values that sum to netWorthHistory's points.
 * ============================================================================
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb } from '../src/lib/server/db/client';
import { allStatements } from '../src/lib/server/db/migrate';
import type { Db } from '../src/lib/server/db/client';
import * as schema from '../src/lib/server/db/schema';
import { eq } from 'drizzle-orm';
import {
	spendingByCategory,
	spendingByCategoryByMonth,
	monthToDateSpending
} from '../src/lib/server/reports';
import { netWorthByClass, netWorthHistory } from '../src/lib/server/dashboard';

let handle: Db | undefined;
beforeEach(() => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(new Date('2026-10-10T06:00:00Z'));
});
afterEach(() => {
	vi.useRealTimers();
	handle?.sqlite.close();
	handle = undefined;
});

let seq = 0;
function seed(): Db {
	const h = createDb(':memory:');
	handle = h;
	for (const stmt of allStatements()) h.sqlite.exec(stmt);
	h.db.insert(schema.users).values({ id: 'alice', username: 'alice', displayName: 'Alice', role: 'admin' }).run();
	h.db.insert(schema.categoryGroups).values([
		{ id: 'g-food', name: 'Food', kind: 'spending' },
		{ id: 'g-sal', name: 'Salary', kind: 'income' },
		{ id: 'g-inv', name: 'Investments', kind: 'neutral' }
	]).run();
	h.db.insert(schema.categories).values([
		{ id: 'c-groc', groupId: 'g-food', name: 'Groceries', colour: '#e87ba4' },
		{ id: 'c-eat', groupId: 'g-food', name: 'Eating out', colour: '#eb6834' },
		{ id: 'c-sal', groupId: 'g-sal', name: 'Salary' },
		{ id: 'c-mf', groupId: 'g-inv', name: 'Mutual funds' }
	]).run();
	const acct = (id: string, type: string, openingPaise: number) =>
		h.db.insert(schema.accounts).values({ id, ownerId: 'alice', name: id, type, currency: 'INR', openingPaise, openingDate: '2026-01-01' }).run();
	acct('bank', 'bank', 100_000_00);
	acct('card', 'creditCard', -5_000_00);
	acct('loan', 'loan', -1_000_000_00);
	acct('mf', 'mutualFunds', 50_000_00);
	return h;
}
function tx(h: Db, id: string, accountId: string, date: string, amountPaise: number, categoryId: string | null = null, kind: 'ordinary' | 'valuationMark' = 'ordinary') {
	h.db.insert(schema.transactions).values({ id, accountId, date, sequence: seq++, amountPaise, categoryId, kind }).run();
}
function link(h: Db, a: string, b: string) {
	h.db.update(schema.transactions).set({ transferPartnerId: b }).where(eq(schema.transactions.id, a)).run();
	h.db.update(schema.transactions).set({ transferPartnerId: a }).where(eq(schema.transactions.id, b)).run();
}

describe('monthToDateSpending', () => {
	it('accumulates spending by day this month and last, and reads the same day last month', async () => {
		const h = seed();
		tx(h, 's1', 'bank', '2026-09-03', -1_000_00, 'c-groc');
		tx(h, 's2', 'card', '2026-09-08', -500_00, 'c-eat');
		tx(h, 's3', 'bank', '2026-09-20', -2_000_00, null); // uncategorized counts
		tx(h, 'o1', 'bank', '2026-10-02', -300_00, 'c-groc');
		tx(h, 'o2', 'bank', '2026-10-09', 100_00, 'c-groc'); // a refund nets
		tx(h, 'x1', 'bank', '2026-10-05', -9_000_00, 'c-mf'); // neutral: excluded
		tx(h, 'x2', 'bank', '2026-10-06', 50_000_00, 'c-sal'); // income: excluded
		tx(h, 't1', 'bank', '2026-10-07', -4_000_00); // a transfer: excluded
		tx(h, 't2', 'card', '2026-10-07', 4_000_00);
		link(h, 't1', 't2');
		tx(h, 'm1', 'mf', '2026-10-08', 7_000_00, null, 'valuationMark'); // a mark: excluded

		const r = await monthToDateSpending(h, 'alice');
		expect(r.month).toBe('2026-10');
		expect(r.day).toBe(10);
		expect(r.thisMonth).toHaveLength(10);
		expect(r.thisMonth[0]).toBe(0);
		expect(r.thisMonth[1]).toBe(300_00);
		expect(r.thisMonth[9]).toBe(200_00);
		expect(r.lastMonth).toBe('2026-09');
		expect(r.lastMonthCumulative).toHaveLength(30);
		expect(r.lastMonthByThisDay).toBe(1_500_00);
		expect(r.lastMonthCumulative[29]).toBe(3_500_00);
	});
});

describe('spendingByCategoryByMonth', () => {
	it('splits spending by category and month and reconciles with spendingByCategory', async () => {
		const h = seed();
		tx(h, 'a', 'bank', '2026-07-03', -1_000_00, 'c-groc');
		tx(h, 'b', 'bank', '2026-09-03', -2_000_00, 'c-groc');
		tx(h, 'c', 'card', '2026-09-10', -700_00, 'c-eat');
		tx(h, 'd', 'bank', '2026-10-01', -400_00, null);
		tx(h, 'e', 'bank', '2026-10-02', -9_000_00, 'c-mf');
		const range = { from: '2026-05-01', to: '2026-10-31' };
		const r = await spendingByCategoryByMonth(h, 'alice', range);
		expect(r.months).toEqual(['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10']);
		const groc = r.categories.find((c) => c.categoryId === 'c-groc')!;
		expect(groc.byMonth).toEqual([0, 0, 1_000_00, 0, 2_000_00, 0]);
		expect(groc.colour).toBe('#e87ba4');
		expect(r.categories[0]!.categoryId).toBe('c-groc');
		expect(r.monthTotals).toEqual([0, 0, 1_000_00, 0, 2_700_00, 400_00]);
		const flat = await spendingByCategory(h, 'alice', range);
		expect(r.totalPaise).toBe(flat.totalPaise);
	});
});

describe('netWorthByClass', () => {
	it('gives each class its month-end values, summing to net worth', async () => {
		const h = seed();
		tx(h, 'a', 'bank', '2026-08-15', -10_000_00, 'c-groc');
		tx(h, 'b', 'mf', '2026-09-30', 5_000_00, null, 'valuationMark');
		const r = await netWorthByClass(h, 'alice', { from: '2026-07-01', to: '2026-10-31' });
		expect(r.dates).toEqual(['2026-07-31', '2026-08-31', '2026-09-30', '2026-10-10']);
		expect(r.classes.map((c) => c.type)).toEqual(['bank', 'creditCard', 'loan', 'mutualFunds']);
		const bank = r.classes.find((c) => c.type === 'bank')!;
		expect(bank.values).toEqual([100_000_00, 90_000_00, 90_000_00, 90_000_00]);
		expect(r.classes.find((c) => c.type === 'loan')!.side).toBe('Liability');
		const hist = await netWorthHistory(h, 'alice', 'ALL');
		const last = hist.points[hist.points.length - 1]!;
		expect(r.netWorth[r.netWorth.length - 1]).toBe(last.netWorthPaise);
	});
});

describe('netWorthHistory window', () => {
	it('starts at the ledger, not a year back, when the data is younger than the range', async () => {
		const h = seed(); // every account opens 2026-01-01; today is 2026-10-10
		const hist = await netWorthHistory(h, 'alice', '1Y');
		expect(hist.points[0]!.date).toBe('2026-01-01'); // the ledger's first day, then month ends
		expect(hist.points[1]!.date).toBe('2026-01-31');
		expect(hist.points[hist.points.length - 1]!.date).toBe('2026-10-10');
	});
});
