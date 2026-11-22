/**
 * red-team-2026-11.test.ts: the evidence behind a red-team read of the money logic and sharing.
 * ============================================================================
 * Each test builds one finding's scenario on an in-memory DB through the real services and
 * asserts the figure the app gives TODAY, with the right figure in a comment. They pass while the
 * defect stands; a fix flips the assertion. A test marked "fixed" asserts the right figure and
 * stays as the regression test. "Today" is pinned to 2026-11-06.
 * ============================================================================
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { createDb } from '../src/lib/server/db/client';
import { allStatements } from '../src/lib/server/db/migrate';
import type { Db } from '../src/lib/server/db/client';
import * as schema from '../src/lib/server/db/schema';
import {
	createAccount,
	createHoldingAccount,
	closeAccount,
	setOpeningBalance,
	listAccounts,
	upcomingRowsMessage,
	UpcomingRowsError
} from '../src/lib/server/accounts';
import {
	bulkUpdate,
	InvalidCategoryError,
	createTransaction,
	deleteTransaction,
	moveTransaction,
	inboxTransactions,
	updateTransaction,
	ClosedAccountError
} from '../src/lib/server/transactions';
import { formatMoney } from '../src/lib/format';
import { createTransfer } from '../src/lib/server/transfers';
import { addInlineTransfer, resolveTransferTarget, transferTargetsFor } from '../src/lib/server/inline-transfer';
import { transferOptions } from '../src/lib/transfer-targets';
import { postValuationMark, editMarkTarget } from '../src/lib/server/marks';
import { shareAccount } from '../src/lib/server/sharing';
import {
	createCategory,
	createGroup,
	deleteCategory,
	hideGroup,
	hideCategory,
	moveCategory,
	renameCategory,
	setGroupKind,
	SystemCategoryError
} from '../src/lib/server/categories';
import { seedStarterCategories, BALANCE_ADJUSTMENT_CATEGORY_ID } from '../src/lib/server/seed';
import { spendingByCategory, incomeVsExpense, earliestActivityDate } from '../src/lib/server/reports';
import { dashboardSummary, netWorthHistory, holdingMetrics, sectionAnnualReturn, sectionAnnualReturnDetail } from '../src/lib/server/dashboard';
import { accountBalance } from '../src/lib/server/db/balances';
import { resolvePeriod } from '../src/lib/reports/period';
import { parseDate } from '@miserly/core';

let h: Db;
beforeEach(async () => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(new Date('2026-11-06T06:00:00Z'));
	h = createDb(':memory:');
	for (const stmt of allStatements()) h.sqlite.exec(stmt);
	h.db.insert(schema.users).values([
		{ id: 'alice', username: 'alice', displayName: 'Alice', role: 'admin' },
		{ id: 'bob', username: 'bob', displayName: 'Bob', role: 'member' }
	]).run();
	await seedStarterCategories(h.db);
});
afterEach(() => {
	vi.useRealTimers();
	h.sqlite.close();
});

const ALICE = { userId: 'alice' };
const L = (rupees: number) => rupees * 100; // rupees → paise

function cat(name: string): string {
	const row = h.db.select({ id: schema.categories.id }).from(schema.categories)
		.where(and(eq(schema.categories.name, name), isNull(schema.categories.deletedAt))).get();
	if (!row) throw new Error(`no category ${name}`);
	return row.id;
}
async function bank(name: string, opening = L(1_00_000), owner = 'alice') {
	return createAccount(h, { ownerId: owner, type: 'bank', name, currency: 'INR', openingPaise: opening, openingDate: '2024-01-01' });
}
const lastPoint = async (user = 'alice') => {
	const hist = await netWorthHistory(h, user, 'ALL');
	return hist.points[hist.points.length - 1]!;
};

describe('RT-01 closing an account that has future-dated rows', () => {
	it('is refused until the upcoming row is deleted or moved, then closes to zero as of today (fixed 2026-11-06)', async () => {
		const b = await bank('HDFC');
		// An EMI typed ahead for next month (C1 allows future rows; they show as "upcoming").
		const emi = await createTransaction(h, ALICE, { accountId: b.id, date: '2026-12-05', amountPaise: -L(20_000) });
		// Was: the adjustment zeroed the PROJECTED balance on today's date, leaving +₹20,000 as of
		// today on a closed account (headline ₹0, the line ₹20,000).
		await expect(closeAccount(h, b.id, { actingUserId: 'alice' })).rejects.toBeInstanceOf(UpcomingRowsError);
		expect(upcomingRowsMessage(h, b.id, '2026-11-06')).toBe('This account has 1 upcoming row (5 Dec 2026). Delete or move it first.');
		expect((await listAccounts(h, 'alice')).map((a) => a.id)).toContain(b.id); // still open
		expect(accountBalance(h.sqlite, b.id)).toBe(L(80_000)); // nothing posted

		await deleteTransaction(h, ALICE, emi.id, emi.updatedAt);
		await closeAccount(h, b.id, { actingUserId: 'alice' });
		expect(accountBalance(h.sqlite, b.id, '2026-11-06')).toBe(0);
		expect((await dashboardSummary(h, 'alice')).netWorthPaise).toBe(0);
		expect((await lastPoint()).netWorthPaise).toBe(0); // the headline and the line agree
	});
});

describe('RT-02 editing the opening balance of a holding with a value update', () => {
	it('keeps the value the person typed and moves the return (fixed 2026-11-06)', async () => {
		const mf = await createHoldingAccount(h, {
			ownerId: 'alice', type: 'mutualFunds', name: 'Parag Parikh', currency: 'INR',
			investedPaise: L(1_00_000), investedDate: '2024-01-01', currentValuePaise: null
		});
		await postValuationMark(h, ALICE, { accountId: mf.id, targetPaise: L(1_50_000), date: '2026-10-31' });
		expect(accountBalance(h.sqlite, mf.id)).toBe(L(1_50_000));

		// Edit account: Invested (the opening) corrected from ₹1,00,000 to ₹1,20,000.
		await setOpeningBalance(h, mf.id, L(1_20_000), '2024-01-01');
		// Still ₹1,50,000 ("it was worth ₹1.5L on 31 Oct", S3 RD1). Was: ₹1,70,000, return ₹50,000.
		expect(accountBalance(h.sqlite, mf.id)).toBe(L(1_50_000));
		const m = (await holdingMetrics(h, 'alice', mf.id))!;
		expect(m.costBasisPaise).toBe(L(1_20_000));
		expect(m.returnPaise).toBe(L(30_000)); // the return moved; the value didn't
	});
});

describe('RT-03 editing the opening balance of a closed account', () => {
	it('is refused, so a closed account stays at zero (fixed 2026-11-06)', async () => {
		const b = await bank('Old SBI', L(10_000));
		await closeAccount(h, b.id, { actingUserId: 'alice' });
		// Was: accepted, leaving a closed account worth ₹5,000 (headline ₹0, the line ₹5,000).
		await expect(setOpeningBalance(h, b.id, L(15_000), '2024-01-01')).rejects.toBeInstanceOf(ClosedAccountError);
		expect(accountBalance(h.sqlite, b.id)).toBe(0);
		expect((await dashboardSummary(h, 'alice')).netWorthPaise).toBe(0);
		expect((await lastPoint()).netWorthPaise).toBe(0);
	});
});

describe('RT-04 "Transfer → name" picks the account by name', () => {
	it("a bank-to-bank move reaches the bank, not the fund of the same name (fixed 2026-11-06)", async () => {
		// A file with a bank "HDFC" and a mutual fund "HDFC" (names are unique per owner AND type).
		// listAccounts has no ORDER BY and SQLite walks the id index, so the first match is the
		// smaller random id: here the fund (33333333…) before the bank (eeeeeeee…).
		const put = (id: string, type: string, name: string, opening: number) =>
			h.db.insert(schema.accounts).values({ id, ownerId: 'alice', type, name, currency: 'INR', openingPaise: opening, openingDate: '2024-01-01' }).run();
		put('eeeeeeee-0000-4000-8000-000000000000', 'bank', 'HDFC', L(1_00_000));
		put('11111111-0000-4000-8000-000000000000', 'bank', 'SBI', L(1_00_000));
		put('33333333-0000-4000-8000-000000000000', 'mutualFunds', 'HDFC', L(50_000));
		const BANK = 'eeeeeeee-0000-4000-8000-000000000000';
		const SBI = '11111111-0000-4000-8000-000000000000';
		const FUND = '33333333-0000-4000-8000-000000000000';
		// Was: SBI's payee list offered "Transfer → HDFC" twice and the server took the text, so the
		// fund (the smaller id) took the ₹10,000 as money put in. Fixed 2026-11-06:
		// the list has a heading per section, each line carrying its account's id…
		const targets = (await transferTargetsFor(h, 'alice')).filter((t) => t.id !== SBI);
		expect(transferOptions(targets).map((o) => [o.group, o.label, o.accountId])).toEqual([
			['Transfer: Bank accounts', 'HDFC', BANK],
			['Transfer: Mutual funds', 'HDFC', FUND]
		]);
		const move = (transferAccountId: string) =>
			addInlineTransfer(h, 'alice', SBI, {
				payeeName: 'Transfer → HDFC', transferAccountId, amountPaise: -L(10_000), date: '2026-11-01', notes: null, categoryId: null, received: ''
			});
		// …text typed by hand that names both is refused, and nothing moves…
		expect(await move('')).toEqual({ payee: 'Two accounts are called HDFC: pick one from the list' });
		expect(accountBalance(h.sqlite, FUND)).toBe(L(50_000));
		// …and the picked line's id decides: the HDFC savings account takes the ₹10,000.
		expect(await move(BANK)).toBeNull();
		expect(accountBalance(h.sqlite, BANK)).toBe(L(1_10_000));
		expect(accountBalance(h.sqlite, FUND)).toBe(L(50_000));
		expect((await holdingMetrics(h, 'alice', FUND))!.costBasisPaise).toBe(L(50_000));
	});

	it("the edit-in-place lookup never picks the row's own account (fixed 2026-11-06)", async () => {
		const bankHdfc = await bank('HDFC');
		const fund = await createHoldingAccount(h, {
			ownerId: 'alice', type: 'mutualFunds', name: 'HDFC', currency: 'INR', investedPaise: L(50_000), investedDate: '2024-01-01', currentValuePaise: null
		});
		const targets = await transferTargetsFor(h, 'alice');
		// A row on the HDFC bank typed "Transfer → HDFC": the only other HDFC is the fund.
		const t = resolveTransferTarget(targets, bankHdfc.id, 'Transfer → HDFC', '');
		expect(typeof t === 'string' ? t : t.id).toBe(fund.id);
	});
});

describe('RT-05 sharing an account with no stated split rewrites its past', () => {
	it("fixed: sharing splits from the day it's shared; the owner keeps the whole of the past (H2 RD9)", async () => {
		const b = await bank('HDFC');
		await createTransaction(h, ALICE, { accountId: b.id, date: '2025-03-10', amountPaise: -L(40_000), categoryId: cat('Groceries') });
		await createTransaction(h, ALICE, { accountId: b.id, date: '2026-11-06', amountPaise: -L(10_000), categoryId: cat('Groceries') });
		const FY25 = { from: '2024-04-01', to: '2025-03-31' };
		const NOV = { from: '2026-11-01', to: '2026-11-30' };
		expect((await spendingByCategory(h, 'alice', FY25)).totalPaise).toBe(L(40_000));

		await shareAccount(h.db, ALICE, b.id, 'bob'); // today, 2026-11-06
		// Was ₹20,000 each for FY25: a share applies from when it starts (Splitwise, partnership accounting).
		expect((await spendingByCategory(h, 'alice', FY25)).totalPaise).toBe(L(40_000));
		expect((await spendingByCategory(h, 'bob', FY25)).totalPaise).toBe(0);
		// From today, equal.
		expect((await spendingByCategory(h, 'alice', NOV)).totalPaise).toBe(L(5_000));
		expect((await spendingByCategory(h, 'bob', NOV)).totalPaise).toBe(L(5_000));
		const stretch = h.db.select().from(schema.accountHolderPeriods).all();
		expect(stretch).toMatchObject([{ accountId: b.id, userId: 'bob', fromDate: '2026-11-06', toDate: null }]);
	});
});

describe('RT-06 moving a categorised row onto a holding', () => {
	it('keeps its category, so the income still counts (fixed 2026-11-06)', async () => {
		const b = await bank('HDFC');
		const epf = await createHoldingAccount(h, {
			ownerId: 'alice', type: 'otherAsset', name: 'EPF', currency: 'INR',
			investedPaise: L(3_00_000), investedDate: '2024-01-01', currentValuePaise: null
		});
		// The EPF contribution typed on the bank by mistake, then moved to EPF in All transactions.
		const row = await createTransaction(h, ALICE, { accountId: b.id, date: '2026-10-31', amountPaise: L(7_200), categoryId: cat('Salary') });
		const OCT = { from: '2026-10-01', to: '2026-10-31' };
		expect((await incomeVsExpense(h, 'alice', OCT)).totalIncomePaise).toBe(L(7_200));
		await moveTransaction(h, ALICE, row.id, epf.id, row.updatedAt);
		const moved = h.db.select().from(schema.transactions).where(eq(schema.transactions.id, row.id)).get()!;
		// Was: the category dropped and the income with it.
		expect(moved.categoryId).toBe(cat('Salary'));
		expect((await incomeVsExpense(h, 'alice', OCT)).totalIncomePaise).toBe(L(7_200));
	});
});

describe('RT-07 the "Balance adjustment" category can be deleted', () => {
	it("is refused, as are its move and its group's kind change; a close stays out of spending (fixed 2026-11-06)", async () => {
		const b = await bank('Old ICICI', L(25_000));
		// Was: deleted, then the close read as ₹25,000 of spending and waited in To categorize.
		await expect(deleteCategory(h.db, BALANCE_ADJUSTMENT_CATEGORY_ID, null)).rejects.toBeInstanceOf(SystemCategoryError);
		const groupId = h.db.select({ g: schema.categories.groupId }).from(schema.categories)
			.where(eq(schema.categories.id, BALANCE_ADJUSTMENT_CATEGORY_ID)).get()!.g;
		const other = h.db.select().from(schema.categoryGroups).where(eq(schema.categoryGroups.name, 'Lifestyle')).get()!;
		await expect(moveCategory(h.db, BALANCE_ADJUSTMENT_CATEGORY_ID, other.id)).rejects.toBeInstanceOf(SystemCategoryError);
		await expect(setGroupKind(h.db, groupId, 'spending')).rejects.toBeInstanceOf(SystemCategoryError);
		// Rename, hide, and saving the group's own kind or group stay allowed.
		await renameCategory(h.db, BALANCE_ADJUSTMENT_CATEGORY_ID, 'Closing adjustment');
		await hideCategory(h.db, BALANCE_ADJUSTMENT_CATEGORY_ID);
		await moveCategory(h.db, BALANCE_ADJUSTMENT_CATEGORY_ID, groupId);
		await setGroupKind(h.db, groupId, 'neutral');
		await closeAccount(h, b.id, { actingUserId: 'alice' });
		const NOV = { from: '2026-11-01', to: '2026-11-06' };
		expect((await spendingByCategory(h, 'alice', NOV)).totalPaise).toBe(0);
		expect(await inboxTransactions(h, 'alice')).toHaveLength(0);
	});
});

describe('RT-13 To categorize lists rows of closed accounts', () => {
	it('lets the person categorise it (a category-only edit), so the badge clears (C4, fixed 2026-11-06)', async () => {
		const b = await bank('Old Axis', L(5_000));
		const row = await createTransaction(h, ALICE, { accountId: b.id, date: '2026-10-02', amountPaise: -L(800), payeeName: 'DMart' });
		const other = await createTransaction(h, ALICE, { accountId: b.id, date: '2026-10-03', amountPaise: -L(200) });
		await closeAccount(h, b.id, { actingUserId: 'alice' });
		const inbox = await inboxTransactions(h, 'alice');
		expect(inbox.map((r) => r.id)).toEqual(expect.arrayContaining([row.id, other.id]));
		const token = inbox.find((r) => r.id === row.id)!.updatedAt;
		// Was: refused ("closed"), so the row sat in To categorize for good.
		// Anything else on a closed account still is, even posted with the category (a grid save).
		await expect(updateTransaction(h, ALICE, row.id, { categoryId: cat('Groceries'), amountPaise: -L(900) }, token)).rejects.toBeInstanceOf(ClosedAccountError);
		await expect(updateTransaction(h, ALICE, row.id, { categoryId: cat('Groceries'), notes: 'milk' }, token)).rejects.toBeInstanceOf(ClosedAccountError);
		// The grid's save: every field as stored, the category new.
		await updateTransaction(h, ALICE, row.id, { date: '2026-10-02', amountPaise: -L(800), payeeName: 'dmart', notes: '', categoryId: cat('Groceries') }, token);
		// The inbox's own action is a bulk set category.
		expect((await bulkUpdate(h, ALICE, [other.id], { kind: 'setCategory', categoryId: cat('Groceries') })).affected).toBe(1);
		expect(await inboxTransactions(h, 'alice')).toHaveLength(0);
		expect(accountBalance(h.sqlite, b.id)).toBe(0); // no money moved
		expect((await spendingByCategory(h, 'alice', { from: '2026-10-01', to: '2026-10-31' })).totalPaise).toBe(L(1_000));
	});
});

describe('RT-14 return per year: the account and its section disagree', () => {
	it('both end where the value was last known (the last interest typed inside) and read about 7 % (rule 3, fixed 2026-11-09)', async () => {
		const fd = await createHoldingAccount(h, {
			ownerId: 'alice', type: 'fd', name: 'SBI FD', currency: 'INR',
			investedPaise: L(1_00_000), investedDate: '2024-04-01', currentValuePaise: null
		});
		// The owner's routine: interest typed inside the FD as a row (Interest), no "Update value".
		await createTransaction(h, ALICE, { accountId: fd.id, date: '2025-03-31', amountPaise: L(7_000), categoryId: cat('Interest') });
		await createTransaction(h, ALICE, { accountId: fd.id, date: '2026-03-31', amountPaise: L(7_490), categoryId: cat('Interest') });
		const own = (await holdingMetrics(h, 'alice', fd.id))!;
		const section = await sectionAnnualReturn(h, 'alice', 'fd');
		// It was "—" on the register and 5.3 % on the section (ending today, seven idle months).
		expect(own.annualReturn).not.toBeNull();
		expect(own.annualReturn!).toBeGreaterThan(0.069);
		expect(own.annualReturn!).toBeLessThan(0.071);
		expect(section).toBeCloseTo(own.annualReturn!, 9);
		expect(own.lastUpdated).toBe('2026-03-31');
		expect(own.stale).toBe(false); // 13 months for an FD
	});
	it('a holding never valued is left out of its section, with a note; "Last updated" goes amber after its months (C7)', async () => {
		const valued = await createHoldingAccount(h, {
			ownerId: 'alice', type: 'mutualFunds', name: 'Index', currency: 'INR',
			investedPaise: L(1_00_000), investedDate: '2024-01-01', currentValuePaise: null
		});
		await postValuationMark(h, ALICE, { accountId: valued.id, targetPaise: L(1_21_000), date: '2026-01-01' });
		await createHoldingAccount(h, {
			ownerId: 'alice', type: 'mutualFunds', name: 'Never valued', currency: 'INR',
			investedPaise: L(1_00_000), investedDate: '2024-01-01', currentValuePaise: null
		});
		const detail = await sectionAnnualReturnDetail(h, 'alice', 'mutualFunds');
		expect(detail.rate).toBeCloseTo(0.1, 3); // the valued one alone: ₹1L to ₹1.21L in two years
		expect(detail.notValued).toBe(1);
		const m = (await holdingMetrics(h, 'alice', valued.id))!;
		expect(m.lastUpdated).toBe('2026-01-01');
		expect(m.stale).toBe(true); // a fund: 3 months, and it's 6 Nov
	});
});

describe('RT-15 a force-closed holding', () => {
	it('reads what it lost, not "−100 %" (rule 4, fixed 2026-11-09)', async () => {
		const fd = await createHoldingAccount(h, {
			ownerId: 'alice', type: 'fd', name: 'HDFC FD', currency: 'INR',
			investedPaise: L(1_00_000), investedDate: '2024-04-01', currentValuePaise: null
		});
		await createTransaction(h, ALICE, { accountId: fd.id, date: '2025-04-01', amountPaise: L(7_000), categoryId: cat('Interest') });
		await closeAccount(h, fd.id, { actingUserId: 'alice' }); // the write-off ("Write off ₹1,07,000 as a loss")
		const m = (await holdingMetrics(h, 'alice', fd.id))!;
		// It read Invested ₹1,00,000 and return −₹1,00,000 (−100 %); a closed register now shows what
		// it earned: ₹1,00,000 went in and nothing came out, which is true after a write-off.
		expect(m.earnedPaise).toBe(-L(1_00_000));
		expect(m.annualReturn).toBeNull(); // no money ever came out
		// An open holding has no "earned" line.
		const open = await createHoldingAccount(h, {
			ownerId: 'alice', type: 'fd', name: 'SBI FD', currency: 'INR',
			investedPaise: L(1_00_000), investedDate: '2024-04-01', currentValuePaise: null
		});
		expect((await holdingMetrics(h, 'alice', open.id))!.earnedPaise).toBeNull();
	});
});

describe('RT-16 an SIP typed as a plain bank row', () => {
	it('counts as Invested, as a transfer to a fund does; not as spending (C2 A, fixed 2026-11-09)', async () => {
		const b = await bank('HDFC');
		const mf = await createHoldingAccount(h, {
			ownerId: 'alice', type: 'mutualFunds', name: 'Index', currency: 'INR',
			investedPaise: L(0), investedDate: null, currentValuePaise: null
		});
		await createTransaction(h, ALICE, { accountId: b.id, date: '2026-10-05', amountPaise: -L(10_000), categoryId: cat('SIP') });
		await createTransfer(h, ALICE, { fromId: b.id, toId: mf.id, amountPaise: L(5_000), date: '2026-10-06', categoryId: cat('SIP') });
		await createTransaction(h, ALICE, { accountId: b.id, date: '2026-10-20', amountPaise: L(2_000), categoryId: cat('SIP') }); // a redemption back
		const OCT = { from: '2026-10-01', to: '2026-10-31' };
		const r3 = await incomeVsExpense(h, 'alice', OCT);
		expect(r3.totalExpensePaise).toBe(0);
		expect(r3.totalInvestedPaise).toBe(L(13_000)); // it was ₹5,000: the plain row was in neither
	});
	it("a transfer to a holding under one of the person's own Not-in-reports groups is no longer Invested", async () => {
		const b = await bank('HDFC');
		const mf = await createHoldingAccount(h, {
			ownerId: 'alice', type: 'mutualFunds', name: 'Index', currency: 'INR',
			investedPaise: L(0), investedDate: null, currentValuePaise: null
		});
		const g = await createGroup(h.db, { name: 'Parked', kind: 'neutral' });
		const c = await createCategory(h.db, { groupId: g.id, name: 'Parked money' });
		await createTransfer(h, ALICE, { fromId: b.id, toId: mf.id, amountPaise: L(5_000), date: '2026-10-06', categoryId: c.id });
		const r3 = await incomeVsExpense(h, 'alice', { from: '2026-10-01', to: '2026-10-31' });
		expect(r3.totalInvestedPaise).toBe(0); // only the Investments kind counts (C2 A)
	});
});

describe('RT-18 a loan paid by EMIs and never updated', () => {
	it('passes zero, and the register and Loans section say so: "Last updated" in amber and a nudge for the lender\'s figure (fixed 2026-11-09)', async () => {
		const b = await bank('HDFC', L(10_00_000));
		const car = await createAccount(h, { ownerId: 'alice', type: 'loan', name: 'Car', currency: 'INR', openingPaise: -L(5_00_000), openingDate: '2021-10-01' });
		// ₹5L at 9 % over 5 years: EMI ₹10,379, 60 of them, the last on 5 Oct 2026. The lender: ₹0 owed.
		for (let m = 0; m < 60; m++) {
			const date = parseDate('2021-11-05').add({ months: m }).toString();
			await createTransfer(h, ALICE, { fromId: b.id, toId: car.id, amountPaise: L(10_379), date });
		}
		// Still no calculation (the data hard line): each EMI counts in full, ₹1,22,740 "in credit".
		expect(accountBalance(h.sqlite, car.id)).toBe(L(1_22_740));
		const m = (await holdingMetrics(h, 'alice', car.id))!;
		expect(m.passedZero).toBe(true); // "Payments have passed what was owed. Update the outstanding…"
		expect(m.lastUpdated).toBe('2021-10-01'); // never updated since it was added
		expect(m.stale).toBe(true); // 13 months for a loan
		// The lender's figure puts it right, and the nudge goes.
		await postValuationMark(h, ALICE, { accountId: car.id, targetPaise: 0, date: '2026-11-01' });
		const fixed = (await holdingMetrics(h, 'alice', car.id))!;
		expect(fixed.passedZero).toBe(false);
		expect(fixed.stale).toBe(false);
		expect((await dashboardSummary(h, 'alice')).liabilitiesPaise).toBe(0);
		// Halfway (after 30 EMIs) the lender said ₹2,77,909 owed; the app said ₹1,88,630 (unchanged).
		expect(accountBalance(h.sqlite, car.id, '2024-04-30')).toBe(-L(5_00_000) + 30 * L(10_379));
	});
	it('a card never gets it (it takes no value update); a loan still owing doesn\'t either', async () => {
		const card = await createAccount(h, { ownerId: 'alice', type: 'creditCard', name: 'Card', currency: 'INR', openingPaise: L(500), openingDate: '2026-01-01' });
		expect((await holdingMetrics(h, 'alice', card.id))!.passedZero).toBe(false);
		const home = await createAccount(h, { ownerId: 'alice', type: 'loan', name: 'Home', currency: 'INR', openingPaise: -L(20_00_000), openingDate: '2026-01-01' });
		const hm = (await holdingMetrics(h, 'alice', home.id))!;
		expect(hm.passedZero).toBe(false);
		expect(hm.stale).toBe(false);
	});
});

describe('RT-17 compact amounts at a unit boundary', () => {
	it('reads ₹1Cr and ₹1L, not ₹100L and ₹100K (fixed 2026-11-06)', () => {
		expect(formatMoney(L(99_96_000), { compact: true })).toBe('₹1Cr');
		expect(formatMoney(L(99_960), { compact: true })).toBe('₹1L');
		expect(formatMoney(L(999_960), { compact: true, western: true })).toBe('₹1M');
		expect(formatMoney(-L(99_96_000), { compact: true })).toBe('−₹1Cr');
		// Just below a boundary stays in the lower unit.
		expect(formatMoney(L(99_94_000), { compact: true })).toBe('₹99.9L');
	});
});

describe('RT-08 a holding added today with its past gain', () => {
	it('puts years of gain into "change since last month"', async () => {
		await bank('HDFC', L(5_00_000));
		await createHoldingAccount(h, {
			ownerId: 'alice', type: 'mutualFunds', name: 'Index fund', currency: 'INR',
			investedPaise: L(5_00_000), investedDate: '2020-04-01', currentValuePaise: L(9_00_000)
		});
		const hist = await netWorthHistory(h, 'alice', '1Y');
		// The gain since 2020 is dated today (the onboarding update), so it all lands this month.
		expect(hist.changeSinceLastMonth!.absPaise).toBe(L(4_00_000));
		const oct = hist.points.find((p) => p.date === '2026-10-31')!;
		expect(oct.netWorthPaise).toBe(L(10_00_000)); // drawn at ₹10L for six years, then a ₹4L jump
	});
});

describe('RT-09 a partial redemption', () => {
	it('keeps the cost of what is still held: Invested ₹25,000, return ₹25,000 (+100 %) (rule 1, fixed 2026-11-09)', async () => {
		const b = await bank('HDFC', L(0));
		const mf = await createHoldingAccount(h, {
			ownerId: 'alice', type: 'mutualFunds', name: 'Flexi cap', currency: 'INR',
			investedPaise: L(1_00_000), investedDate: '2023-01-01', currentValuePaise: null
		});
		await postValuationMark(h, ALICE, { accountId: mf.id, targetPaise: L(2_00_000), date: '2026-06-30' });
		await createTransfer(h, ALICE, { fromId: mf.id, toId: b.id, amountPaise: L(1_50_000), date: '2026-07-15' });
		const m = (await holdingMetrics(h, 'alice', mf.id))!;
		expect(m.currentValuePaise).toBe(L(50_000));
		// Average cost (Ghostfolio, Wealthfolio): 75 % of the value taken out takes 75 % of Invested;
		// ₹25,000 of return is still held, ₹75,000 left as realised gain (it was Invested ₹0, "—%").
		expect(m.costBasisPaise).toBe(L(25_000));
		expect(m.returnPaise).toBe(L(25_000));
		expect(m.returnPct).toBe(1);
	});
});

describe('RT-10 editing a value update to a negative value', () => {
	it('is refused, as posting one is (fixed 2026-11-06)', async () => {
		const gold = await createHoldingAccount(h, {
			ownerId: 'alice', type: 'gold', name: 'Gold', currency: 'INR',
			investedPaise: L(50_000), investedDate: '2024-01-01', currentValuePaise: null
		});
		await expect(postValuationMark(h, ALICE, { accountId: gold.id, targetPaise: -L(1), date: '2026-10-01' })).rejects.toThrow();
		const r = await postValuationMark(h, ALICE, { accountId: gold.id, targetPaise: L(60_000), date: '2026-10-01' });
		const mark = h.db.select().from(schema.transactions).where(eq(schema.transactions.id, r.id!)).get()!;
		// Was: accepted, an asset worth minus ₹60,000.
		await expect(editMarkTarget(h, ALICE, r.id!, -L(60_000), mark.updatedAt)).rejects.toThrow(/negative/);
		expect(accountBalance(h.sqlite, gold.id)).toBe(L(60_000));
	});
});

describe('RT-11 a category in a hidden group', () => {
	it('is refused on every save, and never suggested (fixed 2026-11-06)', async () => {
		const b = await bank('HDFC');
		const fund = await createHoldingAccount(h, {
			ownerId: 'alice', type: 'mutualFunds', name: 'Index', currency: 'INR', investedPaise: L(1_000), investedDate: '2024-01-01', currentValuePaise: null
		});
		const old = await createTransaction(h, ALICE, { accountId: b.id, date: '2026-10-01', amountPaise: -L(700), payeeName: 'Croma', categoryId: cat('Shopping') });
		const blank = await createTransaction(h, ALICE, { accountId: b.id, date: '2026-10-02', amountPaise: -L(300), payeeName: 'Croma' });
		const lifestyle = h.db.select().from(schema.categoryGroups).where(eq(schema.categoryGroups.name, 'Lifestyle')).get()!;
		await hideGroup(h.db, lifestyle.id);
		// Was: accepted for a new row, as if only the category's own flag counted.
		const shopping = cat('Shopping');
		await expect(createTransaction(h, ALICE, { accountId: b.id, date: '2026-11-01', amountPaise: -L(500), categoryId: shopping })).rejects.toBeInstanceOf(InvalidCategoryError);
		await expect(updateTransaction(h, ALICE, blank.id, { categoryId: shopping }, blank.updatedAt)).rejects.toBeInstanceOf(InvalidCategoryError);
		await expect(bulkUpdate(h, ALICE, [blank.id], { kind: 'setCategory', categoryId: shopping })).rejects.toBeInstanceOf(InvalidCategoryError);
		await expect(createTransfer(h, ALICE, { fromId: b.id, toId: fund.id, amountPaise: L(100), date: '2026-11-01', categoryId: shopping })).rejects.toBeInstanceOf(InvalidCategoryError);
		// The inbox doesn't suggest it for Croma's blank row.
		expect((await inboxTransactions(h, 'alice')).find((r) => r.id === blank.id)!.suggestedCategoryId).toBeNull();
		// A row already in it still takes a memo edit (only a changed category is checked).
		await updateTransaction(h, ALICE, old.id, { categoryId: shopping, notes: 'TV' }, old.updatedAt);
	});
});

describe('RT-12 "All time" starts at bank and card activity', () => {
	it('includes income typed on a holding before the first bank row (fixed 2026-11-06)', async () => {
		await createAccount(h, { ownerId: 'alice', type: 'bank', name: 'HDFC', currency: 'INR', openingPaise: L(10_000), openingDate: '2025-04-01' });
		const epf = await createAccount(h, { ownerId: 'alice', type: 'otherAsset', name: 'EPF', currency: 'INR', openingPaise: 0, openingDate: null });
		await createTransaction(h, ALICE, { accountId: epf.id, date: '2023-04-30', amountPaise: L(7_200), categoryId: cat('Salary') });
		// Was: All time began at the bank's opening (2025-04-01) and missed the 2023 contribution.
		const earliest = await earliestActivityDate(h, 'alice');
		expect(earliest).toBe('2023-04-30');
		const all = resolvePeriod('all', parseDate('2026-11-06'), { earliest: earliest ?? undefined });
		expect((await incomeVsExpense(h, 'alice', { from: all.from, to: all.to })).totalIncomePaise).toBe(L(7_200));
	});
});

describe("C10 Reports' Invested and a holding's Invested differ on purpose", () => {
	it('Reports names its figure "Net invested" in the headline, the table and the CSV (fixed 2026-11-09)', async () => {
		const { NET_INVESTED } = await import('../src/lib/reports/labels');
		expect(NET_INVESTED).toBe('Net invested');
		const { readFileSync } = await import('node:fs');
		const page = readFileSync(new URL('../src/routes/reports/+page.svelte', import.meta.url), 'utf8');
		expect(page.match(/NET_INVESTED/g)?.length).toBe(4); // the import, the CSV, the headline, the column
		expect(page).not.toMatch(/<th class="num">Invested<\/th>|'Invested'\]|\} invested<\/span>/);
	});
});
