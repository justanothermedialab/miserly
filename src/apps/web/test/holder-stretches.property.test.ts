/**
 * holder-stretches.property.test.ts: the P0 privacy properties of C5 C (H2 RD9,
 * architecture §12). A member holds a shared account for stretches of dates (migration 0013): they
 * read the rows dated inside them and nothing else, write only while they hold it and only on those
 * dates, and their figures count their share of those dates only. A person who never held it learns
 * nothing, as before.
 * ============================================================================
 * fast-check builds random stretches for Bob on Alice's joint account (0 to 3, the last open or
 * not) and random rows across three years, written straight to the tables, then checks every read
 * behind `accountsVisibleTo` against the one rule (`inStretches`): the register, Reports and their
 * drill rows, recent activity, payees, the inbox, and the write paths. Carol never holds it.
 * "Today" is pinned to 2026-11-06.
 * ============================================================================
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import { createDb } from '../src/lib/server/db/client';
import { allStatements } from '../src/lib/server/db/migrate';
import type { Db } from '../src/lib/server/db/client';
import * as schema from '../src/lib/server/db/schema';
import { inStretches, isAccountReadableBy, isAccountVisibleTo, type Stretch } from '../src/lib/server/visibility';
import {
	registerView,
	createTransaction,
	deleteTransaction,
	updateTransaction,
	inboxTransactions,
	inboxCount,
	capturePayees,
	AccountNotFoundError,
	NotHeldDateError
} from '../src/lib/server/transactions';
import { recentActivity, netWorthHistory } from '../src/lib/server/dashboard';
import { spendingByCategory, categoryTransactions } from '../src/lib/server/reports';
import { listPayeesFor } from '../src/lib/server/payees';

const handles: Db[] = [];
beforeEach(() => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(new Date('2026-11-06T06:00:00Z'));
});
afterEach(() => {
	vi.useRealTimers();
	for (const h of handles.splice(0)) h.sqlite.close();
});

const TODAY = '2026-11-06';
const ALL = { from: '2024-01-01', to: '2026-12-31' };

/** Month index 0..35 → 'YYYY-MM-01' from Jan 2024. */
const monthStart = (i: number) => `${2024 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}-01`;

const scenarioArb = fc.record({
	/** Cut points (months) for Bob's stretches: pairs [from, to), the last may stay open. */
	cuts: fc.uniqueArray(fc.integer({ min: 1, max: 33 }), { maxLength: 6 }).map((a) => a.sort((x, y) => x - y)),
	lastOpen: fc.boolean(),
	rows: fc.array(
		fc.record({
			month: fc.integer({ min: 0, max: 34 }),
			day: fc.integer({ min: 1, max: 28 }),
			amount: fc.integer({ min: 1, max: 5_000_000 }),
			payee: fc.integer({ min: 0, max: 5 }),
			categorised: fc.boolean()
		}),
		{ minLength: 1, maxLength: 14 }
	)
});
type Scenario = typeof scenarioArb extends fc.Arbitrary<infer T> ? T : never;

function stretchesOf(sc: Scenario): Stretch[] {
	const out: Stretch[] = [];
	for (let i = 0; i < sc.cuts.length; i += 2) {
		const from = monthStart(sc.cuts[i]!);
		const toCut = sc.cuts[i + 1];
		if (toCut === undefined) {
			if (sc.lastOpen) out.push({ from, to: null });
			else out.push({ from, to: TODAY });
		} else out.push({ from, to: monthStart(toCut) });
	}
	return out;
}

interface Built {
	h: Db;
	stretches: Stretch[];
	current: boolean;
	rows: { id: string; date: string; amount: number; payee: string; categorised: boolean }[];
}

let n = 0;
function build(sc: Scenario): Built {
	const h = createDb(':memory:');
	handles.push(h);
	for (const stmt of allStatements()) h.sqlite.exec(stmt);
	h.db.insert(schema.users).values([
		{ id: 'alice', username: 'alice', displayName: 'Alice', role: 'admin' },
		{ id: 'bob', username: 'bob', displayName: 'Bob', role: 'member' },
		{ id: 'carol', username: 'carol', displayName: 'Carol', role: 'member' }
	]).run();
	h.db.insert(schema.categoryGroups).values({ id: 'g-sp', name: 'Spending', kind: 'spending' }).run();
	h.db.insert(schema.categories).values({ id: 'c-groc', groupId: 'g-sp', name: 'Groceries' }).run();
	h.db.insert(schema.accounts).values([
		{ id: 'J', ownerId: 'alice', type: 'bank', name: 'Joint', currency: 'INR', openingPaise: 1_00_000_00, openingDate: '2024-01-01' },
		{ id: 'B', ownerId: 'bob', type: 'bank', name: 'Bob SBI', currency: 'INR', openingPaise: 0, openingDate: '2024-01-01' }
	]).run();
	const stretches = stretchesOf(sc);
	const current = stretches.some((s) => s.to === null);
	for (const s of stretches) h.db.insert(schema.accountHolderPeriods).values({ accountId: 'J', userId: 'bob', fromDate: s.from, toDate: s.to }).run();
	if (stretches.length > 0) {
		h.db.insert(schema.accountMembers).values({ accountId: 'J', userId: 'bob', deletedAt: current ? null : '2026-11-06T00:00:00Z' }).run();
	}
	for (let i = 0; i < 6; i++) h.db.insert(schema.payees).values({ id: `p${i}`, displayName: `Payee ${i}`, nameNormalized: `payee ${i}` }).run();
	const rows: Built['rows'] = [];
	const seen = new Set<string>();
	for (const r of sc.rows) {
		const date = `${monthStart(r.month).slice(0, 8)}${String(r.day).padStart(2, '0')}`;
		const id = `t${n++}`;
		h.db.insert(schema.transactions).values({
			id, accountId: 'J', date, sequence: n, amountPaise: -r.amount, payeeId: `p${r.payee}`,
			categoryId: r.categorised ? 'c-groc' : null, kind: 'ordinary', enteredBy: 'alice'
		}).run();
		if (!seen.has(`p${r.payee}`)) {
			seen.add(`p${r.payee}`);
			h.db.insert(schema.accountPayee).values({ accountId: 'J', payeeId: `p${r.payee}` }).run();
		}
		rows.push({ id, date, amount: r.amount, payee: `p${r.payee}`, categorised: r.categorised });
	}
	return { h, stretches, current, rows };
}

const held = (b: Built) => b.rows.filter((r) => inStretches(b.stretches, r.date));
const ids = (xs: { id: string }[]) => xs.map((x) => x.id).sort();

describe('C5 C: a member sees an account for the dates they held it (P0 privacy properties)', () => {
	it('the register lists exactly the rows dated inside the stretches, each with the account\'s own running balance; a non-holder 404s', async () => {
		await fc.assert(
			fc.asyncProperty(scenarioArb, async (sc) => {
				const b = build(sc);
				const alice = await registerView(b.h, 'alice', 'J');
				expect(ids(alice.rows)).toEqual(ids(b.rows)); // the owner holds every date
				await expect(registerView(b.h, 'carol', 'J')).rejects.toBeInstanceOf(AccountNotFoundError);
				expect(await isAccountReadableBy(b.h.db, 'carol', 'J')).toBe(false);
				if (b.stretches.length === 0) {
					await expect(registerView(b.h, 'bob', 'J')).rejects.toBeInstanceOf(AccountNotFoundError);
					return;
				}
				const bob = await registerView(b.h, 'bob', 'J');
				expect(ids(bob.rows)).toEqual(ids(held(b)));
				const full = new Map(alice.rows.map((r) => [r.id, r.balancePaise]));
				for (const r of bob.rows) expect(r.balancePaise).toBe(full.get(r.id));
				expect(bob.access.canWrite).toBe(b.current);
				expect(await isAccountVisibleTo(b.h.db, 'bob', 'J')).toBe(b.current);
				// A member who has left sees nothing after: the figures stop on their last day.
				if (!b.current) {
					const lastTo = b.stretches[b.stretches.length - 1]!.to!;
					const until = held(b).filter((r) => r.date < lastTo);
					expect(bob.asOfTodayPaise).toBe(1_00_000_00 - b.rows.filter((r) => r.date < lastTo).reduce((s, r) => s + r.amount, 0));
					expect(until.every((r) => r.date < lastTo)).toBe(true);
				}
			}),
			{ numRuns: 40 }
		);
	}, 30_000); // a fresh database per run: room for the full suite's parallel load

	it("Reports: the holders' parts add to the account exactly; drill rows, recent activity, payees and the inbox stay inside the stretches", async () => {
		await fc.assert(
			fc.asyncProperty(scenarioArb, async (sc) => {
				const b = build(sc);
				// An uncategorised row on a bank counts as spending too.
				const total = b.rows.filter((r) => r.date <= TODAY).reduce((s, r) => s + r.amount, 0); // Reports stop at today
				const a = (await spendingByCategory(b.h, 'alice', ALL)).totalPaise;
				const bb = (await spendingByCategory(b.h, 'bob', ALL)).totalPaise;
				expect(a + bb).toBe(total);
				expect((await spendingByCategory(b.h, 'carol', ALL)).totalPaise).toBe(0);
				const heldIds = new Set(held(b).map((r) => r.id));
				if (held(b).length === 0) expect(bb).toBe(0);

				const drill = await categoryTransactions(b.h, 'bob', ALL, 'c-groc');
				for (const r of drill) expect(heldIds.has(r.id)).toBe(true);
				expect(drill.length).toBe(held(b).filter((r) => r.categorised && r.date <= TODAY).length);

				const feed = await recentActivity(b.h, 'bob', 500);
				for (const r of feed) expect(b.current && heldIds.has(r.id)).toBe(true);

				const heldPayees = new Set(held(b).map((r) => r.payee));
				const payees = await listPayeesFor(b.h.db, 'bob');
				for (const p of payees) expect(b.current && heldPayees.has(p.id)).toBe(true);
				for (const p of await capturePayees(b.h.db, 'bob')) expect(heldPayees.has(p.id)).toBe(true);
				// Quick add ranks payees by their uses on the dates held only (the cheaper count).
				const uses = (id: string) => held(b).filter((r) => r.payee === id).length;
				const ranked = (await capturePayees(b.h.db, 'bob')).map((p) => uses(p.id));
				expect(ranked).toEqual([...ranked].sort((x, y) => y - x));
				// The sidebar's Inbox count is the list's length, for each member.
				for (const who of ['alice', 'bob', 'carol']) expect(await inboxCount(b.h, who)).toBe((await inboxTransactions(b.h, who)).length);
				expect(await listPayeesFor(b.h.db, 'carol')).toEqual([]);

				for (const r of await inboxTransactions(b.h, 'bob')) expect(b.current && heldIds.has(r.id) && !b.rows.find((x) => x.id === r.id)!.categorised).toBe(true);
				expect(await inboxTransactions(b.h, 'carol')).toEqual([]);

				// The line: Bob's share counts on his dates only (nothing before he first joined).
				const line = await netWorthHistory(b.h, 'bob', 'ALL');
				const first = b.stretches[0]?.from;
				for (const p of line.points) if (first === undefined || p.date < first) expect(p.netWorthPaise).toBe(0);
			}),
			{ numRuns: 40 }
		);
	}, 30_000); // a fresh database per run: room for the full suite's parallel load

	it('writes: only a current holder, only on the dates held (outside them a row is "not found", a new date is refused)', async () => {
		await fc.assert(
			fc.asyncProperty(scenarioArb, async (sc) => {
				const b = build(sc);
				for (const r of b.rows) {
					const mine = b.current && inStretches(b.stretches, r.date);
					const row = b.h.db.select().from(schema.transactions).all().find((x) => x.id === r.id)!;
					if (!mine) {
						await expect(updateTransaction(b.h, { userId: 'bob' }, r.id, { notes: 'x' }, row.updatedAt)).rejects.toBeInstanceOf(AccountNotFoundError);
						await expect(deleteTransaction(b.h, { userId: 'bob' }, r.id, row.updatedAt)).rejects.toBeInstanceOf(AccountNotFoundError);
					}
					await expect(deleteTransaction(b.h, { userId: 'carol' }, r.id, row.updatedAt)).rejects.toBeInstanceOf(AccountNotFoundError);
				}
				const input = (date: string) => ({ accountId: 'J', date, amountPaise: -100, categoryId: 'c-groc' });
				if (!b.current) {
					await expect(createTransaction(b.h, { userId: 'bob' }, input(TODAY))).rejects.toBeInstanceOf(AccountNotFoundError);
				} else {
					const open = b.stretches.find((s) => s.to === null)!;
					await createTransaction(b.h, { userId: 'bob' }, input(open.from));
					if (!inStretches(b.stretches, '2024-01-01')) {
						await expect(createTransaction(b.h, { userId: 'bob' }, input('2024-01-01'))).rejects.toBeInstanceOf(NotHeldDateError);
					}
				}
			}),
			{ numRuns: 30 }
		);
	}, 30_000); // a fresh database per run: room for the full suite's parallel load
});

/** The 1st of the month `m` months after November 2023. */
const afterNov2023 = (m: number) => `${2023 + Math.floor((10 + m) / 12)}-${String(((10 + m) % 12) + 1).padStart(2, '0')}-01`;

describe('a share change counts as money moved in return per year (property)', () => {
	it('a fund growing steadily reads its own rate for the owner and the member, whatever day it is shared', async () => {
		const { createHoldingAccount } = await import('../src/lib/server/accounts');
		const { postValuationMark } = await import('../src/lib/server/marks');
		const { shareAccount } = await import('../src/lib/server/sharing');
		const { sectionAnnualReturn, holdingMetrics } = await import('../src/lib/server/dashboard');
		await fc.assert(
			fc.asyncProperty(fc.integer({ min: 1, max: 22 }), fc.integer({ min: 5, max: 25 }), async (shareMonth, ratePct) => {
				vi.setSystemTime(new Date('2026-11-06T06:00:00Z'));
				const h = createDb(':memory:');
				handles.push(h);
				for (const stmt of allStatements()) h.sqlite.exec(stmt);
				h.db.insert(schema.users).values([
					{ id: 'alice', username: 'alice', displayName: 'Alice', role: 'admin' },
					{ id: 'bob', username: 'bob', displayName: 'Bob', role: 'member' }
				]).run();
				const r = ratePct / 100;
				const start = '2023-11-01';
				const mf = await createHoldingAccount(h, { ownerId: 'alice', type: 'mutualFunds', name: 'Index', currency: 'INR', investedPaise: 1_00_000_00, investedDate: start, currentValuePaise: null });
				// A value update on the 1st of every month on the curve 1L × (1 + r)^(days / 365).
				const days = (iso: string) => (Date.parse(iso) - Date.parse(start)) / 86_400_000;
				for (let m = 1; m <= 36; m++) {
					const iso = afterNov2023(m);
					if (iso > '2026-11-01') break;
					if (m === shareMonth) {
						vi.setSystemTime(new Date(`${iso.slice(0, 8)}02T06:00:00Z`));
						await shareAccount(h.db, { userId: 'alice' }, mf.id, 'bob');
						vi.setSystemTime(new Date('2026-11-06T06:00:00Z'));
					}
					await postValuationMark(h, { userId: 'alice' }, { accountId: mf.id, targetPaise: Math.round(1_00_000_00 * Math.pow(1 + r, days(iso) / 365)), date: iso });
				}
				const own = (await holdingMetrics(h, 'alice', mf.id))!.annualReturn!;
				expect(own).toBeCloseTo(r, 2);
				expect(Math.abs((await sectionAnnualReturn(h, 'alice', 'mutualFunds'))! - own)).toBeLessThan(0.003);
				// Shared by September 2025 at the latest, so Bob has over a year.
				const bob = await sectionAnnualReturn(h, 'bob', 'mutualFunds');
				expect(bob).not.toBeNull();
				expect(Math.abs(bob! - own)).toBeLessThan(0.003);
			}),
			{ numRuns: 8 }
		);
	}, 30_000); // a fresh database per run: room for the full suite's parallel load
});
