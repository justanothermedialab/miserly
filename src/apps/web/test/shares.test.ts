/**
 * shares.test.ts: joint accounts at each holder's share (H2 RD8, D1 RD12,
 * R2 RD10, architecture §12). `sharesFor` is the one place weights come from; these pin its rules
 * (equal by default, dated stated splits, a later holder at 0 %, a removed holder's share back to the
 * owner, half-even rounding with the remainder to the owner) and, with fast-check, that the holders'
 * figures always add up to the account and the household exactly, and that a non-holder reads 0.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { eq, and } from 'drizzle-orm';
import { createDb } from '../src/lib/server/db/client';
import { allStatements } from '../src/lib/server/db/migrate';
import type { Db } from '../src/lib/server/db/client';
import * as schema from '../src/lib/server/db/schema';
import { halfEvenPart, sharesFor } from '../src/lib/server/visibility';
import { dashboardSummary, accountSummary } from '../src/lib/server/dashboard';
import { spendingByCategory, incomeVsExpense } from '../src/lib/server/reports';
import { setAccountShares, listAccountMembers, splitState, InvalidSplitError, NotAccountOwnerError } from '../src/lib/server/sharing';

const handles: Db[] = [];
afterEach(() => {
	for (const h of handles.splice(0)) h.sqlite.close();
});

const USERS = ['alice', 'bob', 'carol', 'dan'] as const;

function seed(): Db {
	const h = createDb(':memory:');
	handles.push(h);
	for (const stmt of allStatements()) h.sqlite.exec(stmt);
	h.db
		.insert(schema.users)
		.values(USERS.map((id, i) => ({ id, username: id, displayName: id, role: i === 0 ? ('admin' as const) : ('member' as const) })))
		.run();
	h.db.insert(schema.categoryGroups).values({ id: 'g-sp', name: 'Spending', kind: 'spending' }).run();
	h.db.insert(schema.categories).values({ id: 'c-groc', groupId: 'g-sp', name: 'Groceries' }).run();
	return h;
}

function addAccount(h: Db, id: string, ownerId: string, openingPaise = 0, members: string[] = []): void {
	h.db
		.insert(schema.accounts)
		.values({ id, ownerId, type: 'bank', name: id, currency: 'INR', status: 'open', openingPaise, openingDate: '2024-01-01' })
		.run();
	for (const userId of members) h.db.insert(schema.accountMembers).values({ accountId: id, userId }).run();
}

function setShares(h: Db, accountId: string, from: string, bp: Record<string, number>): void {
	h.db
		.insert(schema.accountShares)
		.values(Object.entries(bp).map(([userId, shareBp]) => ({ accountId, userId, effectiveFrom: from, shareBp })))
		.run();
}

let seq = 0;
function addTx(h: Db, id: string, accountId: string, date: string, amountPaise: number): void {
	h.db
		.insert(schema.transactions)
		.values({ id, accountId, date, sequence: seq++, amountPaise, categoryId: 'c-groc', kind: 'ordinary' })
		.run();
}

describe('halfEvenPart', () => {
	it('rounds half to even, symmetric for negatives, exact past 2^53', () => {
		expect(halfEvenPart(5, 1, 2)).toBe(2); // 2.5 → 2
		expect(halfEvenPart(7, 1, 2)).toBe(4); // 3.5 → 4
		expect(halfEvenPart(-5, 1, 2)).toBe(-2);
		expect(halfEvenPart(-7, 1, 2)).toBe(-4);
		expect(halfEvenPart(10, 1, 3)).toBe(3);
		expect(halfEvenPart(100, 3333, 10_000)).toBe(33);
		expect(halfEvenPart(9_000_000_000_000, 9_999, 10_000)).toBe(8_999_100_000_000);
	});
});

describe('sharesFor: the rules', () => {
	it('a sole-held account is the viewer\'s in full', async () => {
		const h = seed();
		addAccount(h, 'a', 'alice');
		const s = await sharesFor(h.db, 'alice', ['a']);
		expect(s.isShared('a')).toBe(false);
		expect(s.partOn('a', 12_345, '2024-06-01')).toBe(12_345);
		expect(s.shareBpOn('a', '2024-06-01')).toBe(10_000);
	});

	it('no stated split: equal, the owner taking the rounding remainder', async () => {
		const h = seed();
		addAccount(h, 'j', 'alice', 0, ['bob', 'carol']);
		const [a, b, c] = await Promise.all(['alice', 'bob', 'carol'].map((u) => sharesFor(h.db, u, ['j'])));
		expect(b!.partOn('j', 100, '2024-06-01')).toBe(33);
		expect(c!.partOn('j', 100, '2024-06-01')).toBe(33);
		expect(a!.partOn('j', 100, '2024-06-01')).toBe(34);
		expect(a!.isShared('j')).toBe(true);
	});

	it('a stated split applies from its date; earlier dates stay equal', async () => {
		const h = seed();
		addAccount(h, 'j', 'alice', 0, ['bob']);
		setShares(h, 'j', '2024-07-01', { alice: 6_000, bob: 4_000 });
		const bob = await sharesFor(h.db, 'bob', ['j']);
		expect(bob.partOn('j', 1_000, '2024-06-30')).toBe(500);
		expect(bob.partOn('j', 1_000, '2024-07-01')).toBe(400);
		expect(bob.shareBpOn('j', '2024-12-31')).toBe(4_000);
		expect(bob.partIn('j', 1_000, null)).toBe(500);
		expect(bob.partIn('j', 1_000, '2024-07-01')).toBe(400);
	});

	it('after a stated split a new holder starts at 0 %; a removed holder\'s share returns to the owner', async () => {
		const h = seed();
		addAccount(h, 'j', 'alice', 0, ['bob']);
		setShares(h, 'j', '2024-07-01', { alice: 6_000, bob: 4_000 });
		h.db.insert(schema.accountMembers).values({ accountId: 'j', userId: 'carol' }).run();
		const carol = await sharesFor(h.db, 'carol', ['j']);
		expect(carol.partOn('j', 1_000, '2024-08-01')).toBe(0);
		// Bob removed (an un-share is a tombstone, H2 RD7): alice holds bob's 40 % too.
		h.db
			.update(schema.accountMembers)
			.set({ deletedAt: '2024-09-01' })
			.where(and(eq(schema.accountMembers.accountId, 'j'), eq(schema.accountMembers.userId, 'bob')))
			.run();
		const alice = await sharesFor(h.db, 'alice', ['j']);
		expect(alice.partOn('j', 1_000, '2024-08-01')).toBe(1_000);
	});

	it('the dashboard and Reports use the share on each date', async () => {
		const h = seed();
		addAccount(h, 'j', 'alice', 0, ['bob']);
		setShares(h, 'j', '2024-07-01', { alice: 10_000, bob: 0 });
		addTx(h, 'before', 'j', '2024-06-10', -10_000);
		addTx(h, 'after', 'j', '2024-07-10', -10_000);
		const range = { from: '2024-01-01', to: '2024-12-31' };
		expect((await spendingByCategory(h, 'bob', range)).totalPaise).toBe(5_000); // half of June only
		expect((await spendingByCategory(h, 'alice', range)).totalPaise).toBe(15_000);
		expect((await incomeVsExpense(h, 'bob', range)).totalExpensePaise).toBe(5_000);
	});
});

// ── properties ────────────────────────────────────────────────────────────────

/** A random household: accounts owned by one of three users, some shared, dated splits, spending. */
const householdArb = fc.record({
	accounts: fc.array(
		fc.record({
			owner: fc.integer({ min: 0, max: 2 }),
			members: fc.subarray([0, 1, 2]),
			opening: fc.integer({ min: -5_000_000_00, max: 50_000_000_00 }),
			// Up to two dated changes, each a random split over the account's holders.
			changes: fc.array(
				fc.record({ month: fc.integer({ min: 1, max: 12 }), weights: fc.array(fc.nat({ max: 100 }), { minLength: 3, maxLength: 3 }) }),
				{ maxLength: 2 }
			),
			spends: fc.array(fc.record({ month: fc.integer({ min: 1, max: 12 }), amount: fc.integer({ min: 1, max: 10_000_000 }) }), { maxLength: 6 })
		}),
		{ minLength: 1, maxLength: 5 }
	),
	transfers: fc.array(
		fc.record({ from: fc.nat({ max: 4 }), to: fc.nat({ max: 4 }), month: fc.integer({ min: 1, max: 12 }), amount: fc.integer({ min: 1, max: 5_000_000 }) }),
		{ maxLength: 4 }
	)
});

type Household = typeof householdArb extends fc.Arbitrary<infer T> ? T : never;

const pad = (m: number) => String(m).padStart(2, '0');

/** Linked transfer pairs between the household's accounts (uncategorised, so not spending). */
function addTransfers(h: Db, n: number, transfers: Household['transfers']): void {
	transfers.forEach((t, k) => {
		const from = t.from % n;
		const to = t.to % n;
		if (from === to) return;
		const date = `2024-${pad(t.month)}-10`;
		for (const [id, acc, amt] of [[`x${k}a`, from, -t.amount], [`x${k}b`, to, t.amount]] as const) {
			h.db.insert(schema.transactions).values({ id, accountId: `acc${acc}`, date, sequence: seq++, amountPaise: amt, kind: 'ordinary' }).run();
		}
		h.db.update(schema.transactions).set({ transferPartnerId: `x${k}b` }).where(eq(schema.transactions.id, `x${k}a`)).run();
		h.db.update(schema.transactions).set({ transferPartnerId: `x${k}a` }).where(eq(schema.transactions.id, `x${k}b`)).run();
	});
}

function build(h: Db, hh: Household['accounts']): { spendTotal: number; openingTotal: number } {
	let spendTotal = 0;
	let openingTotal = 0;
	hh.forEach((a, i) => {
		const owner = USERS[a.owner]!;
		const members = a.members.map((m) => USERS[m]!).filter((u) => u !== owner);
		addAccount(h, `acc${i}`, owner, a.opening, members);
		openingTotal += a.opening;
		const holders = [owner, ...members];
		const seen = new Set<number>();
		for (const c of a.changes) {
			if (seen.has(c.month)) continue;
			seen.add(c.month);
			const w = holders.map((_, k) => c.weights[k] ?? 0);
			const sum = w.reduce((x, y) => x + y, 0);
			const bp: Record<string, number> = {};
			if (sum === 0) holders.forEach((u, k) => (bp[u] = k === 0 ? 10_000 : 0));
			else {
				let given = 0;
				holders.forEach((u, k) => {
					if (k === 0) return;
					bp[u] = Math.floor((w[k]! * 10_000) / sum);
					given += bp[u]!;
				});
				bp[owner] = 10_000 - given;
			}
			setShares(h, `acc${i}`, `2024-${pad(c.month)}-01`, bp);
		}
		a.spends.forEach((sp, k) => {
			addTx(h, `t${i}-${k}`, `acc${i}`, `2024-${pad(sp.month)}-15`, -sp.amount);
			spendTotal += sp.amount;
		});
	});
	return { spendTotal, openingTotal };
}

describe('setAccountShares: the owner states a split (H2 RD8)', () => {
	it('owner-only, every holder named, 0 to 100 % each, 100 % in all; a same-date change replaces the old one', async () => {
		const h = seed();
		addAccount(h, 'joint', 'alice', 100_000, ['bob']);
		const actor = { userId: 'alice' };
		await expect(setAccountShares(h.db, { userId: 'bob' }, 'joint', '2024-03-01', { alice: 5_000, bob: 5_000 })).rejects.toBeInstanceOf(NotAccountOwnerError);
		await expect(setAccountShares(h.db, actor, 'joint', '2024-03-01', { alice: 10_000 })).rejects.toBeInstanceOf(InvalidSplitError);
		await expect(setAccountShares(h.db, actor, 'joint', '2024-03-01', { alice: 6_000, bob: 3_000 })).rejects.toThrow('90%');
		await expect(setAccountShares(h.db, actor, 'joint', '2024-02-31', { alice: 6_000, bob: 4_000 })).rejects.toBeInstanceOf(InvalidSplitError);
		expect((await splitState(h.db, 'bob', 'joint')).statedFrom).toBeNull();

		await setAccountShares(h.db, actor, 'joint', '2024-03-01', { alice: 6_000, bob: 4_000 });
		await setAccountShares(h.db, actor, 'joint', '2024-03-01', { alice: 7_000, bob: 3_000 });
		expect(h.db.select().from(schema.accountShares).all()).toHaveLength(2);
		expect((await splitState(h.db, 'bob', 'joint')).statedFrom).toBe('2024-03-01');
		const holders = await listAccountMembers(h.db, 'bob', 'joint');
		expect(holders.map((x) => [x.userId, x.shareBp])).toEqual([['alice', 7_000], ['bob', 3_000]]);
		// A third holder added later starts at 0 % until the owner sets the split again.
		h.db.insert(schema.accountMembers).values({ accountId: 'joint', userId: 'carol' }).run();
		expect((await listAccountMembers(h.db, 'alice', 'joint')).find((x) => x.userId === 'carol')?.shareBp).toBe(0);
	});
});

// A fresh database per run: room for the full suite's parallel load (each takes about 1.8 s alone).
describe('properties (fast-check)', { timeout: 30_000 }, () => {
	it("on every date the holders' parts of any amount add up to it exactly", async () => {
		await fc.assert(
			fc.asyncProperty(householdArb, fc.integer({ min: -1e12, max: 1e12 }), fc.integer({ min: 1, max: 12 }), async (hh, paise, month) => {
				const h = seed();
				build(h, hh.accounts);
				const ids = hh.accounts.map((_, i) => `acc${i}`);
				const per = await Promise.all(USERS.slice(0, 3).map((u) => sharesFor(h.db, u, ids)));
				const date = `2024-${pad(month)}-20`;
				hh.accounts.forEach((a, i) => {
					const holders = new Set([USERS[a.owner]!, ...a.members.map((m) => USERS[m]!)]);
					let sum = 0;
					USERS.slice(0, 3).forEach((u, k) => {
						if (holders.has(u)) sum += per[k]!.partOn(`acc${i}`, paise, date);
					});
					expect(sum).toBe(paise);
				});
				h.sqlite.close();
				handles.splice(handles.indexOf(h), 1);
			}),
			{ numRuns: 60 }
		);
	});

	it("the members' net worth and spending add up to the household's, transfers neutral; a non-holder reads 0", async () => {
		await fc.assert(
			fc.asyncProperty(householdArb, async (hh) => {
				const h = seed();
				const { spendTotal, openingTotal } = build(h, hh.accounts);
				addTransfers(h, hh.accounts.length, hh.transfers); // transfers move money inside the household: neutral
				const range = { from: '2024-01-01', to: '2024-12-31' };
				let nw = 0;
				let spend = 0;
				for (const u of USERS.slice(0, 3)) {
					nw += (await dashboardSummary(h, u)).netWorthPaise;
					spend += (await spendingByCategory(h, u, range)).totalPaise;
				}
				expect(nw).toBe(openingTotal - spendTotal);
				expect(spend).toBe(spendTotal);
				// dan holds nothing: no figure reads an account outside his visible set.
				expect((await dashboardSummary(h, 'dan')).netWorthPaise).toBe(0);
				expect((await spendingByCategory(h, 'dan', range)).totalPaise).toBe(0);
				h.sqlite.close();
				handles.splice(handles.indexOf(h), 1);
			}),
			{ numRuns: 40 }
		);
	});

	it("each viewer's sidebar adds up: account rows to their group, groups to net worth (H2 RD8, 2026-10-30)", async () => {
		await fc.assert(
			fc.asyncProperty(householdArb, async (hh) => {
				const h = seed();
				build(h, hh.accounts);
				addTransfers(h, hh.accounts.length, hh.transfers);
				for (const u of USERS) {
					const groups = await accountSummary(h, u);
					for (const g of groups) expect(g.accounts.reduce((s, a) => s + a.sharePaise, 0)).toBe(g.subtotalPaise);
					expect(groups.reduce((s, g) => s + g.subtotalPaise, 0)).toBe((await dashboardSummary(h, u)).netWorthPaise);
				}
				h.sqlite.close();
				handles.splice(handles.indexOf(h), 1);
			}),
			{ numRuns: 40 }
		);
	});
});
