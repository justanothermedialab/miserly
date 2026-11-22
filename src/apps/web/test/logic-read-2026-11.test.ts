/**
 * logic-read-2026-11.test.ts: the evidence behind a read of the money logic.
 * ============================================================================
 * Each test builds one finding's worked example on an in-memory DB through the real services.
 * A finding not yet fixed asserts the figure the app gives TODAY, with the figure a person expects
 * in a comment, so a later fix flips it (the red team's pattern). A test marked "fixed" asserts
 * the right figure and stays as the regression test. "Today" is pinned to 2026-11-11.
 * ============================================================================
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { createDb } from '../src/lib/server/db/client';
import { allStatements } from '../src/lib/server/db/migrate';
import type { Db } from '../src/lib/server/db/client';
import * as schema from '../src/lib/server/db/schema';
import { createAccount, createHoldingAccount } from '../src/lib/server/accounts';
import { createTransaction, deleteTransaction, duplicateTransaction, DuplicateTransactionError, inboxTransactions, rememberedTransferCategories, updateTransaction } from '../src/lib/server/transactions';
import { rememberedTransferCategory } from '../src/lib/transfer-targets';
import { createTransfer } from '../src/lib/server/transfers';
import { postValuationMark } from '../src/lib/server/marks';
import { seedStarterCategories } from '../src/lib/server/seed';
import { holdingMetrics, returnFlags } from '../src/lib/server/dashboard';
import { incomeVsExpense, spendingByCategory } from '../src/lib/server/reports';
import { workedOutFigures } from '../src/lib/modules';
import type { ActualBudget, ActualRow } from '../src/lib/server/import/actual-read';
import { previewImport, runImport, defaultChoices, type ImportChoices } from '../src/lib/server/import/actual-import';
import { transferCounts } from '../src/lib/import-counts';

let h: Db;
beforeEach(async () => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(new Date('2026-11-11T06:00:00Z'));
	h = createDb(':memory:');
	for (const stmt of allStatements()) h.sqlite.exec(stmt);
	h.db.insert(schema.users).values([{ id: 'alice', username: 'alice', displayName: 'Alice', role: 'admin' }]).run();
	await seedStarterCategories(h.db);
});
afterEach(() => {
	vi.useRealTimers();
	h.sqlite.close();
});

const ALICE = { userId: 'alice' };
const L = (rupees: number) => rupees * 100; // rupees → paise
const liveRows = (accountId: string) =>
	h.db.select().from(schema.transactions)
		.where(and(eq(schema.transactions.accountId, accountId), isNull(schema.transactions.deletedAt))).all();
const NOV = { from: '2026-11-01', to: '2026-11-30' };

/** A live category by group and name (several groups have an "Other"). */
function catIn(group: string, name: string): string {
	const g = h.db.select().from(schema.categoryGroups)
		.where(and(eq(schema.categoryGroups.name, group), isNull(schema.categoryGroups.deletedAt))).get();
	if (!g) throw new Error(`no group ${group}`);
	const c = h.db.select().from(schema.categories)
		.where(and(eq(schema.categories.groupId, g.id), eq(schema.categories.name, name), isNull(schema.categories.deletedAt))).get();
	if (!c) throw new Error(`no category ${group}, ${name}`);
	return c.id;
}
/** Where a category of ours sits: its name, its group's name and the group's kind. */
function placeOf(categoryId: string | null) {
	if (categoryId === null) return null;
	const c = h.db.select().from(schema.categories).where(eq(schema.categories.id, categoryId)).get()!;
	const g = h.db.select().from(schema.categoryGroups).where(eq(schema.categoryGroups.id, c.groupId)).get()!;
	return { category: c.name, group: g.name, kind: g.kind };
}
const accountNamed = (name: string) =>
	h.db.select().from(schema.accounts).where(and(eq(schema.accounts.name, name), isNull(schema.accounts.deletedAt))).get()!;
const payeeName = (payeeId: string | null) =>
	payeeId === null ? null : h.db.select().from(schema.payees).where(eq(schema.payees.id, payeeId)).get()!.displayName;
/** The category an Actual category came in as (from the import's own record). */
const importedCategory = (actualId: string) =>
	h.db.select().from(schema.importItems)
		.where(and(eq(schema.importItems.kind, 'category'), eq(schema.importItems.actualId, actualId))).get()?.ourId ?? null;

// ── An Actual export, as `readActualExport` hands it to the import ──
type RowIn = Pick<ActualRow, 'id' | 'accountId' | 'date' | 'amount'> & Partial<ActualRow>;
const arow = (r: RowIn): ActualRow => ({
	payeeId: null, categoryId: null, notes: null, transferId: null, transferAccountId: null,
	splitId: null, sortOrder: 0, starting: false, adjustment: false, ...r
});
const abudget = (b: Partial<ActualBudget>): ActualBudget => ({
	budgetId: 'test-budget', budgetName: 'Test', accounts: [], groups: [], categories: [], payees: [], rows: [],
	splits: 0, deletedRows: 0, ...b
});
const acct = (id: string, name: string, offBudget = false) => ({ id, name, offBudget, closed: false });
const grp = (id: string, name: string, isIncome = false) => ({ id, name, isIncome, hidden: false });
const acat = (id: string, groupId: string, name: string) => ({ id, groupId, name, hidden: false });
/** Actual's transfer: two rows naming each other (and each other's account, through the payee). */
const atransfer = (id: string, from: string, to: string, date: string, paise: number, categoryId: string | null = null): ActualRow[] => [
	arow({ id: `${id}-out`, accountId: from, date, amount: -paise, transferId: `${id}-in`, transferAccountId: to, categoryId }),
	arow({ id: `${id}-in`, accountId: to, date, amount: paise, transferId: `${id}-out`, transferAccountId: from })
];
const importAll = async (budget: ActualBudget, edit: (c: ImportChoices) => ImportChoices = (c) => c) =>
	runImport(h, 'alice', budget, 'test.zip', edit(defaultChoices(previewImport(h, 'alice', budget))));

describe('L2 duplicating a value update', () => {
	it('is refused in plain words and the value, Invested and return stay put (fixed 2026-11-11)', async () => {
		const mf = await createHoldingAccount(h, {
			ownerId: 'alice', type: 'mutualFunds', name: 'Parag Parikh', currency: 'INR',
			investedPaise: L(1_00_000), investedDate: '2025-04-01', currentValuePaise: null
		});
		const mark = await postValuationMark(h, ALICE, { accountId: mf.id, targetPaise: L(1_50_000), date: '2025-10-31' });
		// Was: the copy was an ordinary row of +₹50,000, so ₹2,00,000, Invested ₹1,00,000, +₹1,00,000 (+100.0 %).
		await expect(duplicateTransaction(h, ALICE, mark.id!)).rejects.toBeInstanceOf(DuplicateTransactionError);
		await expect(duplicateTransaction(h, ALICE, mark.id!)).rejects.toThrow("A value update can't be duplicated. Use Update value to change the value.");
		expect(liveRows(mf.id)).toHaveLength(1);
		const m = (await holdingMetrics(h, 'alice', mf.id))!;
		expect([m.currentValuePaise, m.costBasisPaise, m.returnPaise]).toEqual([L(1_50_000), L(1_00_000), L(50_000)]);
		expect(m.returnPct).toBeCloseTo(0.5, 6);
	});
});

describe('L3 Net invested and a transfer into a fund with no category', () => {
	it('counts ₹0 of ₹30,000 moved into two funds with no category: left as decided (R3 RD7, RD13)', async () => {
		const hdfc = await createAccount(h, { ownerId: 'alice', type: 'bank', name: 'HDFC Salary', currency: 'INR', openingPaise: L(2_00_000), openingDate: '2026-01-01' });
		const fund = (name: string, invested: number) => createHoldingAccount(h, {
			ownerId: 'alice', type: 'mutualFunds', name, currency: 'INR',
			investedPaise: L(invested), investedDate: '2026-01-01', currentValuePaise: null
		});
		const ppfas = await fund('Parag Parikh Flexi Cap', 1_00_000);
		const nifty = await fund('UTI Nifty 50 Index', 50_000);
		await createTransfer(h, ALICE, { fromId: hdfc.id, toId: ppfas.id, date: '2026-11-05', amountPaise: L(20_000) });
		await createTransfer(h, ALICE, { fromId: hdfc.id, toId: nifty.id, date: '2026-11-10', amountPaise: L(10_000) });

		// Each fund's own Invested rose by exactly what moved in.
		expect((await holdingMetrics(h, 'alice', ppfas.id))!.costBasisPaise).toBe(L(1_20_000));
		expect((await holdingMetrics(h, 'alice', nifty.id))!.costBasisPaise).toBe(L(60_000));
		const r = await incomeVsExpense(h, 'alice', NOV);
		// The category stays the one control; rows typed with none are left alone (R3 RD7, RD13).
		expect(r.totalInvestedPaise).toBe(0);
		expect(r.bins.find((b) => b.month === '2026-11')!.investedPaise).toBe(0);
		expect(r.totalExpensePaise).toBe(0); // not spending either: the money is in no report
		expect(await inboxTransactions(h, 'alice')).toHaveLength(0);
		// And nothing is guessed for them: no categorised transfer went in, so none is remembered.
		expect(await rememberedTransferCategories(h.db, 'alice')).toEqual({});
	});

	it('a transfer remembers its category per destination, looked up from the latest one (fixed 2026-11-14)', async () => {
		const at = (iso: string) => vi.setSystemTime(new Date(iso));
		const hdfc = await createAccount(h, { ownerId: 'alice', type: 'bank', name: 'HDFC Salary', currency: 'INR', openingPaise: L(5_00_000), openingDate: '2026-01-01' });
		const sbi = await createAccount(h, { ownerId: 'alice', type: 'bank', name: 'SBI', currency: 'INR', openingPaise: 0, openingDate: '2026-01-01' });
		const fund = (name: string) => createHoldingAccount(h, {
			ownerId: 'alice', type: 'mutualFunds', name, currency: 'INR',
			investedPaise: L(1_00_000), investedDate: '2026-01-01', currentValuePaise: null
		});
		const ppfas = await fund('Parag Parikh Flexi Cap');
		const nifty = await fund('UTI Nifty 50 Index');
		const sip = catIn('Investments', 'SIP');
		const other = catIn('Investments', 'Other');
		const remembered = () => rememberedTransferCategories(h.db, 'alice');

		// Picked the first time; nothing remembered for a fund nothing categorised went into.
		at('2026-11-05T06:00:00Z');
		const t1 = await createTransfer(h, ALICE, { fromId: hdfc.id, toId: ppfas.id, date: '2026-11-05', amountPaise: L(20_000), categoryId: sip });
		expect(await remembered()).toEqual({ [ppfas.id]: sip });
		// The form fills it for the next transfer into that fund, typed on the bank (money out) or on
		// the fund (money in); a bank to bank transfer takes no category, so nothing is filled.
		const map = await remembered();
		expect(rememberedTransferCategory(map, hdfc, ppfas, 'out')).toBe(sip);
		expect(rememberedTransferCategory(map, ppfas, hdfc, 'in')).toBe(sip);
		expect(rememberedTransferCategory(map, hdfc, nifty, 'out')).toBeNull();
		expect(rememberedTransferCategory(map, hdfc, sbi, 'out')).toBeNull();
		// Typed with it, it is Net invested.
		expect((await incomeVsExpense(h, 'alice', NOV)).totalInvestedPaise).toBe(L(20_000));

		// The latest one wins; deleting it falls back to the one before.
		at('2026-11-06T06:00:00Z');
		const t2 = await createTransfer(h, ALICE, { fromId: hdfc.id, toId: ppfas.id, date: '2026-11-06', amountPaise: L(5_000), categoryId: other });
		expect((await remembered())[ppfas.id]).toBe(other);
		at('2026-11-07T06:00:00Z');
		const t2row = h.db.select().from(schema.transactions).where(eq(schema.transactions.id, t2.fromTxId)).get()!;
		await deleteTransaction(h, ALICE, t2.fromTxId, t2row.updatedAt);
		expect((await remembered())[ppfas.id]).toBe(sip);

		// Money out of the fund into the bank is remembered for the bank, its destination.
		at('2026-11-08T06:00:00Z');
		await createTransfer(h, ALICE, { fromId: ppfas.id, toId: hdfc.id, date: '2026-11-08', amountPaise: L(3_000), categoryId: other });
		expect(await remembered()).toEqual({ [ppfas.id]: sip, [hdfc.id]: other });

		// Clearing the category on the only categorised transfer in: nothing remembered for that fund.
		at('2026-11-09T06:00:00Z');
		const t1row = h.db.select().from(schema.transactions).where(eq(schema.transactions.id, t1.fromTxId)).get()!;
		await updateTransaction(h, ALICE, t1.fromTxId, { categoryId: null }, t1row.updatedAt);
		expect(await remembered()).toEqual({ [hdfc.id]: other });

		// A category that can't be picked now (hidden) fills nothing (N-12).
		h.db.update(schema.categories).set({ hidden: true }).where(eq(schema.categories.id, other)).run();
		expect(await remembered()).toEqual({});
		// Another member sees none of Alice's.
		h.db.insert(schema.users).values({ id: 'bob', username: 'bob', displayName: 'Bob', role: 'member' }).run();
		expect(await rememberedTransferCategories(h.db, 'bob')).toEqual({});
	});
});

describe('L4 the Actual import matches a category by name only inside the same kind', () => {
	it("files Actual's income Rent under Income: income ₹25,000, Rent spending ₹46,000 (fixed 2026-11-14)", async () => {
		const budget = abudget({
			accounts: [acct('a-hdfc', 'HDFC')],
			groups: [grp('g-inc', 'Income', true), grp('g-bills', 'Bills')],
			categories: [
				acat('c-rent-in', 'g-inc', 'Rent'), acat('c-rent-out', 'g-bills', 'Rent'),
				acat('c-int', 'g-bills', 'Interest'), acat('c-sal', 'g-bills', 'Salary')
			],
			payees: [{ id: 'p-tenant', name: 'Tenant' }, { id: 'p-landlord', name: 'Landlord' }],
			rows: [
				arow({ id: 'r0', accountId: 'a-hdfc', date: '2026-10-01', amount: L(1_00_000), starting: true }),
				arow({ id: 'r1', accountId: 'a-hdfc', date: '2026-11-01', amount: L(25_000), categoryId: 'c-rent-in', payeeId: 'p-tenant' }),
				arow({ id: 'r2', accountId: 'a-hdfc', date: '2026-11-03', amount: -L(46_000), categoryId: 'c-rent-out', payeeId: 'p-landlord' })
			]
		});
		await importAll(budget);
		const rows = liveRows(accountNamed('HDFC').id);
		const rentIn = rows.find((x) => x.amountPaise === L(25_000))!;
		const rentOut = rows.find((x) => x.amountPaise === -L(46_000))!;
		// Actual's income group lands on Miserly's Income, which has no Rent: one is made there.
		// Was: the one "Rent" anywhere, Essentials, Rent (spending), so the rent received read as a refund.
		expect(placeOf(rentIn.categoryId)).toEqual({ category: 'Rent', group: 'Income', kind: 'income' });
		expect(placeOf(rentOut.categoryId)).toEqual({ category: 'Rent', group: 'Essentials', kind: 'spending' });

		const r = await incomeVsExpense(h, 'alice', NOV);
		// Was: income ₹0, expense ₹21,000. Net cashflow (−₹21,000) is the same either way.
		expect(r.totalIncomePaise).toBe(L(25_000));
		expect(r.totalExpensePaise).toBe(L(46_000));
		expect(r.netPaise).toBe(-L(21_000));
		const s = await spendingByCategory(h, 'alice', NOV);
		const rent = s.groups.find((g) => g.name === 'Essentials')!.categories.find((c) => c.name === 'Rent')!;
		expect(rent.netPaise).toBe(L(46_000));

		// The other starter names that collide: an expense "Interest" (paid) and "Salary" (a cook's pay).
		// Was: Income's. Now made in a new group named as Actual's, of the Spending kind.
		expect(placeOf(importedCategory('c-int'))).toEqual({ category: 'Interest', group: 'Bills', kind: 'spending' });
		expect(placeOf(importedCategory('c-sal'))).toEqual({ category: 'Salary', group: 'Bills', kind: 'spending' });
		const interestPaid = h.db.select().from(schema.categories).where(eq(schema.categories.id, importedCategory('c-int')!)).get()!;
		expect(interestPaid.countsAsReturn).toBe(false); // only a new Interest in the income group counts as return
	});
});

describe('L5 the Actual import: a transfer to an account not brought over', () => {
	it('comes in under Transfer to Self, which reports leave out; the preview counts it (fixed 2026-11-14)', async () => {
		const budget = abudget({
			accounts: [acct('a-hdfc', 'HDFC'), acct('a-sbi', 'Old SBI')],
			rows: [
				arow({ id: 'r0', accountId: 'a-hdfc', date: '2026-10-01', amount: L(1_00_000), starting: true }),
				arow({ id: 'r1', accountId: 'a-sbi', date: '2026-10-01', amount: L(60_000), starting: true }),
				...atransfer('t1', 'a-hdfc', 'a-sbi', '2026-11-04', L(50_000))
			]
		});
		// The preview's line: one transfer goes to an account left out (Old SBI unticked).
		const p = previewImport(h, 'alice', budget);
		expect(transferCounts(p.accounts, new Set(['a-hdfc']))).toEqual({ pairs: 0, leftOut: 1 });
		expect(transferCounts(p.accounts, new Set(['a-hdfc', 'a-sbi']))).toEqual({ pairs: 1, leftOut: 0 });

		await importAll(budget, (c) => ({ ...c, accounts: { ...c.accounts, 'a-sbi': { ...c.accounts['a-sbi']!, include: false } } }));
		const hdfc = accountNamed('HDFC');
		const out = liveRows(hdfc.id).find((x) => x.date === '2026-11-04')!;
		expect([out.amountPaise, out.transferPartnerId, payeeName(out.payeeId)]).toEqual([-L(50_000), null, 'Old SBI']);
		// Was: no category, so ₹50,000 of Uncategorized spending, and the row in To categorize.
		expect(placeOf(out.categoryId)).toEqual({ category: 'Transfer to Self', group: 'Adjustments', kind: 'neutral' });
		const self = h.db.select().from(schema.categories).where(eq(schema.categories.id, out.categoryId!)).get()!;
		expect(self.countsAsReturn).toBe(false);
		expect((await spendingByCategory(h, 'alice', NOV)).totalPaise).toBe(0);
		const r = await incomeVsExpense(h, 'alice', NOV);
		expect([r.totalIncomePaise, r.totalExpensePaise, r.totalInvestedPaise]).toEqual([0, 0, 0]);
		expect(await inboxTransactions(h, 'alice')).toHaveLength(0);

		// Old SBI ticked on a second import: its half can't link to the one already here, so the
		// preview counts it as left out and it comes in alone, under the same category.
		const p2 = previewImport(h, 'alice', budget);
		expect(transferCounts(p2.accounts, new Set(['a-hdfc', 'a-sbi']))).toEqual({ pairs: 0, leftOut: 1 });
		await importAll(budget);
		const sbiIn = liveRows(accountNamed('Old SBI').id).find((x) => x.date === '2026-11-04')!;
		expect([sbiIn.amountPaise, sbiIn.categoryId, sbiIn.transferPartnerId, payeeName(sbiIn.payeeId)]).toEqual([L(50_000), out.categoryId, null, 'HDFC']);
		expect(liveRows(hdfc.id).find((x) => x.id === out.id)!.transferPartnerId).toBeNull(); // still never linked (logged, not built)
		expect((await spendingByCategory(h, 'alice', NOV)).totalPaise).toBe(0);
		expect(await inboxTransactions(h, 'alice')).toHaveLength(0);
		// One Transfer to Self, made once.
		expect(h.db.select().from(schema.categories).where(eq(schema.categories.name, 'Transfer to Self')).all()).toHaveLength(1);
	});

	it('a transfer that has a category in Actual keeps it; one into an account closed here is counted as left out', async () => {
		const accounts = [
			{ actualId: 'a', transferTo: ['b', 'c', ''], existing: null },
			{ actualId: 'b', transferTo: ['a'], existing: null },
			{ actualId: 'c', transferTo: ['a'], existing: { closed: true } }
		];
		// c is already here and closed: its rows don't come in, so a's leg to it comes in alone; so
		// does a's leg whose other half can't come in ('').
		expect(transferCounts(accounts, new Set(['a', 'b', 'c']))).toEqual({ pairs: 1, leftOut: 2 });
		// A closed account's own legs are never counted (its rows are skipped).
		expect(transferCounts(accounts, new Set(['c']))).toEqual({ pairs: 0, leftOut: 0 });
	});
});

describe('L6 the Actual import: a plain withdrawal on a holding, deposits as money put in', () => {
	it('is money taken out: value ₹5,40,000, Invested ₹5,40,000, return ₹0 (fixed 2026-11-14)', async () => {
		const deposits = Array.from({ length: 12 }, (_, i) => {
			const d = new Date(Date.UTC(2025, 10 + i, 1)).toISOString().slice(0, 10); // 1 Nov 2025 to 1 Oct 2026
			return arow({ id: `d${i}`, accountId: 'a-epf', date: d, amount: L(20_000), payeeId: 'p-inf' });
		});
		const budget = abudget({
			accounts: [acct('a-epf', 'EPF', true)],
			payees: [{ id: 'p-inf', name: 'Infosys Ltd' }],
			rows: [
				arow({ id: 'r0', accountId: 'a-epf', date: '2025-10-01', amount: L(5_00_000), starting: true }),
				...deposits,
				arow({ id: 'w1', accountId: 'a-epf', date: '2026-11-05', amount: -L(2_00_000) })
			]
		});
		const p = previewImport(h, 'alice', budget);
		const pa = p.accounts[0]!;
		expect(pa.addAs).toBe('epf:0');
		expect(defaultChoices(p).accounts['a-epf']!.deposits).toBe('moneyIn');
		// The preview's Invested follows (was ₹7,40,000); the count of plain deposits is unchanged.
		expect([pa.plainDeposits, pa.investedIfMoneyIn, pa.balancePaise]).toEqual([12, L(5_40_000), L(5_40_000)]);
		expect(pa.investedIfReturn).toBe(L(5_00_000)); // as return: only the opening is money put in
		await importAll(budget);

		const epf = accountNamed('EPF');
		const rows = liveRows(epf.id);
		const w = rows.find((x) => x.amountPaise === -L(2_00_000))!;
		const dep = rows.find((x) => x.amountPaise === L(20_000))!;
		// Was: no category. Now the deposits' category, EPF's Salary in Income.
		expect(w.categoryId).toBe(dep.categoryId);
		expect(placeOf(w.categoryId)).toEqual({ category: 'Salary', group: 'Income', kind: 'income' });
		const m = (await holdingMetrics(h, 'alice', epf.id))!;
		// Was: Invested ₹7,40,000, −₹2,00,000 (−27.0 %). The withdrawal takes its share out (all of it,
		// at a value of ₹7,40,000).
		expect([m.currentValuePaise, m.costBasisPaise, m.returnPaise]).toEqual([L(5_40_000), L(5_40_000), 0]);
		expect(m.returnPct).toBe(0);
		// Under Salary, the withdrawal subtracts from November's income, as the deposits added to theirs.
		expect((await incomeVsExpense(h, 'alice', NOV)).totalIncomePaise).toBe(-L(2_00_000));
	});

	it('on a holding left at Return, a plain withdrawal stays an uncategorised row (growth)', async () => {
		const budget = abudget({
			accounts: [acct('a-mf', 'Kuvera MF', true)],
			rows: [
				arow({ id: 'r0', accountId: 'a-mf', date: '2025-10-01', amount: L(1_00_000), starting: true }),
				arow({ id: 'd1', accountId: 'a-mf', date: '2026-01-01', amount: L(10_000) }),
				arow({ id: 'w1', accountId: 'a-mf', date: '2026-02-01', amount: -L(5_000) })
			]
		});
		expect(defaultChoices(previewImport(h, 'alice', budget)).accounts['a-mf']!.deposits).toBe('return');
		await importAll(budget);
		expect(liveRows(accountNamed('Kuvera MF').id).every((x) => x.categoryId === null)).toBe(true);
	});
});

describe("L7 PPF's Deposited this year", () => {
	it('reads ₹1,50,000 of ₹1,50,000 for a deposit typed as a plain row, as Invested counts it (fixed 2026-11-14)', async () => {
		const ppf = await createHoldingAccount(h, {
			ownerId: 'alice', type: 'ppf', name: 'PPF (SBI)', currency: 'INR',
			investedPaise: L(4_00_000), investedDate: '2025-06-15', currentValuePaise: null,
			infoJson: JSON.stringify({ openedOn: '2019-06-15' })
		});
		// As the import files it when deposits are money put in: Investments, Other.
		await createTransaction(h, ALICE, { accountId: ppf.id, date: '2026-04-05', amountPaise: L(1_50_000), categoryId: catIn('Investments', 'Other') });

		// Interest typed plainly under Income, Interest (counts as return): not a deposit.
		await createTransaction(h, ALICE, { accountId: ppf.id, date: '2026-04-06', amountPaise: L(30_000), categoryId: catIn('Income', 'Interest') });
		// An uncategorised plain row is growth: not a deposit either.
		await createTransaction(h, ALICE, { accountId: ppf.id, date: '2026-04-07', amountPaise: L(1_000) });

		const acc = accountNamed('PPF (SBI)');
		const rows = liveRows(ppf.id);
		const flags = returnFlags(h.db, rows);
		const flagged = rows.map((r) => (flags.has(r.id) ? { ...r, countsAsReturn: flags.get(r.id)! } : r));
		const fig = workedOutFigures('ppf', acc.infoJson, flagged, '2026-11-11').find((f) => f.kind === 'limit')!;
		// Was: ₹0 (transfers only).
		expect(fig).toMatchObject({ kind: 'limit', paise: L(1_50_000), limitPaise: L(1_50_000) });
		expect((await holdingMetrics(h, 'alice', ppf.id))!.costBasisPaise).toBe(L(5_50_000));
	});
});

describe('Importing an Actual group named "Investment" (singular) used on bank to fund transfers', () => {
	const budget = abudget({
		accounts: [acct('a-hdfc', 'HDFC'), acct('a-kuv', 'Kuvera MF', true)],
		groups: [grp('g-inc', 'Income', true), grp('g-inv', 'Investment')],
		categories: [acat('c-mf', 'g-inv', 'Mutual funds'), acat('c-sip', 'g-inv', 'SIP')],
		rows: [
			arow({ id: 'r0', accountId: 'a-hdfc', date: '2026-10-01', amount: L(2_00_000), starting: true }),
			arow({ id: 'r1', accountId: 'a-kuv', date: '2026-10-01', amount: L(1_00_000), starting: true }),
			...atransfer('t1', 'a-hdfc', 'a-kuv', '2026-11-05', L(20_000), 'c-mf'),
			...atransfer('t2', 'a-hdfc', 'a-kuv', '2026-11-06', L(10_000), 'c-sip')
		]
	});
	const legs = () => {
		const l = liveRows(accountNamed('HDFC').id).filter((x) => x.transferPartnerId);
		return { mf: l.find((x) => x.amountPaise === -L(20_000))!, sip: l.find((x) => x.amountPaise === -L(10_000))! };
	};

	it('defaults to Investments: its categories sit only on transfers into a holding (O23)', async () => {
		const p = previewImport(h, 'alice', budget);
		// The preview asks this group's kind (Spending, as in Actual, or Investments). Was: Spending.
		expect(p.transferGroups.map((g) => [g.name, [...g.holdings], g.defaultKind])).toEqual([['Investment', ['Kuvera MF'], 'investments']]);
		expect(defaultChoices(p).groupKinds).toEqual({ 'g-inv': 'investments' });
		await importAll(budget);
		const r = await incomeVsExpense(h, 'alice', NOV);
		expect(r.totalExpensePaise).toBe(0);
		expect(r.totalInvestedPaise).toBe(L(30_000));
	});

	it('a choice missing from the request comes in as previewed: Investments', async () => {
		await importAll(budget, (c) => ({ ...c, groupKinds: {} }));
		expect(placeOf(legs().mf.categoryId)).toEqual({ category: 'Mutual funds', group: 'Investment', kind: 'investments' });
	});

	it('stays Spending when one of its categories is also on a plain row, or on a transfer into a loan', async () => {
		const plain = abudget({ ...budget, rows: [...budget.rows, arow({ id: 'r9', accountId: 'a-hdfc', date: '2026-11-07', amount: -L(500), categoryId: 'c-sip' })] });
		expect(previewImport(h, 'alice', plain).transferGroups.map((g) => g.defaultKind)).toEqual(['spending']);
		const loan = abudget({
			accounts: [acct('a-hdfc', 'HDFC'), acct('a-loan', 'SBI Home Loan', true)],
			groups: [grp('g-inc', 'Income', true), grp('g-emi', 'Loans')],
			categories: [acat('c-emi', 'g-emi', 'EMI')],
			rows: [
				arow({ id: 'r0', accountId: 'a-hdfc', date: '2026-10-01', amount: L(2_00_000), starting: true }),
				arow({ id: 'r1', accountId: 'a-loan', date: '2026-10-01', amount: -L(20_00_000), starting: true }),
				...atransfer('t1', 'a-hdfc', 'a-loan', '2026-11-05', L(30_000), 'c-emi')
			]
		});
		const p = previewImport(h, 'alice', loan);
		expect(p.transferGroups.map((g) => [g.name, g.defaultKind])).toEqual([['Loans', 'spending']]);
		expect(defaultChoices(p).groupKinds).toEqual({ 'g-emi': 'spending' });
	});

	it('with Spending chosen: a new Spending group, both categories in it', async () => {
		await importAll(budget, (c) => ({ ...c, groupKinds: { 'g-inv': 'spending' } }));

		const { mf, sip } = legs();
		// "Mutual funds": no category of that name here, so it is made in a new group "Investment",
		// Spending kind (no match with Miserly's "Investments": names match whole).
		expect(placeOf(mf.categoryId)).toEqual({ category: 'Mutual funds', group: 'Investment', kind: 'spending' });
		// "SIP": Miserly's only SIP is of the Investments kind, so it is made beside "Mutual funds".
		// Was (before the fix): Miserly's Investments, SIP, so it alone counted as Net invested.
		expect(placeOf(sip.categoryId)).toEqual({ category: 'SIP', group: 'Investment', kind: 'spending' });

		const r = await incomeVsExpense(h, 'alice', NOV);
		expect(r.totalExpensePaise).toBe(L(30_000)); // both transfers read as spending
		expect(r.totalInvestedPaise).toBe(0);
		const s = await spendingByCategory(h, 'alice', NOV);
		expect(s.groups.map((g) => [g.name, g.netPaise])).toEqual([['Investment', L(30_000)]]);
	});

	it('with Investments chosen: a new Investments group; "SIP" reuses Miserly\'s Investments, SIP', async () => {
		await importAll(budget, (c) => ({ ...c, groupKinds: { 'g-inv': 'investments' } }));

		const { mf, sip } = legs();
		expect(placeOf(mf.categoryId)).toEqual({ category: 'Mutual funds', group: 'Investment', kind: 'investments' });
		expect(placeOf(sip.categoryId)).toEqual({ category: 'SIP', group: 'Investments', kind: 'investments' });

		const r = await incomeVsExpense(h, 'alice', NOV);
		expect(r.totalExpensePaise).toBe(0);
		expect(r.totalInvestedPaise).toBe(L(30_000)); // both are Net invested
	});
});
