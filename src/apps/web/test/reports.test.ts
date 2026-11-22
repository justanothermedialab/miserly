/**
 * reports.test.ts — the M10 Reports service (R2 spending + R3 cashflow).
 * ============================================================================
 * Proves the invariants reports.ts owns — the M10 watch-out chief among them:
 *   - RECONCILIATION (hard invariant): R3's total expense == R2's total spend
 *     for the same window, BY CONSTRUCTION (one shared predicate).
 *   - EXCLUSIONS: transfers (categoryless AND explicitly-linked), Neutral-kind
 *     (investments / the close "Balance adjustment"), and valuation marks never
 *     appear in either report.
 *   - NETTING: refunds subtract WITHIN their category (net, not gross).
 *   - UNCATEGORIZED: its own slice, reconciling into the period total.
 *   - INCOME: income-kind inflows classified + netted (reversals subtract).
 *   - MULTI-CURRENCY (MC1): converted via `toBase`; an unrated currency is
 *     EXCLUDED and surfaced in `rateNeededCurrencies` — never a silent 1:1.
 *   - PRIVACY (P0): a non-visible account's spending never enters any total.
 *   - CLOSED-IN-RANGE: spending from an account open during the period still
 *     counts even after it is later closed.
 *   - BINNING: contiguous monthly bins (zero months present), month-to-date.
 *   - DRILL: the leaf transactions sum to the slice they came from.
 * ============================================================================
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createDb } from '../src/lib/server/db/client';
import { allStatements } from '../src/lib/server/db/migrate';
import type { Db } from '../src/lib/server/db/client';
import * as schema from '../src/lib/server/db/schema';
import { closeAccount } from '../src/lib/server/accounts';
import { BALANCE_ADJUSTMENT_CATEGORY_ID } from '../src/lib/server/seed';
import { eq } from 'drizzle-orm';
import {
	spendingByCategory,
	spendingByCategoryByMonth,
	spendingByPayeeByMonth,
	incomeVsExpense,
	categoryTransactions,
	payeeTransactions,
	flowTransactions,
	earliestActivityDate,
	UNCATEGORIZED_KEY,
	NO_PAYEE_KEY,
	type DateRange
} from '../src/lib/server/reports';

let handle: Db | undefined;
afterEach(() => {
	handle?.sqlite.close();
	handle = undefined;
});

// A window comfortably in the past, so the as-of-today clamp never trims it.
const RANGE_2024: DateRange = { from: '2024-01-01', to: '2024-12-31' };

function seed(): Db {
	const h = createDb(':memory:');
	handle = h;
	for (const stmt of allStatements()) h.sqlite.exec(stmt);
	h.db
		.insert(schema.users)
		.values([
			{ id: 'alice', username: 'alice', displayName: 'Alice', role: 'admin' },
			{ id: 'bob', username: 'bob', displayName: 'Bob', role: 'member' }
		])
		.run();
	return h;
}

function addGroup(h: Db, id: string, name: string, kind: 'income' | 'spending' | 'neutral'): void {
	h.db.insert(schema.categoryGroups).values({ id, name, kind }).run();
}
function addCategory(h: Db, id: string, groupId: string, name: string, colour?: string): void {
	h.db.insert(schema.categories).values({ id, groupId, name, colour: colour ?? null }).run();
}

interface AcctSpec {
	id: string;
	ownerId?: string;
	type?: string;
	name?: string;
	currency?: string;
	status?: 'open' | 'closed';
	openingPaise?: number;
	openingDate?: string | null;
}
function addAccount(h: Db, a: AcctSpec): void {
	h.db
		.insert(schema.accounts)
		.values({
			id: a.id,
			ownerId: a.ownerId ?? 'alice',
			type: a.type ?? 'bank',
			name: a.name ?? a.id,
			currency: a.currency ?? 'INR',
			status: a.status ?? 'open',
			openingPaise: a.openingPaise ?? 0,
			openingDate: a.openingDate ?? null
		})
		.run();
}

let seq = 0;
function addTx(
	h: Db,
	t: {
		id: string;
		accountId: string;
		date: string;
		amountPaise: number;
		categoryId?: string | null;
		payeeId?: string | null;
		transferPartnerId?: string | null;
		kind?: 'ordinary' | 'valuationMark';
	}
): void {
	h.db
		.insert(schema.transactions)
		.values({
			id: t.id,
			accountId: t.accountId,
			date: t.date,
			sequence: seq++,
			amountPaise: t.amountPaise,
			categoryId: t.categoryId ?? null,
			payeeId: t.payeeId ?? null,
			transferPartnerId: t.transferPartnerId ?? null,
			kind: t.kind ?? 'ordinary'
		})
		.run();
}

function addPayee(h: Db, id: string, name: string): void {
	h.db.insert(schema.payees).values({ id, displayName: name, nameNormalized: name.toLowerCase() }).run();
}

/** Link two already-inserted rows as a transfer pair (satisfies the partner FK). */
function linkTransfer(h: Db, idA: string, idB: string): void {
	h.db.update(schema.transactions).set({ transferPartnerId: idB }).where(eq(schema.transactions.id, idA)).run();
	h.db.update(schema.transactions).set({ transferPartnerId: idA }).where(eq(schema.transactions.id, idB)).run();
}

/** Seed the system "Balance adjustment" category (Neutral) closeAccount stamps. */
function seedBalanceAdjustment(h: Db): void {
	addGroup(h, 'g-sys', 'System', 'neutral');
	addCategory(h, BALANCE_ADJUSTMENT_CATEGORY_ID, 'g-sys', 'Balance adjustment');
}

/** Store an MC1 aggregation rate (base-per-1-foreign) at scale 6. */
function setRate(h: Db, currency: string, ratePerUnit: number): void {
	h.db
		.insert(schema.rates)
		.values({
			id: `rate-${currency}`,
			currency,
			baseCurrency: 'INR',
			rateScaled: ratePerUnit * 1_000_000,
			scale: 6,
			asOf: '2024-01-01'
		})
		.run();
}

/** The canonical fixture: Food (spending), Salary (income), Investments (neutral). */
function seedCategories(h: Db): void {
	addGroup(h, 'g-food', 'Food', 'spending');
	addCategory(h, 'c-groc', 'g-food', 'Groceries');
	addCategory(h, 'c-eat', 'g-food', 'Eating out');
	addGroup(h, 'g-sal', 'Salary', 'income');
	addCategory(h, 'c-sal', 'g-sal', 'Salary');
	addGroup(h, 'g-inv', 'Investments', 'neutral');
	addCategory(h, 'c-mf', 'g-inv', 'Mutual funds');
}

// ── reconciliation + exclusions ──────────────────────────────────────────────

describe('R2/R3 reconciliation + the exclusion predicate', () => {
	it('R3 total expense == R2 total spend; transfers, Neutral and marks excluded', async () => {
		const h = seed();
		seedCategories(h);
		addAccount(h, { id: 'bank', name: 'HDFC' });
		addAccount(h, { id: 'broker', type: 'stocks', name: 'Zerodha' });

		// Spending (net within category): Groceries −₹1000 with a +₹200 refund → ₹800.
		addTx(h, { id: 't1', accountId: 'bank', date: '2024-06-03', amountPaise: -100_000, categoryId: 'c-groc' });
		addTx(h, { id: 't2', accountId: 'bank', date: '2024-06-10', amountPaise: 20_000, categoryId: 'c-groc' });
		addTx(h, { id: 't3', accountId: 'bank', date: '2024-06-15', amountPaise: -30_000, categoryId: 'c-eat' });
		// Income: salary +₹5000.
		addTx(h, { id: 't4', accountId: 'bank', date: '2024-06-01', amountPaise: 500_000, categoryId: 'c-sal' });
		// Neutral (investment contribution categorized neutral) — excluded.
		addTx(h, { id: 't5', accountId: 'bank', date: '2024-06-20', amountPaise: -200_000, categoryId: 'c-mf' });
		// An uncategorised transfer LEG (linked) — excluded. (A categorised one counts by its
		// category's kind since item 2.5: transfer-categories.test.ts.)
		// (Insert both, THEN link — the self-referential partner FK forbids a
		// forward reference, mirroring transfers.ts's A→B→link order.)
		addTx(h, { id: 't6', accountId: 'bank', date: '2024-06-21', amountPaise: -50_000 });
		addTx(h, { id: 't6b', accountId: 'broker', date: '2024-06-21', amountPaise: 50_000 });
		linkTransfer(h, 't6', 't6b');
		// A valuation-mark row on the bank — must be excluded (never a cash flow).
		addTx(h, { id: 't7', accountId: 'bank', date: '2024-06-25', amountPaise: -99_000, kind: 'valuationMark' });

		const spend = await spendingByCategory(h, 'alice', RANGE_2024);
		const cash = await incomeVsExpense(h, 'alice', RANGE_2024);

		expect(spend.totalPaise).toBe(110_000); // 80_000 groceries + 30_000 eating out
		expect(cash.totalExpensePaise).toBe(spend.totalPaise); // THE hard invariant
		expect(cash.totalIncomePaise).toBe(500_000);
		expect(cash.netPaise).toBe(390_000);

		const food = spend.groups.find((g) => g.groupId === 'g-food')!;
		expect(food.netPaise).toBe(110_000);
		expect(food.categories.find((c) => c.categoryId === 'c-groc')!.netPaise).toBe(80_000);
		expect(food.categories.find((c) => c.categoryId === 'c-eat')!.netPaise).toBe(30_000);
		// The neutral group never appears.
		expect(spend.groups.some((g) => g.groupId === 'g-inv')).toBe(false);
	});

	it('the category decides income and spending on any account; uncategorised rows on a holding stay out', async () => {
		// Income is decided by the category: a Salary row typed on an
		// EPF-like holding and Interest typed inside an FD are income; a fee categorised as spending
		// inside a fund is spending; an uncategorised row and a value update on a holding are not.
		const h = seed();
		seedCategories(h);
		addCategory(h, 'c-int', 'g-sal', 'Interest');
		addAccount(h, { id: 'bank' });
		addAccount(h, { id: 'epf', type: 'otherAsset' });
		addAccount(h, { id: 'fd', type: 'fd' });
		addAccount(h, { id: 'mf', type: 'mutualFunds' });
		addTx(h, { id: 'b1', accountId: 'bank', date: '2024-05-01', amountPaise: 100_000, categoryId: 'c-sal' });
		addTx(h, { id: 'e1', accountId: 'epf', date: '2024-05-31', amountPaise: 26_717_00, categoryId: 'c-sal' });
		addTx(h, { id: 'f1', accountId: 'fd', date: '2024-05-31', amountPaise: 8_875_00, categoryId: 'c-int' });
		addTx(h, { id: 'm1', accountId: 'mf', date: '2024-05-15', amountPaise: -500_00, categoryId: 'c-eat' });
		addTx(h, { id: 'm2', accountId: 'mf', date: '2024-05-20', amountPaise: -7_000_00 });
		addTx(h, { id: 'm3', accountId: 'mf', date: '2024-05-30', amountPaise: 12_000_00, kind: 'valuationMark' });

		const spend = await spendingByCategory(h, 'alice', RANGE_2024);
		const cash = await incomeVsExpense(h, 'alice', RANGE_2024);
		expect(cash.totalIncomePaise).toBe(100_000 + 26_717_00 + 8_875_00);
		expect(spend.totalPaise).toBe(500_00); // the categorised fee only
		expect(cash.totalExpensePaise).toBe(spend.totalPaise);
		expect(spend.groups.some((g) => g.groupId === UNCATEGORIZED_KEY)).toBe(false);

		const income = await flowTransactions(h, 'alice', RANGE_2024, 'income');
		expect(income.map((r) => r.id).sort()).toEqual(['b1', 'e1', 'f1']);
		expect(await categoryTransactions(h, 'alice', RANGE_2024, UNCATEGORIZED_KEY)).toEqual([]);
		// "All time" still starts at the bank and card accounts' activity.
		expect(await earliestActivityDate(h, 'alice')).toBe('2024-05-01');
	});

	it('uncategorized spending is its own slice and reconciles into the total', async () => {
		const h = seed();
		seedCategories(h);
		addAccount(h, { id: 'bank' });
		addTx(h, { id: 'a', accountId: 'bank', date: '2024-03-02', amountPaise: -30_000, categoryId: 'c-groc' });
		addTx(h, { id: 'b', accountId: 'bank', date: '2024-03-05', amountPaise: -40_000, categoryId: null });

		const spend = await spendingByCategory(h, 'alice', RANGE_2024);
		const uncat = spend.groups.find((g) => g.groupId === UNCATEGORIZED_KEY)!;
		expect(uncat.netPaise).toBe(40_000);
		expect(uncat.categories[0]!.categoryId).toBe(UNCATEGORIZED_KEY);
		expect(spend.totalPaise).toBe(70_000);
		// Slices reconcile to the total.
		expect(spend.groups.reduce((s, g) => s + g.netPaise, 0)).toBe(spend.totalPaise);
	});

	it('income nets reversals; a deficit month is signed honestly', async () => {
		const h = seed();
		seedCategories(h);
		addAccount(h, { id: 'bank' });
		addTx(h, { id: 'i1', accountId: 'bank', date: '2024-04-01', amountPaise: 500_000, categoryId: 'c-sal' });
		addTx(h, { id: 'i2', accountId: 'bank', date: '2024-04-05', amountPaise: -100_000, categoryId: 'c-sal' }); // clawback
		addTx(h, { id: 'e1', accountId: 'bank', date: '2024-04-10', amountPaise: -450_000, categoryId: 'c-groc' });

		const cash = await incomeVsExpense(h, 'alice', { from: '2024-04-01', to: '2024-04-30' });
		expect(cash.totalIncomePaise).toBe(400_000); // 500k − 100k reversal
		expect(cash.totalExpensePaise).toBe(450_000);
		expect(cash.netPaise).toBe(-50_000); // deficit, honest sign
	});
});

// ── multi-currency ───────────────────────────────────────────────────────────

describe('multi-currency (MC1): toBase + rate-needed', () => {
	it('converts a rated currency and EXCLUDES an unrated one (never silent 1:1)', async () => {
		const h = seed();
		seedCategories(h);
		addAccount(h, { id: 'inr', currency: 'INR' });
		addAccount(h, { id: 'usd', currency: 'USD' });
		addAccount(h, { id: 'eur', currency: 'EUR' });
		setRate(h, 'USD', 80); // ₹80 / $1 — no EUR rate on purpose
		addTx(h, { id: 'r', accountId: 'inr', date: '2024-05-01', amountPaise: -50_000, categoryId: 'c-groc' });
		addTx(h, { id: 'u', accountId: 'usd', date: '2024-05-02', amountPaise: -1_000, categoryId: 'c-groc' }); // $10 → ₹800
		addTx(h, { id: 'x', accountId: 'eur', date: '2024-05-03', amountPaise: -1_000, categoryId: 'c-groc' }); // unrated

		const spend = await spendingByCategory(h, 'alice', RANGE_2024);
		expect(spend.totalPaise).toBe(50_000 + 80_000); // ₹500 + ₹800; EUR excluded
		expect(spend.rateNeededCurrencies).toEqual(['EUR']);

		const cash = await incomeVsExpense(h, 'alice', RANGE_2024);
		expect(cash.totalExpensePaise).toBe(130_000);
		expect(cash.rateNeededCurrencies).toEqual(['EUR']);
	});
});

// ── privacy ──────────────────────────────────────────────────────────────────

describe('privacy (P0): viewer-scoped, no admin bypass', () => {
	it("the admin's report excludes an account they neither own nor share", async () => {
		const h = seed();
		seedCategories(h);
		addAccount(h, { id: 'bobbank', ownerId: 'bob', name: 'Bob Private' });
		addTx(h, { id: 'b1', accountId: 'bobbank', date: '2024-06-01', amountPaise: -900_000, categoryId: 'c-groc' });

		const spend = await spendingByCategory(h, 'alice', RANGE_2024);
		expect(spend.totalPaise).toBe(0);
		expect(spend.groups).toEqual([]);
		const cash = await incomeVsExpense(h, 'alice', RANGE_2024);
		expect(cash.totalExpensePaise).toBe(0);
		expect(await categoryTransactions(h, 'alice', RANGE_2024, 'c-groc')).toEqual([]);
	});

	it("a joint account's spending counts at each holder's share; the holders' figures add up (R2 RD10)", async () => {
		const h = seed();
		seedCategories(h);
		addAccount(h, { id: 'priv', name: 'Private' });
		addAccount(h, { id: 'joint', name: 'Joint' });
		h.db.insert(schema.accountMembers).values({ accountId: 'joint', userId: 'bob' }).run();
		addTx(h, { id: 'p', accountId: 'priv', date: '2024-06-01', amountPaise: -30_000, categoryId: 'c-groc' });
		addTx(h, { id: 'j', accountId: 'joint', date: '2024-06-02', amountPaise: -70_000, categoryId: 'c-groc' });

		const alice = await spendingByCategory(h, 'alice', RANGE_2024);
		const bob = await spendingByCategory(h, 'bob', RANGE_2024);
		// Equal with bob: alice 30,000 + 35,000; bob sees only the joint account, his half.
		expect(alice.totalPaise).toBe(65_000);
		expect(bob.totalPaise).toBe(35_000);
		expect(alice.totalPaise + bob.totalPaise).toBe(100_000);
	});
});

// ── closed accounts + binning + drill ────────────────────────────────────────

describe('history semantics, binning, and drill', () => {
	it('spending from an account open during the period counts even after it is later closed', async () => {
		const h = seed();
		seedCategories(h);
		seedBalanceAdjustment(h);
		addAccount(h, { id: 'bank', openingPaise: 100_000, openingDate: '2024-01-01' });
		addTx(h, { id: 's', accountId: 'bank', date: '2024-02-05', amountPaise: -40_000, categoryId: 'c-groc' });
		await closeAccount(h, 'bank', { closeDate: '2024-03-01' }); // posts a Neutral zeroing adjustment

		const spend = await spendingByCategory(h, 'alice', RANGE_2024);
		// The ₹400 spend still counts; the close adjustment (Neutral) does NOT.
		expect(spend.totalPaise).toBe(40_000);
	});

	it('bins are contiguous monthly (zero months present), chronological', async () => {
		const h = seed();
		seedCategories(h);
		addAccount(h, { id: 'bank' });
		addTx(h, { id: 'm1', accountId: 'bank', date: '2024-01-10', amountPaise: -10_000, categoryId: 'c-groc' });
		addTx(h, { id: 'm3', accountId: 'bank', date: '2024-03-10', amountPaise: -30_000, categoryId: 'c-groc' });

		const cash = await incomeVsExpense(h, 'alice', { from: '2024-01-01', to: '2024-03-31' });
		expect(cash.bins.map((b) => b.month)).toEqual(['2024-01', '2024-02', '2024-03']);
		expect(cash.bins.map((b) => b.expensePaise)).toEqual([10_000, 0, 30_000]);
		expect(cash.totalExpensePaise).toBe(40_000);
	});

	it('drill leaf transactions sum to their slice', async () => {
		const h = seed();
		seedCategories(h);
		addAccount(h, { id: 'bank', name: 'HDFC' });
		addTx(h, { id: 'd1', accountId: 'bank', date: '2024-07-01', amountPaise: -30_000, categoryId: 'c-groc' });
		addTx(h, { id: 'd2', accountId: 'bank', date: '2024-07-02', amountPaise: 5_000, categoryId: 'c-groc' }); // refund
		addTx(h, { id: 'd3', accountId: 'bank', date: '2024-07-03', amountPaise: -30_000, categoryId: 'c-eat' });

		const spend = await spendingByCategory(h, 'alice', RANGE_2024);
		const groc = spend.groups.find((g) => g.groupId === 'g-food')!.categories.find((c) => c.categoryId === 'c-groc')!;
		const leaf = await categoryTransactions(h, 'alice', RANGE_2024, 'c-groc');
		expect(leaf.map((t) => t.id)).toEqual(['d2', 'd1']); // newest-first by (date, sequence)
		// Net spend = −Σ(leaf amounts) = −(−30_000 + 5_000) = 25_000 = the slice.
		expect(-leaf.reduce((s, t) => s + t.amountPaise, 0)).toBe(groc.netPaise);
		expect(groc.netPaise).toBe(25_000);
	});

	it("R3 drill (RD10): a month's income and spending rows sum to that month's figures", async () => {
		const h = seed();
		seedCategories(h);
		addAccount(h, { id: 'bank', name: 'HDFC' });
		addAccount(h, { id: 'broker', type: 'stocks', name: 'Zerodha' });
		addTx(h, { id: 'i1', accountId: 'bank', date: '2024-07-01', amountPaise: 500_000, categoryId: 'c-sal' });
		addTx(h, { id: 'i2', accountId: 'bank', date: '2024-07-09', amountPaise: -50_000, categoryId: 'c-sal' }); // clawback
		addTx(h, { id: 's1', accountId: 'bank', date: '2024-07-02', amountPaise: -30_000, categoryId: 'c-groc' });
		addTx(h, { id: 's2', accountId: 'bank', date: '2024-07-03', amountPaise: -20_000, categoryId: null });
		addTx(h, { id: 'n1', accountId: 'bank', date: '2024-07-04', amountPaise: -90_000, categoryId: 'c-mf' }); // neutral
		addTx(h, { id: 'o1', accountId: 'bank', date: '2024-08-02', amountPaise: -70_000, categoryId: 'c-groc' }); // next month
		addTx(h, { id: 't', accountId: 'bank', date: '2024-07-05', amountPaise: -40_000 });
		addTx(h, { id: 'tb', accountId: 'broker', date: '2024-07-05', amountPaise: 40_000 });
		linkTransfer(h, 't', 'tb'); // an uncategorised transfer: in neither list

		const july = { from: '2024-07-01', to: '2024-07-31' };
		const bin = (await incomeVsExpense(h, 'alice', RANGE_2024)).bins.find((b) => b.month === '2024-07')!;
		const income = await flowTransactions(h, 'alice', july, 'income');
		const spending = await flowTransactions(h, 'alice', july, 'spending');
		expect(income.map((t) => t.id)).toEqual(['i2', 'i1']);
		expect(spending.map((t) => t.id)).toEqual(['s2', 's1']);
		expect(income.reduce((s, t) => s + t.amountPaise, 0)).toBe(bin.incomePaise);
		expect(-spending.reduce((s, t) => s + t.amountPaise, 0)).toBe(bin.expensePaise);
		expect(await flowTransactions(h, 'bob', july, 'spending')).toEqual([]); // P0
	});

	it('earliestActivityDate picks the earliest opening or first tx across spending accounts', async () => {
		const h = seed();
		seedCategories(h);
		addAccount(h, { id: 'bank', openingPaise: 10_000, openingDate: '2023-05-01' });
		addAccount(h, { id: 'card', type: 'creditCard' });
		addTx(h, { id: 'x', accountId: 'card', date: '2023-02-15', amountPaise: -5_000, categoryId: 'c-groc' });
		expect(await earliestActivityDate(h, 'alice')).toBe('2023-02-15');
		expect(await earliestActivityDate(h, 'bob')).toBe(null); // holds nothing
	});
});

// ── spending by payee (R2 RD13) ──────────────────────────────────────────────

describe('spending by payee (R2 RD13): R2 spending rule, grouped by payee', () => {
	/** Jan on a sole bank account; Feb on a joint one with odd paise, so the shares round. */
	function payeeFixture(): Db {
		const h = seed();
		seedCategories(h);
		addPayee(h, 'p-big', 'BigBasket');
		addPayee(h, 'p-swiggy', 'Swiggy');
		addAccount(h, { id: 'bank', name: 'HDFC' });
		addAccount(h, { id: 'joint', name: 'Joint' });
		addAccount(h, { id: 'broker', type: 'stocks', name: 'Zerodha' });
		h.db.insert(schema.accountMembers).values({ accountId: 'joint', userId: 'bob' }).run();
		addTx(h, { id: 'j1', accountId: 'bank', date: '2024-01-03', amountPaise: -30_000, categoryId: 'c-groc', payeeId: 'p-big' });
		addTx(h, { id: 'j2', accountId: 'bank', date: '2024-01-04', amountPaise: 5_000, categoryId: 'c-groc', payeeId: 'p-big' }); // refund
		addTx(h, { id: 'j3', accountId: 'bank', date: '2024-01-05', amountPaise: -12_345, categoryId: 'c-eat', payeeId: 'p-swiggy' });
		addTx(h, { id: 'j4', accountId: 'bank', date: '2024-01-06', amountPaise: -7_000 }); // uncategorised, no payee
		addTx(h, { id: 'j5', accountId: 'bank', date: '2024-01-07', amountPaise: -90_000, categoryId: 'c-mf', payeeId: 'p-big' }); // neutral: out
		addTx(h, { id: 'j6', accountId: 'bank', date: '2024-01-08', amountPaise: -40_000, payeeId: 'p-swiggy' });
		addTx(h, { id: 'j6b', accountId: 'broker', date: '2024-01-08', amountPaise: 40_000 });
		linkTransfer(h, 'j6', 'j6b'); // an uncategorised transfer: out
		addTx(h, { id: 'f1', accountId: 'joint', date: '2024-02-02', amountPaise: -333, categoryId: 'c-groc', payeeId: 'p-big' });
		addTx(h, { id: 'f2', accountId: 'joint', date: '2024-02-02', amountPaise: -333, categoryId: 'c-groc', payeeId: 'p-swiggy' });
		addTx(h, { id: 'f3', accountId: 'joint', date: '2024-02-03', amountPaise: -101, categoryId: 'c-eat' });
		return h;
	}
	const Q1: DateRange = { from: '2024-01-01', to: '2024-03-31' };

	it('the by-payee figures equal the by-category ones for every month and in total, at each share', async () => {
		const h = payeeFixture();
		for (const viewer of ['alice', 'bob']) {
			const byCat = await spendingByCategoryByMonth(h, viewer, Q1);
			const byPayee = await spendingByPayeeByMonth(h, viewer, Q1);
			expect(byPayee.months).toEqual(byCat.months);
			expect(byPayee.monthTotals).toEqual(byCat.monthTotals);
			expect(byPayee.totalPaise).toBe(byCat.totalPaise);
			expect(byPayee.totalPaise).toBe((await spendingByCategory(h, viewer, Q1)).totalPaise);
			// The rows add up to the month totals exactly.
			byPayee.months.forEach((_, i) => {
				expect(byPayee.payees.reduce((s, p) => s + (p.byMonth[i] ?? 0), 0)).toBe(byPayee.monthTotals[i]);
			});
		}
		const alice = await spendingByPayeeByMonth(h, 'alice', Q1);
		const row = (id: string) => alice.payees.find((p) => p.payeeId === id);
		expect(row('p-big')!.name).toBe('BigBasket');
		expect(row('p-big')!.byMonth[0]).toBe(25_000); // the refund nets, the fund row stays out
		expect(row('p-swiggy')!.byMonth[0]).toBe(12_345); // the transfer stays out
		expect(row(NO_PAYEE_KEY)!.name).toBe('No payee');
		expect(row(NO_PAYEE_KEY)!.byMonth[0]).toBe(7_000);
		// Largest total first.
		expect(alice.payees.map((p) => p.payeeId)).toEqual(['p-big', 'p-swiggy', NO_PAYEE_KEY]);
	});

	it("a payee's drill rows sum to its bar; No payee drills the rows without one", async () => {
		const h = payeeFixture();
		const jan: DateRange = { from: '2024-01-01', to: '2024-01-31' };
		const byPayee = await spendingByPayeeByMonth(h, 'alice', jan);
		const big = await payeeTransactions(h, 'alice', jan, 'p-big');
		expect(big.map((t) => t.id)).toEqual(['j2', 'j1']);
		expect(-big.reduce((s, t) => s + t.amountPaise, 0)).toBe(byPayee.payees.find((p) => p.payeeId === 'p-big')!.totalPaise);
		const none = await payeeTransactions(h, 'alice', jan, NO_PAYEE_KEY);
		expect(none.map((t) => t.id)).toEqual(['j4']);
		expect((await payeeTransactions(h, 'alice', jan, 'p-swiggy')).map((t) => t.id)).toEqual(['j3']);
	});

	it("P0: a member's private account never reaches another viewer's payees or drill", async () => {
		const h = payeeFixture();
		addPayee(h, 'p-secret', 'Secret shop');
		addAccount(h, { id: 'bobbank', ownerId: 'bob', name: 'Bob Private' });
		addTx(h, { id: 'b1', accountId: 'bobbank', date: '2024-01-10', amountPaise: -900_000, categoryId: 'c-groc', payeeId: 'p-secret' });
		addTx(h, { id: 'b2', accountId: 'bobbank', date: '2024-01-11', amountPaise: -50_000, categoryId: 'c-groc' });

		const alice = await spendingByPayeeByMonth(h, 'alice', Q1);
		expect(alice.payees.some((p) => p.payeeId === 'p-secret' || p.name === 'Secret shop')).toBe(false);
		expect(alice.payees.find((p) => p.payeeId === NO_PAYEE_KEY)!.byMonth[0]).toBe(7_000);
		expect(await payeeTransactions(h, 'alice', Q1, 'p-secret')).toEqual([]);
		expect((await payeeTransactions(h, 'alice', Q1, NO_PAYEE_KEY)).some((t) => t.accountId === 'bobbank')).toBe(false);
		// Bob sees his own.
		const bob = await spendingByPayeeByMonth(h, 'bob', Q1);
		expect(bob.payees.find((p) => p.payeeId === 'p-secret')!.totalPaise).toBe(900_000);
	});
});
