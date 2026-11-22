/**
 * charts-2026-11.test.ts: the charts built in November 2026.
 * ============================================================================
 *   - valueInvestedHistory (I1): month-end value and invested for one holding and a section, the
 *     last point equal to the holding's own figures; a non-holder gets nothing (P0);
 *   - holdingMetrics.annualReturn and sectionAnnualReturn (I2, S2 RD6): "—" under a year or with
 *     no value update, the plain rate for a lump sum, a section only in one currency;
 *   - balanceTrends (N1): 13 points at the viewer's share, invisible ids dropped (P0);
 *   - monthToDateSpending.average (S6): the three months before, only months with spending.
 * ============================================================================
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb } from '../src/lib/server/db/client';
import { allStatements } from '../src/lib/server/db/migrate';
import type { Db } from '../src/lib/server/db/client';
import * as schema from '../src/lib/server/db/schema';
import {
	balanceTrends,
	holdingMetrics,
	sectionAnnualReturn,
	valueInvestedHistory
} from '../src/lib/server/dashboard';
import { monthToDateSpending } from '../src/lib/server/reports';

let handle: Db | undefined;
beforeEach(() => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(new Date('2026-11-02T06:00:00Z'));
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
	h.db.insert(schema.users).values([
		{ id: 'alice', username: 'alice', displayName: 'Alice', role: 'admin' },
		{ id: 'bob', username: 'bob', displayName: 'Bob', role: 'member' }
	]).run();
	h.db.insert(schema.categoryGroups).values({ id: 'g-food', name: 'Food', kind: 'spending' }).run();
	h.db.insert(schema.categories).values({ id: 'c-groc', groupId: 'g-food', name: 'Groceries' }).run();
	return h;
}
function acct(h: Db, id: string, type: string, openingPaise: number, openingDate: string, currency = 'INR', ownerId = 'alice') {
	h.db.insert(schema.accounts).values({ id, ownerId, name: id, type, currency, openingPaise, openingDate }).run();
}
function tx(h: Db, id: string, accountId: string, date: string, amountPaise: number, opts: { categoryId?: string; kind?: 'ordinary' | 'valuationMark' } = {}) {
	h.db.insert(schema.transactions).values({ id, accountId, date, sequence: seq++, amountPaise, categoryId: opts.categoryId ?? null, kind: opts.kind ?? 'ordinary' }).run();
}
function link(h: Db, a: string, b: string) {
	h.db.update(schema.transactions).set({ transferPartnerId: b }).where(eq(schema.transactions.id, a)).run();
	h.db.update(schema.transactions).set({ transferPartnerId: a }).where(eq(schema.transactions.id, b)).run();
}

describe('valueInvestedHistory (I1)', () => {
	it("draws a holding's value and invested by month end, the last point today's figures", async () => {
		const h = seed();
		acct(h, 'bank', 'bank', 10_00_000_00, '2025-01-01');
		acct(h, 'mf', 'mutualFunds', 1_00_000_00, '2025-01-01');
		tx(h, 'o1', 'bank', '2025-06-05', -50_000_00);
		tx(h, 'i1', 'mf', '2025-06-05', 50_000_00);
		link(h, 'o1', 'i1');
		tx(h, 'm1', 'mf', '2025-12-31', 30_000_00, { kind: 'valuationMark' });

		const one = (await valueInvestedHistory(h, 'alice', { accountId: 'mf' }, 'ALL'))!;
		const may = one.points.find((p) => p.date === '2025-05-31')!;
		expect([may.valuePaise, may.investedPaise]).toEqual([1_00_000_00, 1_00_000_00]);
		const last = one.points[one.points.length - 1]!;
		expect(last.date).toBe('2026-11-02');
		const m = (await holdingMetrics(h, 'alice', 'mf'))!;
		expect([last.valuePaise, last.investedPaise]).toEqual([m.currentValuePaise, m.costBasisPaise]);

		const section = (await valueInvestedHistory(h, 'alice', { type: 'mutualFunds' }, '1Y'))!;
		expect(section.points[section.points.length - 1]!.valuePaise).toBe(1_80_000_00);
	});

	it("gives a non-holder nothing for someone else's holding (P0)", async () => {
		const h = seed();
		acct(h, 'mf', 'mutualFunds', 1_00_000_00, '2025-01-01');
		expect(await valueInvestedHistory(h, 'bob', { accountId: 'mf' }, 'ALL')).toBeNull();
		expect((await valueInvestedHistory(h, 'bob', { type: 'mutualFunds' }, 'ALL'))!.points).toEqual([]);
	});
});

describe('return per year (I2, S2 RD6)', () => {
	it('is 10 % for a lump sum marked 10 % up a year later, and "—" before a year', async () => {
		const h = seed();
		acct(h, 'mf', 'mutualFunds', 1_00_000_00, '2025-01-01');
		tx(h, 'm1', 'mf', '2025-06-01', 4_000_00, { kind: 'valuationMark' });
		expect((await holdingMetrics(h, 'alice', 'mf'))!.annualReturn).toBeNull(); // last mark under a year in
		tx(h, 'm2', 'mf', '2026-01-01', 6_000_00, { kind: 'valuationMark' });
		const m = (await holdingMetrics(h, 'alice', 'mf'))!;
		expect(m.annualReturn).toBeCloseTo(0.1, 6);
		expect(m.trackedSince).toBe('2025-01-01');
	});

	it('is "—" with no value update since tracking began, and for a liability', async () => {
		const h = seed();
		acct(h, 'fd', 'fd', 1_00_000_00, '2024-01-01');
		acct(h, 'loan', 'loan', -5_00_000_00, '2024-01-01');
		expect((await holdingMetrics(h, 'alice', 'fd'))!.annualReturn).toBeNull();
		expect((await holdingMetrics(h, 'alice', 'loan'))!.annualReturn).toBeNull();
	});

	it("a section's rate merges its holdings, and is null across currencies", async () => {
		const h = seed();
		acct(h, 'a', 'stocks', 1_00_000_00, '2025-01-01');
		acct(h, 'b', 'stocks', 1_00_000_00, '2025-01-01');
		tx(h, 'ma', 'a', '2026-01-01', 10_000_00, { kind: 'valuationMark' });
		tx(h, 'mb', 'b', '2026-01-01', 30_000_00, { kind: 'valuationMark' });
		expect(await sectionAnnualReturn(h, 'alice', 'stocks')).toBeCloseTo(0.2, 6);
		acct(h, 'usd', 'stocks', 1_000_00, '2025-01-01', 'USD');
		expect(await sectionAnnualReturn(h, 'alice', 'stocks')).toBeNull();
	});
});

describe('balanceTrends (N1)', () => {
	it('gives 13 points ending today, and drops an account the viewer cannot see (P0)', async () => {
		const h = seed();
		acct(h, 'bank', 'bank', 10_000_00, '2024-01-01');
		acct(h, 'bobs', 'bank', 10_000_00, '2024-01-01', 'INR', 'bob');
		tx(h, 's1', 'bank', '2026-10-15', -2_000_00, { categoryId: 'c-groc' });
		const t = await balanceTrends(h, 'alice', ['bank', 'bobs']);
		expect(t.has('bobs')).toBe(false);
		const line = t.get('bank')!;
		expect(line).toHaveLength(13);
		expect(line[line.length - 1]).toBe(8_000_00);
		expect(line[0]).toBe(10_000_00);
	});

	it("starts a new account's line where it began", async () => {
		const h = seed();
		acct(h, 'new', 'bank', 5_000_00, '2026-08-10');
		expect((await balanceTrends(h, 'alice', ['new'])).get('new')).toHaveLength(4); // Aug, Sep, Oct ends + today
	});

	it('draws no line for an account under two month ends old (a flat line would say nothing)', async () => {
		const h = seed();
		acct(h, 'young', 'bank', 5_000_00, '2026-10-10');
		expect((await balanceTrends(h, 'alice', ['young'])).has('young')).toBe(false);
	});
});

describe('valueInvestedHistory from the first day', () => {
	it('starts on the day tracking began, so an early value update shows', async () => {
		const h = seed();
		acct(h, 'mf', 'mutualFunds', 25_00_000_00, '2026-10-15');
		tx(h, 'm1', 'mf', '2026-10-31', -22_46_700_00, { kind: 'valuationMark' });
		const r = (await valueInvestedHistory(h, 'alice', { accountId: 'mf' }, 'ALL'))!;
		expect(r.points.map((p) => [p.date, p.valuePaise])).toEqual([
			['2026-10-15', 25_00_000_00],
			['2026-10-31', 2_53_300_00],
			['2026-11-02', 2_53_300_00]
		]);
	});
});

describe('monthToDateSpending.average (S6)', () => {
	it('averages the three months before by day, a short month counting its total to the end', async () => {
		const h = seed();
		acct(h, 'bank', 'bank', 10_00_000_00, '2026-01-01');
		tx(h, 'a', 'bank', '2026-08-01', -3_000_00, { categoryId: 'c-groc' });
		tx(h, 'b', 'bank', '2026-09-30', -6_000_00, { categoryId: 'c-groc' });
		tx(h, 'c', 'bank', '2026-10-01', -9_000_00, { categoryId: 'c-groc' });
		const r = await monthToDateSpending(h, 'alice');
		expect(r.average).not.toBeNull();
		expect([r.average!.from, r.average!.to]).toEqual(['2026-08', '2026-10']);
		expect(r.average!.cumulative).toHaveLength(30); // November's days
		expect(r.average!.cumulative[0]).toBe(4_000_00); // (3,000 + 0 + 9,000) / 3
		expect(r.average!.cumulative[29]).toBe(6_000_00); // September's 6,000 lands on the 30th
		expect(r.average!.byThisDay).toBe(4_000_00);
	});

	it('leaves out months with no spending and needs two', async () => {
		const h = seed();
		acct(h, 'bank', 'bank', 10_00_000_00, '2026-10-01');
		tx(h, 'c', 'bank', '2026-10-01', -9_000_00, { categoryId: 'c-groc' });
		expect((await monthToDateSpending(h, 'alice')).average).toBeNull();
	});
});
