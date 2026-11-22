/**
 * red-team-2026-11-review.test.ts: the evidence behind a second review of the red team's
 * findings (N-01 to N-11) and a third pass (RT-07's hole, N-12 to N-18).
 * ============================================================================
 * As in red-team-2026-11.test.ts, each test asserts the figure the app gives TODAY, with the right one in a
 * comment, so a fix flips it. A test marked "fixed" asserts the right figure and stays as the
 * regression test; one marked "holds" is a check that
 * came out right. "Today" is pinned to 2026-11-06.
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
	OpeningDateError
} from '../src/lib/server/accounts';
import {
	createTransaction,
	deleteTransaction,
	restoreTransaction,
	restoreTransactions,
	reorderWithinDate,
	capturePayees,
	inboxTransactions,
	registerView,
	updateTransaction,
	HiddenTransferError,
	ClosedAccountError
} from '../src/lib/server/transactions';
import { removeMember } from '../src/lib/server/members';
import { createTransfer } from '../src/lib/server/transfers';
import { resolveTransferTarget, transferTargetsFor } from '../src/lib/server/inline-transfer';
import { transferOptions } from '../src/lib/transfer-targets';
import { postValuationMark, editMarkTarget, MarkBeforeStartError } from '../src/lib/server/marks';
import { shareAccount, unshareAccount, setAccountShares } from '../src/lib/server/sharing';
import { seedStarterCategories, BALANCE_ADJUSTMENT_CATEGORY_ID } from '../src/lib/server/seed';
import { spendingByCategory, incomeVsExpense } from '../src/lib/server/reports';
import { dashboardSummary, netWorthHistory, holdingMetrics, sectionAnnualReturn, sectionAnnualReturnDetail, sharedAnnualReturns, recentActivity, returnFlags } from '../src/lib/server/dashboard';
import { accountBalance } from '../src/lib/server/db/balances';
import { formatMoney } from '../src/lib/format';
import { paidOutRate } from '../src/lib/modules';
import { createCategory, createGroup, deleteGroup, hideCategory, hideGroup, setCountsAsReturn, SystemCategoryError } from '../src/lib/server/categories';

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
const bank = (name: string, opening = L(1_00_000), owner = 'alice') =>
	createAccount(h, { ownerId: owner, type: 'bank', name, currency: 'INR', openingPaise: opening, openingDate: '2024-01-01' });
const holding = (type: string, name: string, investedPaise: number, investedDate: string) =>
	createHoldingAccount(h, { ownerId: 'alice', type, name, currency: 'INR', investedPaise, investedDate, currentValuePaise: null });
const lastPoint = async (user = 'alice') => {
	const x = await netWorthHistory(h, user, 'ALL');
	return x.points[x.points.length - 1]!;
};

// ── The second opinion (N-01 to N-11) ─────────────────────────────────────────

describe("N-01 unsharing rewrites the owner's past (RT-05's \"unsharing does the same\" can't hold today)", () => {
	it('fixed: no split stated, shared from 1 Jan 2025: Alice FY25 spending 20k while shared and after the unshare', async () => {
		vi.setSystemTime(new Date('2025-01-01T06:00:00Z'));
		const b = await bank('Joint');
		await shareAccount(h.db, ALICE, b.id, 'bob');
		await createTransaction(h, ALICE, { accountId: b.id, date: '2025-03-10', amountPaise: -L(40_000), categoryId: cat('Groceries') });
		vi.setSystemTime(new Date('2026-11-06T06:00:00Z'));
		const FY = { from: '2024-04-01', to: '2025-03-31' };
		expect((await spendingByCategory(h, 'alice', FY)).totalPaise).toBe(L(20_000));
		await unshareAccount(h.db, ALICE, b.id, 'bob');
		// Was 40k again: Bob's stretch ends today, the dates he held keep their split.
		expect((await spendingByCategory(h, 'alice', FY)).totalPaise).toBe(L(20_000));
		// C5 C: Bob keeps his half of the dates he held (read-only), so the two still add to 40k.
		expect((await spendingByCategory(h, 'bob', FY)).totalPaise).toBe(L(20_000));
		expect(h.db.select().from(schema.accountHolderPeriods).all())
			.toMatchObject([{ userId: 'bob', fromDate: '2025-01-01', toDate: '2026-11-06' }]);
	});
	it("fixed: a stated split (70 / 30) keeps the owner's part for the dates Bob held it after the unshare", async () => {
		vi.setSystemTime(new Date('2025-01-01T06:00:00Z'));
		const b = await bank('Joint');
		await shareAccount(h.db, ALICE, b.id, 'bob');
		await setAccountShares(h.db, ALICE, b.id, '2025-01-01', { alice: 7000, bob: 3000 });
		await createTransaction(h, ALICE, { accountId: b.id, date: '2025-03-10', amountPaise: -L(40_000), categoryId: cat('Groceries') });
		await createTransaction(h, ALICE, { accountId: b.id, date: '2026-11-06', amountPaise: -L(10_000), categoryId: cat('Groceries') });
		vi.setSystemTime(new Date('2026-11-06T06:00:00Z'));
		const FY = { from: '2024-04-01', to: '2025-03-31' };
		const NOV = { from: '2026-11-01', to: '2026-11-30' };
		expect((await spendingByCategory(h, 'alice', FY)).totalPaise).toBe(L(28_000));
		await unshareAccount(h.db, ALICE, b.id, 'bob');
		expect((await spendingByCategory(h, 'alice', FY)).totalPaise).toBe(L(28_000)); // was 40k
		// From the unshare, Bob's 30 % returns to Alice (H2 RD8).
		expect((await spendingByCategory(h, 'alice', NOV)).totalPaise).toBe(L(10_000));
	});
	it('the owner shares and unshares on one day: no stretch is kept and nothing changes', async () => {
		const b = await bank('Joint');
		await createTransaction(h, ALICE, { accountId: b.id, date: '2026-11-06', amountPaise: -L(10_000), categoryId: cat('Groceries') });
		await shareAccount(h.db, ALICE, b.id, 'bob');
		await unshareAccount(h.db, ALICE, b.id, 'bob');
		expect(h.db.select().from(schema.accountHolderPeriods).all()).toEqual([]);
		expect((await spendingByCategory(h, 'alice', { from: '2026-11-01', to: '2026-11-30' })).totalPaise).toBe(L(10_000));
	});
});

describe('N-02 Undo (restore) brings a row back onto a closed account', () => {
	it('is refused, single and bulk, so the closed account stays at zero (fixed 2026-11-06)', async () => {
		const b = await bank('Old', L(10_000));
		const r = await createTransaction(h, ALICE, { accountId: b.id, date: '2026-10-01', amountPaise: -L(3_000) });
		await deleteTransaction(h, ALICE, r.id, r.updatedAt);
		await closeAccount(h, b.id, { actingUserId: 'alice' }); // zeroes 10,000 (the row is deleted)
		// Was: restored, leaving −₹3,000 on a closed account (headline ₹0, the line −₹3,000).
		await expect(restoreTransaction(h, ALICE, r.id)).rejects.toBeInstanceOf(ClosedAccountError);
		await expect(restoreTransactions(h, ALICE, [r.id])).rejects.toBeInstanceOf(ClosedAccountError);
		expect(accountBalance(h.sqlite, b.id)).toBe(0);
		expect((await dashboardSummary(h, 'alice')).netWorthPaise).toBe(0);
		expect((await lastPoint()).netWorthPaise).toBe(0);
	});
	it('reorder on a closed holding is refused, so no mark re-derives past the zeroing row (fixed 2026-11-06)', async () => {
		const g = await holding('gold', 'Gold', L(50_000), '2024-01-01');
		await postValuationMark(h, ALICE, { accountId: g.id, targetPaise: L(60_000), date: '2026-11-06' });
		await closeAccount(h, g.id, { actingUserId: 'alice' }); // write-off row after the mark, same day
		expect(accountBalance(h.sqlite, g.id)).toBe(0);
		const close = h.sqlite.prepare("SELECT id FROM transactions WHERE account_id = ? AND kind = 'ordinary' ORDER BY sequence DESC").get(g.id) as { id: string };
		// Was: accepted (the UI hid it, the server didn't check), the gold back at ₹60,000.
		await expect(reorderWithinDate(h, ALICE, close.id, 'down')).rejects.toBeInstanceOf(ClosedAccountError);
		expect(accountBalance(h.sqlite, g.id)).toBe(0);
	});
});

describe('N-03 a payout FD (C1 A: its stated rate from its details)', () => {
	it('interest typed at the bank, where it lands: the FD reads "7.1% a year, paid out" and leaves the section rate (fixed 2026-11-09)', async () => {
		const b = await bank('SBI', L(0));
		const fd = await createHoldingAccount(h, {
			ownerId: 'alice', type: 'fd', name: 'FD', currency: 'INR', investedPaise: L(1_00_000), investedDate: '2024-04-01',
			currentValuePaise: null, infoJson: JSON.stringify({ rate: '7.1', payout: 'Payout' })
		});
		const cumulative = await createHoldingAccount(h, {
			ownerId: 'alice', type: 'fd', name: 'FD 2', currency: 'INR', investedPaise: L(1_00_000), investedDate: '2024-04-01',
			currentValuePaise: null, infoJson: JSON.stringify({ rate: '7.0%', payout: 'Cumulative' })
		});
		await createTransaction(h, ALICE, { accountId: b.id, date: '2025-03-31', amountPaise: L(7_100), categoryId: cat('Interest') });
		await createTransaction(h, ALICE, { accountId: b.id, date: '2026-03-31', amountPaise: L(7_100), categoryId: cat('Interest') });
		await createTransaction(h, ALICE, { accountId: cumulative.id, date: '2025-04-01', amountPaise: L(7_000), categoryId: cat('Interest') });
		const m = (await holdingMetrics(h, 'alice', fd.id))!;
		expect(m.currentValuePaise).toBe(L(1_00_000)); // the FD never moves
		expect(m.paidOutRate).toBeCloseTo(0.071, 9); // it read +₹0 (0.0%)
		expect(m.lastUpdated).toBe('2024-04-01');
		expect(m.stale).toBe(false); // Its value can't change, so no amber (13 months have passed)
		expect((await holdingMetrics(h, 'alice', cumulative.id))!.paidOutRate).toBeNull();
		const detail = await sectionAnnualReturnDetail(h, 'alice', 'fd');
		expect(detail.paidOut).toBe(1); // "1 paid out, at its own rate"
		expect(detail.rate).toBeCloseTo(0.07, 3); // the cumulative FD alone
		// The interest counts once, at the bank.
		const r3 = await incomeVsExpense(h, 'alice', { from: '2024-04-01', to: '2026-11-06' });
		expect(r3.totalIncomePaise).toBe(L(14_200) + L(7_000));
	});
	it('typed as a transfer out of the FD instead, it lowers the FD\u2019s value (why C1 reads the details, not the rows)', async () => {
		const b = await bank('SBI', L(0));
		const fd = await holding('fd', 'FD', L(1_00_000), '2024-04-01');
		await createTransfer(h, ALICE, { fromId: fd.id, toId: b.id, amountPaise: L(7_000), date: '2025-03-31', categoryId: cat('Interest') });
		await createTransfer(h, ALICE, { fromId: fd.id, toId: b.id, amountPaise: L(7_000), date: '2026-03-31', categoryId: cat('Interest') });
		const m = (await holdingMetrics(h, 'alice', fd.id))!;
		expect(m.currentValuePaise).toBe(L(86_000)); // the FD still holds ₹1,00,000 at the bank
		expect(m.costBasisPaise).toBe(L(1_00_000)); // a payout leaves Invested (rule 2)
	});
	it('reads the rate from the profile fields: "7.1" or "7.1%", only when the details say Payout, never for a type without them', () => {
		expect(paidOutRate('fd', JSON.stringify({ rate: '7.1%', payout: 'Payout' }))).toBeCloseTo(0.071, 9);
		expect(paidOutRate('fd', JSON.stringify({ rate: 'about seven', payout: 'Payout' }))).toBeNull();
		expect(paidOutRate('fd', JSON.stringify({ rate: '7.1', payout: 'Cumulative' }))).toBeNull();
		expect(paidOutRate('fd', null)).toBeNull();
		expect(paidOutRate('rd', JSON.stringify({ rate: '7.1', payout: 'Payout' }))).toBeNull(); // RD's profile declares no payout
	});
	it('typing it twice (inside the FD, then paid out) double counts income', async () => {
		const b = await bank('SBI', L(0));
		const fd = await holding('fd', 'FD', L(1_00_000), '2024-04-01');
		await createTransaction(h, ALICE, { accountId: fd.id, date: '2025-03-31', amountPaise: L(7_000), categoryId: cat('Interest') });
		await createTransfer(h, ALICE, { fromId: fd.id, toId: b.id, amountPaise: L(7_000), date: '2025-03-31', categoryId: cat('Interest') });
		const r3 = await incomeVsExpense(h, 'alice', { from: '2024-04-01', to: '2026-11-06' });
		expect(r3.totalIncomePaise).toBe(L(14_000)); // ₹7,000 earned: type it once, where it lands
	});
});

describe('N-04 a value update that matches the recorded value', () => {
	it('records a ₹0 row, so "Last updated" and rule 3 see the confirmation (fixed 2026-11-09)', async () => {
		const p = await holding('property', 'Flat', L(50_00_000), '2020-01-01');
		const r = await postValuationMark(h, ALICE, { accountId: p.id, targetPaise: L(50_00_000), date: '2026-11-01' });
		expect(r.id).not.toBeNull();
		expect(r.gapPaise).toBe(0);
		const n = h.sqlite.prepare("SELECT COUNT(*) AS n, SUM(amount_paise) AS s FROM transactions WHERE account_id = ? AND kind = 'valuationMark'").get(p.id) as { n: number; s: number };
		expect(n).toEqual({ n: 1, s: 0 });
		const m = (await holdingMetrics(h, 'alice', p.id))!;
		expect(m.currentValuePaise).toBe(L(50_00_000));
		expect(m.lastUpdated).toBe('2026-11-01');
		expect(m.annualReturn).toBeCloseTo(0, 9); // known on 1 Nov: worth what was put in
	});
});

describe('N-05 return per year across a share change (RT-05 makes every share dated)', () => {
	// A fund growing ~18.9 % a year: ₹1,00,000 on 1 Nov 2022, ₹1,41,421 on 1 Nov 2024 (√2), ₹2,00,000
	// on 1 Nov 2026. Alice shares it with Bob on 2 Nov 2024, half each from then.
	async function sharedFund() {
		vi.setSystemTime(new Date('2024-11-02T06:00:00Z'));
		const mf = await holding('mutualFunds', 'Index', L(1_00_000), '2022-11-01');
		await postValuationMark(h, ALICE, { accountId: mf.id, targetPaise: 1_41_42_136, date: '2024-11-01' });
		await shareAccount(h.db, ALICE, mf.id, 'bob');
		vi.setSystemTime(new Date('2026-11-06T06:00:00Z'));
		await postValuationMark(h, ALICE, { accountId: mf.id, targetPaise: L(2_00_000), date: '2026-11-01' });
		return mf;
	}
	it("fixed: the half Alice gave Bob counts as money out for her and in for him, so both read the fund's 18.9 % a year", async () => {
		const mf = await sharedFund();
		const own = (await holdingMetrics(h, 'alice', mf.id))!.annualReturn!;
		const alice = await sectionAnnualReturn(h, 'alice', 'mutualFunds');
		const bob = await sectionAnnualReturn(h, 'bob', 'mutualFunds');
		expect(own).toBeCloseTo(0.1892, 3); // the fund's own rate (the register, in full)
		expect(Math.abs(alice! - own)).toBeLessThan(0.002); // was about 0 %
		expect(Math.abs(bob! - own)).toBeLessThan(0.002); // was "—"
	});
	it('a member who joined under a year ago reads "—" (no annualising a part year)', async () => {
		vi.setSystemTime(new Date('2026-06-01T06:00:00Z'));
		const mf = await holding('mutualFunds', 'Index', L(1_00_000), '2022-11-01');
		await shareAccount(h.db, ALICE, mf.id, 'bob');
		vi.setSystemTime(new Date('2026-11-06T06:00:00Z'));
		await postValuationMark(h, ALICE, { accountId: mf.id, targetPaise: L(2_00_000), date: '2026-11-01' });
		expect(await sectionAnnualReturn(h, 'bob', 'mutualFunds')).toBeNull();
		expect(await sectionAnnualReturn(h, 'alice', 'mutualFunds')).toBeGreaterThan(0.1);
	});
});

describe('N-06 a withdrawal larger than the recorded value', () => {
	it('drives an asset below zero, and the register asks for a value update first (fixed 2026-11-09)', async () => {
		const b = await bank('SBI', L(0));
		const mf = await holding('mutualFunds', 'Old fund', L(1_00_000), '2021-01-01');
		await createTransfer(h, ALICE, { fromId: mf.id, toId: b.id, amountPaise: L(1_50_000), date: '2026-10-15' });
		const m = (await holdingMetrics(h, 'alice', mf.id))!;
		expect(m.currentValuePaise).toBe(-L(50_000));
		expect(m.costBasisPaise).toBe(0); // the ratio stops at 1: all of Invested went out
		expect(m.overdrawn).toBe(true); // "Update its value first" (OVERDRAWN_MESSAGE)
		// A value update dated before the withdrawal puts it right.
		await postValuationMark(h, ALICE, { accountId: mf.id, targetPaise: L(2_00_000), date: '2026-10-14' });
		const fixed = (await holdingMetrics(h, 'alice', mf.id))!;
		expect(fixed.overdrawn).toBe(false);
		expect(fixed.currentValuePaise).toBe(L(50_000));
		expect(fixed.costBasisPaise).toBe(L(25_000));
	});
});

describe('N-07 two open accounts called HDFC in the same section (yours and a shared one)', () => {
	it('the co-member\'s reads "HDFC (Bob\'s)", under the same heading and in transfer rows (C8, fixed 2026-11-06)', async () => {
		const mine = await bank('HDFC');
		const bobs = await bank('HDFC', L(5_000), 'bob'); // allowed: a name clash is checked per owner
		await shareAccount(h.db, { userId: 'bob' }, bobs.id, 'alice');
		expect((await listAccounts(h, 'alice')).filter((a) => a.name === 'HDFC' && a.type === 'bank')).toHaveLength(2);
		// Was: both lines read "HDFC" under "Transfer: Bank".
		const lines = transferOptions(await transferTargetsFor(h, 'alice')).filter((o) => o.group === 'Transfer: Bank accounts');
		expect(lines.map((o) => [o.label, o.accountId])).toEqual([
			['HDFC', mine.id],
			["HDFC (Bob's)", bobs.id]
		]);
		// Typed by hand, "HDFC" names both and is refused; Bob's label names his alone.
		const targets = await transferTargetsFor(h, 'alice');
		expect(resolveTransferTarget(targets, 'none', 'Transfer → HDFC', '')).toBe('Two accounts are called HDFC: pick one from the list');
		const his = resolveTransferTarget(targets, 'none', "Transfer → HDFC (Bob's)", '');
		expect(typeof his === 'string' ? his : his.id).toBe(bobs.id);
		// A transfer between them names the other side the same way; Bob still can't see Alice's
		// private HDFC, so his row names no account (P0).
		await createTransfer(h, ALICE, { fromId: mine.id, toId: bobs.id, amountPaise: L(1_000), date: '2026-11-06' }); // on or after the day Alice joined (C5 C)
		expect((await registerView(h, 'alice', mine.id)).rows.at(-1)!.counterpartAccountName).toBe("HDFC (Bob's)");
		expect((await registerView(h, 'bob', bobs.id)).rows.at(-1)!.counterpartAccountName).toBeNull();
	});
	it('a closed account reads "(closed)" on its past transfers, beside a new open one of the same name (C8, fixed 2026-11-06)', async () => {
		const sbi = await bank('SBI');
		const old = await bank('HDFC', L(0));
		await createTransfer(h, ALICE, { fromId: sbi.id, toId: old.id, amountPaise: L(2_000), date: '2026-10-01' });
		await createTransfer(h, ALICE, { fromId: old.id, toId: sbi.id, amountPaise: L(2_000), date: '2026-10-02' });
		await closeAccount(h, old.id, { actingUserId: 'alice' });
		const fresh = await bank('HDFC', L(0)); // the name is free again once the old one is closed
		await createTransfer(h, ALICE, { fromId: sbi.id, toId: fresh.id, amountPaise: L(500), date: '2026-11-01' });
		const names = (await registerView(h, 'alice', sbi.id)).rows.map((r) => r.counterpartAccountName);
		expect(names).toEqual(['HDFC (closed)', 'HDFC (closed)', 'HDFC']);
		// All transactions names it too (it read as a hidden account, "To Alice"), and locks the row.
		const feed = await recentActivity(h, 'alice', 10);
		const past = feed.find((r) => r.date === '2026-10-01')!;
		expect(past.transferToName).toBe('HDFC (closed)');
		expect(past.counterpartClosed).toBe(true);
	});
});

describe('N-08 RT-16 as first decided counts any Not-in-reports plain row as Invested', () => {
	it("a loan to a friend in the person's own neutral group stays out: only the Investments kind counts (C2 A, fixed 2026-11-09)", async () => {
		const b = await bank('SBI');
		const g = await createGroup(h.db, { name: 'Owed to me', kind: 'neutral' });
		const c = await createCategory(h.db, { groupId: g.id, name: 'Lent to Ravi' });
		await createTransaction(h, ALICE, { accountId: b.id, date: '2026-10-05', amountPaise: -L(20_000), categoryId: c.id });
		const r3 = await incomeVsExpense(h, 'alice', { from: '2026-10-01', to: '2026-10-31' });
		expect(r3.totalInvestedPaise).toBe(0); // RT-16 as first worded made it ₹20,000 "invested"
	});
});

describe('N-09 compact rounding beyond RT-17', () => {
	it('half-way values round alike, ₹999.60 reads ₹1K, −₹0.40 reads ₹0 (fixed 2026-11-06)', () => {
		// Was: ₹1.4L beside ₹2.5L (binary toFixed), ₹1000, −₹0.
		expect(formatMoney(L(1_45_000), { compact: true })).toBe('₹1.5L');
		expect(formatMoney(L(2_45_000), { compact: true })).toBe('₹2.5L');
		expect(formatMoney(99_960, { compact: true })).toBe('₹1K');
		expect(formatMoney(-40, { compact: true })).toBe('₹0');
		expect(formatMoney(-50, { compact: true })).toBe('−₹1'); // half away from zero
		expect(formatMoney(99_940, { compact: true })).toBe('₹999');
	});
});

// A start date after today can't be typed any more (C6); a file may already hold one, so these
// tests write it straight into the table, as an older file would have it.
const futureBank = (name: string, opening: number, date: string) =>
	h.db.insert(schema.accounts).values({ id: `future-${name}`, ownerId: 'alice', type: 'bank', name, currency: 'INR', openingPaise: opening, openingDate: date }).run();

describe('C6 a start date after today', () => {
	it('is refused on Add account and on Edit account (fixed 2026-11-06)', async () => {
		await expect(
			createAccount(h, { ownerId: 'alice', type: 'bank', name: 'New', currency: 'INR', openingPaise: L(10_000), openingDate: '2026-12-01' })
		).rejects.toThrow("The start date can't be after today");
		await expect(holding('fd', 'FD', L(1_00_000), '2026-11-07')).rejects.toBeInstanceOf(OpeningDateError);
		const b = await bank('SBI');
		await expect(setOpeningBalance(h, b.id, L(1_00_000), '2026-12-01')).rejects.toBeInstanceOf(OpeningDateError);
		// Today itself is fine, and an amount-only edit keeps whatever date is stored.
		await createAccount(h, { ownerId: 'alice', type: 'bank', name: 'Today', currency: 'INR', openingPaise: L(1), openingDate: '2026-11-06' });
		await setOpeningBalance(h, b.id, L(2_00_000), '2024-01-01');
	});
});

describe('N-10 an account whose opening date is in the future', () => {
	it('alone: the headline leaves it out until it starts and the line is one point at ₹0 (fixed 2026-11-06)', async () => {
		futureBank('New', L(10_000), '2026-12-01');
		// Was: the headline ₹10,000 and the line threw ("Invalid string").
		const d = await dashboardSummary(h, 'alice');
		expect(d.netWorthPaise).toBe(0);
		expect(d.hasOpenAccounts).toBe(true); // not the no-accounts empty state
		const x = await netWorthHistory(h, 'alice', 'ALL');
		expect(x.points.map((p) => [p.date, p.netWorthPaise])).toEqual([['2026-11-06', 0]]);
	});
	it('an opening date moved later than existing rows is refused (fixed 2026-11-06)', async () => {
		const b = await bank('Late');
		await createTransaction(h, ALICE, { accountId: b.id, date: '2025-01-10', amountPaise: -L(5_000), categoryId: cat('Groceries') });
		// Was: accepted, and the January row fell before the line began.
		await expect(setOpeningBalance(h, b.id, L(1_00_000), '2025-06-01')).rejects.toThrow(
			"The start date can't be after the account's first row (10 Jan 2025)"
		);
		await setOpeningBalance(h, b.id, L(1_00_000), '2025-01-10'); // on the first row's day is fine
		const x = await netWorthHistory(h, 'alice', 'ALL');
		expect(x.points[0]!.date).toBe('2025-01-10');
	});
});

describe('N-11 (P0) a future opening date next to an older account', () => {
	it('the headline and the line both read ₹50,000 (fixed 2026-11-06)', async () => {
		await bank('Old', L(50_000));
		futureBank('New', L(10_000), '2026-12-01');
		// Was: headline ₹60,000, the line ₹50,000. Allocation follows the headline.
		const d = await dashboardSummary(h, 'alice');
		expect(d.netWorthPaise).toBe(L(50_000));
		expect(d.byClass.find((s) => s.key === 'bank')!.amountPaise).toBe(L(50_000));
		expect((await lastPoint()).netWorthPaise).toBe(L(50_000));
	});
});

// ── The third pass: N-12 to N-16 ──────────────────────

describe("N-12 a payee remembers a category that was hidden later", () => {
	it('fills nothing once the category or its group is hidden, so the save goes through (fixed 2026-11-06)', async () => {
		const b = await bank('SBI');
		await createTransaction(h, ALICE, { accountId: b.id, date: '2026-10-01', amountPaise: -L(1_200), payeeName: 'Big Bazaar', categoryId: cat('Groceries') });
		await createTransaction(h, ALICE, { accountId: b.id, date: '2026-10-02', amountPaise: -L(800), payeeName: 'Croma', categoryId: cat('Shopping') });
		await hideCategory(h.db, cat('Groceries'));
		const lifestyle = h.db.select().from(schema.categoryGroups).where(eq(schema.categoryGroups.name, 'Lifestyle')).get()!;
		await hideGroup(h.db, lifestyle.id);
		// Was: the hidden Groceries came back, filled a field the picker showed blank, and the save
		// failed with "Choose an existing category".
		const payees = await capturePayees(h.db, 'alice');
		expect(payees.find((p) => p.displayName === 'Big Bazaar')!.rememberedCategoryId).toBeNull();
		expect(payees.find((p) => p.displayName === 'Croma')!.rememberedCategoryId).toBeNull();
		const row = await createTransaction(h, ALICE, { accountId: b.id, date: '2026-11-06', amountPaise: -L(900), payeeName: 'Big Bazaar', categoryId: null });
		expect(row.categoryId).toBeNull();
	});
});

describe('N-13 an asset below zero on the Allocation donut', () => {
	it('the server sends the negative slice; the donut lists it "not drawn" and its centre reads Assets (fixed 2026-11-06)', async () => {
		const b = await bank('SBI', L(0));
		await createTransaction(h, ALICE, { accountId: b.id, date: '2026-11-05', amountPaise: -L(5_000), categoryId: cat('Groceries') }); // overdrawn
		await holding('mutualFunds', 'Index', L(1_00_000), '2024-01-01');
		const d = await dashboardSummary(h, 'alice');
		expect(d.assetsPaise).toBe(L(95_000));
		expect(d.byClass.find((s) => s.key === 'bank')!.amountPaise).toBe(-L(5_000));
		// Was: the layer rolled the −₹5,000 slice into an "Other" below zero and dropped it, so the ring
		// and its centre read ₹1,00,000 beside "Assets ₹95,000". The layer now centres on the sum of
		// every slice, which is Assets, and lists the bank "not drawn"
		// (test/components/allocation-donut.test.ts).
		expect(d.byClass.reduce((sum, s) => sum + s.amountPaise, 0)).toBe(d.assetsPaise);
	});
});

describe('N-14 EPF typed with a Salary row inside the holding (fix 3)', () => {
	it('Reports: income ₹7,200 and Invested ₹7,200; the holding counts it as put in, not return (C3, fixed 2026-11-09)', async () => {
		const epf = await holding('otherAsset', 'EPF', L(1_00_000), '2024-04-01'); // EPF waits for v2: Other asset
		await createTransaction(h, ALICE, { accountId: epf.id, date: '2026-10-31', amountPaise: L(7_200), categoryId: cat('Salary') });
		const r3 = await incomeVsExpense(h, 'alice', { from: '2026-10-01', to: '2026-10-31' });
		expect(r3.totalIncomePaise).toBe(L(7_200));
		expect(r3.totalInvestedPaise).toBe(L(7_200)); // it went straight into EPF
		const m = (await holdingMetrics(h, 'alice', epf.id))!;
		expect(m.costBasisPaise).toBe(L(1_07_200));
		expect(m.returnPaise).toBe(0); // put in, not earned
	});
	it('interest typed inside it stays return, and an uncategorised row stays return (no existing figure flips)', async () => {
		const epf = await holding('otherAsset', 'EPF', L(1_00_000), '2024-04-01');
		await createTransaction(h, ALICE, { accountId: epf.id, date: '2026-03-31', amountPaise: L(8_250), categoryId: cat('Interest') });
		await createTransaction(h, ALICE, { accountId: epf.id, date: '2026-04-30', amountPaise: L(1_000) });
		const m = (await holdingMetrics(h, 'alice', epf.id))!;
		expect(m.costBasisPaise).toBe(L(1_00_000));
		expect(m.returnPaise).toBe(L(9_250));
		const r3 = await incomeVsExpense(h, 'alice', { from: '2026-03-01', to: '2026-04-30' });
		expect(r3.totalInvestedPaise).toBe(0);
		expect(r3.totalIncomePaise).toBe(L(8_250));
	});
	it('the switch is the person’s: turned off on Interest, the same row is money put in', async () => {
		const epf = await holding('otherAsset', 'EPF', L(1_00_000), '2024-04-01');
		await createTransaction(h, ALICE, { accountId: epf.id, date: '2026-03-31', amountPaise: L(8_250), categoryId: cat('Interest') });
		await setCountsAsReturn(h.db, cat('Interest'), false);
		expect((await holdingMetrics(h, 'alice', epf.id))!.costBasisPaise).toBe(L(1_08_250));
	});
});

describe('N-15 a holding closed with Pay and close (the main button)', () => {
	it('FD ₹1,00,000 with ₹14,490 interest typed inside, paid to the bank and closed: earned ₹14,490, about 7 % a year (rule 4, fixed 2026-11-09)', async () => {
		const b = await bank('SBI', L(0));
		const fd = await holding('fd', 'FD', L(1_00_000), '2024-04-01');
		await createTransaction(h, ALICE, { accountId: fd.id, date: '2025-03-31', amountPaise: L(7_000), categoryId: cat('Interest') });
		await createTransaction(h, ALICE, { accountId: fd.id, date: '2026-03-31', amountPaise: L(7_490), categoryId: cat('Interest') });
		// The route's Pay and close: a transfer of the whole balance, then the close (zero, no write-off).
		await createTransfer(h, ALICE, { fromId: fd.id, toId: b.id, amountPaise: L(1_14_490), date: '2026-11-06' });
		await closeAccount(h, fd.id, { actingUserId: 'alice' });
		const m = (await holdingMetrics(h, 'alice', fd.id))!;
		expect(m.currentValuePaise).toBe(0);
		expect(m.costBasisPaise).toBe(0); // all of it went out (rule 1)
		expect(m.earnedPaise).toBe(L(14_490)); // it read ₹0 and "—%"
		// The rate ends at the last interest row (the value last known), as it read the day before
		// the close: closing months later doesn't lower it.
		expect(m.annualReturn!).toBeGreaterThan(0.069);
		expect(m.annualReturn!).toBeLessThan(0.071);
	});
});

describe('RT-07, the reviewer\'s hole: hide Balance adjustment, then delete its group', () => {
	it('the group delete is refused, so the next close stays out of spending (fixed 2026-11-06)', async () => {
		const adj = h.db.select({ groupId: schema.categories.groupId }).from(schema.categories)
			.where(eq(schema.categories.id, BALANCE_ADJUSTMENT_CATEGORY_ID)).get()!;
		await hideCategory(h.db, BALANCE_ADJUSTMENT_CATEGORY_ID);
		// Was: allowed (its only category hidden, no rows), taking the system category with it.
		await expect(deleteGroup(h.db, adj.groupId)).rejects.toBeInstanceOf(SystemCategoryError);
		const b = await bank('Old', L(25_000));
		await closeAccount(h, b.id, { actingUserId: 'alice' });
		const r2 = await spendingByCategory(h, 'alice', { from: '2026-11-01', to: '2026-11-30' });
		expect(r2.totalPaise).toBe(0);
	});
});

describe('N-17 a transfer between your own account and a joint one, after the joint is unshared', () => {
	it("fixed: Bob's half still reads \"To Joint (Alice's)\", he reads the joint for the dates he held it, and changes nothing there (C5 C)", async () => {
		vi.setSystemTime(new Date('2026-09-01T06:00:00Z'));
		const joint = await bank('Joint', L(50_000)); // Alice's, shared with Bob from 1 Sep
		await shareAccount(h.db, ALICE, joint.id, 'bob');
		const bobs = await bank('Bob SBI', L(20_000), 'bob');
		await createTransfer(h, { userId: 'bob' }, { fromId: bobs.id, toId: joint.id, amountPaise: L(10_000), date: '2026-10-01' });
		await createTransaction(h, ALICE, { accountId: joint.id, date: '2026-08-15', amountPaise: -L(1_000), categoryId: cat('Groceries') });
		vi.setSystemTime(new Date('2026-11-06T06:00:00Z'));
		await createTransaction(h, ALICE, { accountId: joint.id, date: '2026-11-06', amountPaise: -L(2_000), categoryId: cat('Groceries') });
		await unshareAccount(h.db, ALICE, joint.id, 'bob');

		const row = (await registerView(h, 'bob', bobs.id)).rows.find((r) => r.amountPaise === -L(10_000))!;
		expect(row.transferPartnerId).not.toBe('hidden'); // was 'hidden', read "To Bob"
		expect(row.counterpartAccountName).toBe("Joint (Alice's)");

		// The joint, read-only: the 1 Oct row only (not 15 Aug, before he joined; not today's, after).
		const j = await registerView(h, 'bob', joint.id);
		expect(j.rows.map((r) => r.date)).toEqual(['2026-10-01']);
		expect(j.access).toMatchObject({ canWrite: false, heldUntil: '2026-11-05', joined: { date: '2026-09-01', balancePaise: L(49_000) } });
		expect(j.asOfTodayPaise).toBe(L(59_000)); // the balance when he left, not today's ₹57,000

		const bobLeg = h.db.select().from(schema.transactions).where(eq(schema.transactions.accountId, bobs.id)).all()
			.find((r) => r.transferPartnerId !== null)!;
		await expect(deleteTransaction(h, { userId: 'bob' }, bobLeg.id, bobLeg.updatedAt))
			.rejects.toThrow("The other half of this transfer is in Joint, which is no longer shared with you. Ask Alice to change it.");
		const aliceLeg = h.db.select().from(schema.transactions).where(eq(schema.transactions.accountId, joint.id)).all()
			.find((r) => r.transferPartnerId !== null)!;
		await expect(deleteTransaction(h, ALICE, aliceLeg.id, aliceLeg.updatedAt)).rejects.toBeInstanceOf(HiddenTransferError);
		await expect(deleteTransaction(h, { userId: 'bob' }, aliceLeg.id, aliceLeg.updatedAt)).rejects.toThrow(/not found|Not found|AccountNotFound/i);
	});
	it('re-sharing gives Bob back his earlier dates, so he can fix the pair (the way out for N-17)', async () => {
		vi.setSystemTime(new Date('2026-09-01T06:00:00Z'));
		const joint = await bank('Joint', L(50_000));
		await shareAccount(h.db, ALICE, joint.id, 'bob');
		const bobs = await bank('Bob SBI', L(20_000), 'bob');
		await createTransfer(h, { userId: 'bob' }, { fromId: bobs.id, toId: joint.id, amountPaise: L(10_000), date: '2026-10-01' });
		vi.setSystemTime(new Date('2026-11-01T06:00:00Z'));
		await unshareAccount(h.db, ALICE, joint.id, 'bob');
		vi.setSystemTime(new Date('2026-11-06T06:00:00Z'));
		await shareAccount(h.db, ALICE, joint.id, 'bob');
		expect(h.db.select().from(schema.accountHolderPeriods).all().map((p) => [p.fromDate, p.toDate]))
			.toEqual([['2026-09-01', '2026-11-01'], ['2026-11-06', null]]);
		const bobLeg = h.db.select().from(schema.transactions).where(eq(schema.transactions.accountId, bobs.id)).all()
			.find((r) => r.transferPartnerId !== null)!;
		await updateTransaction(h, { userId: 'bob' }, bobLeg.id, { amountPaise: -L(9_000) }, bobLeg.updatedAt);
		expect(accountBalance(h.sqlite, joint.id)).toBe(L(59_000));
	});
});

describe('N-18 the same, after Bob is removed from the Circle', () => {
	async function bobLeaves() {
		vi.setSystemTime(new Date('2026-09-01T06:00:00Z'));
		const joint = await bank('Joint', L(50_000));
		await shareAccount(h.db, ALICE, joint.id, 'bob');
		const bobs = await bank('Bob SBI', L(20_000), 'bob');
		await createTransfer(h, { userId: 'bob' }, { fromId: bobs.id, toId: joint.id, amountPaise: L(10_000), date: '2026-10-01' });
		vi.setSystemTime(new Date('2026-11-06T06:00:00Z'));
		await removeMember(h.db, { id: 'alice', role: 'admin' }, 'bob'); // allowed: Bob owns no shared account
		const leg = () => h.db.select().from(schema.transactions).where(eq(schema.transactions.accountId, joint.id)).all()
			.find((r) => r.amountPaise > 0 && r.date === '2026-10-01')!;
		return { joint, bobs, leg };
	}
	it('fixed: Alice changes her own half alone; it becomes a plain row, "Bob (left)", and Bob\'s account is untouched (H3 RD8)', async () => {
		const { joint, bobs, leg } = await bobLeaves();
		// Was "Ask Bob", for good. While linked it reads "From Bob (left)".
		const before = (await registerView(h, 'alice', joint.id)).rows.find((r) => r.id === leg().id)!;
		expect(before.partnerLeft).toBe('Bob');
		await updateTransaction(h, ALICE, leg().id, { amountPaise: L(9_000) }, leg().updatedAt);
		const after = leg();
		expect(after.amountPaise).toBe(L(9_000));
		expect(after.transferPartnerId).toBeNull();
		const row = (await registerView(h, 'alice', joint.id)).rows.find((r) => r.id === after.id)!;
		expect(row.payeeName).toBe('Bob (left)');
		expect(accountBalance(h.sqlite, joint.id)).toBe(L(59_000));
		expect(accountBalance(h.sqlite, bobs.id)).toBe(L(10_000)); // his half stays as it was, unlinked
		expect(h.db.select().from(schema.transactions).where(eq(schema.transactions.accountId, bobs.id)).all()
			.every((r) => r.transferPartnerId === null)).toBe(true);
	});
	it('fixed: Alice deletes her own half alone', async () => {
		const { joint, bobs, leg } = await bobLeaves();
		await deleteTransaction(h, ALICE, leg().id, leg().updatedAt);
		expect(accountBalance(h.sqlite, joint.id)).toBe(L(50_000));
		expect(accountBalance(h.sqlite, bobs.id)).toBe(L(10_000));
		// His stretch ended the day he left, so Alice's past split stays as it was.
		expect(h.db.select().from(schema.accountHolderPeriods).all().map((p) => [p.fromDate, p.toDate])).toEqual([['2026-09-01', '2026-11-06']]);
	});
	it('holds: while Bob is still in the Circle, the refusal stands ("Ask Bob")', async () => {
		vi.setSystemTime(new Date('2026-09-01T06:00:00Z'));
		const joint = await bank('Joint', L(50_000));
		await shareAccount(h.db, ALICE, joint.id, 'bob');
		const bobs = await bank('Bob SBI', L(20_000), 'bob');
		await createTransfer(h, { userId: 'bob' }, { fromId: bobs.id, toId: joint.id, amountPaise: L(10_000), date: '2026-10-01' });
		vi.setSystemTime(new Date('2026-11-06T06:00:00Z'));
		const leg = h.db.select().from(schema.transactions).where(eq(schema.transactions.accountId, joint.id)).all().find((r) => r.transferPartnerId !== null)!;
		await expect(deleteTransaction(h, ALICE, leg.id, leg.updatedAt)).rejects.toThrow(/Ask Bob/);
		expect((await registerView(h, 'alice', joint.id)).rows.find((r) => r.id === leg.id)!.partnerLeft).toBeNull();
	});
});

describe("Step 4's screen run (2026-11-09): three more", () => {
	it("a member who joined later gets no opening, on the page or in the account list", async () => {
		const joint = await bank('Joint', L(50_000)); // opened 1 Jan 2024
		await shareAccount(h.db, ALICE, joint.id, 'bob'); // today
		const v = await registerView(h, 'bob', joint.id);
		expect([v.account.openingPaise, v.account.openingDate]).toEqual([0, null]); // read ₹50,000, 1 Jan 2024
		expect(v.access.joined).toEqual({ date: '2026-11-06', balancePaise: L(50_000) });
		const listed = (await listAccounts(h, 'bob')).find((a) => a.id === joint.id)!;
		expect([listed.openingPaise, listed.openingDate]).toEqual([0, null]);
		expect((await registerView(h, 'alice', joint.id)).account.openingPaise).toBe(L(50_000));
	});
	it("the grid re-posts a transfer's empty payee with the new amount; the unlinked half keeps \"Carol (left)\"", async () => {
		h.db.insert(schema.users).values({ id: 'carol', username: 'carol', displayName: 'Carol', role: 'member' }).run();
		vi.setSystemTime(new Date('2026-07-01T06:00:00Z'));
		const trip = await bank('Trip pot', L(0));
		await shareAccount(h.db, ALICE, trip.id, 'carol');
		const hers = await bank('Carol HDFC', L(30_000), 'carol');
		await createTransfer(h, { userId: 'carol' }, { fromId: hers.id, toId: trip.id, amountPaise: L(8_000), date: '2026-08-15' });
		vi.setSystemTime(new Date('2026-11-06T06:00:00Z'));
		await removeMember(h.db, { id: 'alice', role: 'admin' }, 'carol');
		const leg = h.db.select().from(schema.transactions).where(eq(schema.transactions.accountId, trip.id)).get()!;
		await updateTransaction(h, ALICE, leg.id, { amountPaise: L(7_500), date: leg.date, payeeName: '', notes: null }, leg.updatedAt);
		const row = (await registerView(h, 'alice', trip.id)).rows[0]!;
		expect([row.payeeName, row.amountPaise, row.transferPartnerId]).toEqual(['Carol (left)', L(7_500), null]); // read "No payee"
	});
	it("a shared holding's row reads the viewer's own rate, as the section's headline does", async () => {
		vi.setSystemTime(new Date('2024-11-02T06:00:00Z'));
		const mf = await holding('mutualFunds', 'Index', L(1_00_000), '2023-11-01');
		await postValuationMark(h, ALICE, { accountId: mf.id, targetPaise: 1_41_42_136, date: '2024-11-01' });
		await shareAccount(h.db, ALICE, mf.id, 'bob');
		vi.setSystemTime(new Date('2026-11-06T06:00:00Z'));
		await postValuationMark(h, ALICE, { accountId: mf.id, targetPaise: L(2_00_000), date: '2026-11-01' });
		// Bob's header was the fund in full (26.0 %); since H2 RD11 (L10) it is measured from the
		// day he joined, so it agrees with his row and the section's headline.
		const own = (await holdingMetrics(h, 'bob', mf.id))!.annualReturn!;
		const row = (await sharedAnnualReturns(h, 'bob', [mf.id])).get(mf.id)!;
		const section = (await sectionAnnualReturn(h, 'bob', 'mutualFunds'))!;
		expect(own).toBeCloseTo(0.189, 2);
		expect((await holdingMetrics(h, 'alice', mf.id))!.annualReturn!).toBeCloseTo(0.26, 2); // Alice's is the fund in full
		expect(row).toBeCloseTo(section, 6); // read 26.0 % beside the headline's 18.9 %
		expect(row).toBeCloseTo(0.189, 2);
	});
});

// ── The notes ──────────────────────────────

describe("Notes: a value update dated before the account's start", () => {
	it('is refused on posting and on a date edit; one typed before the rule keeps its date (fixed 2026-11-06)', async () => {
		// An apartment valued 5 Oct and opened 23 Oct.
		const flat = await holding('property', 'Apartment', L(50_00_000), '2026-10-23');
		await expect(postValuationMark(h, ALICE, { accountId: flat.id, targetPaise: L(55_00_000), date: '2026-10-05' })).rejects.toBeInstanceOf(MarkBeforeStartError);
		const r = await postValuationMark(h, ALICE, { accountId: flat.id, targetPaise: L(55_00_000), date: '2026-10-23' });
		const mark = h.db.select().from(schema.transactions).where(eq(schema.transactions.id, r.id!)).get()!;
		await expect(editMarkTarget(h, ALICE, r.id!, L(56_00_000), mark.updatedAt, { date: '2026-10-05' })).rejects.toThrow(
			"A value update can't be dated before the account's start (23 Oct 2026)"
		);
		// An older one already before the start: its value still edits, its date unchanged.
		h.db.update(schema.transactions).set({ date: '2026-10-05' }).where(eq(schema.transactions.id, r.id!)).run();
		const old = h.db.select().from(schema.transactions).where(eq(schema.transactions.id, r.id!)).get()!;
		await editMarkTarget(h, ALICE, r.id!, L(56_00_000), old.updatedAt, { date: '2026-10-05' });
		expect(accountBalance(h.sqlite, flat.id)).toBe(L(56_00_000));
	});
});

describe('N-16 (holds) future-dated rows in To categorize', () => {
	it('an uncategorised row dated next month is listed; Reports stop at today, so nothing is counted twice', async () => {
		const b = await bank('SBI');
		await createTransaction(h, ALICE, { accountId: b.id, date: '2026-12-05', amountPaise: -L(20_000) });
		expect((await inboxTransactions(h, 'alice')).map((r) => r.date)).toEqual(['2026-12-05']);
		const r2 = await spendingByCategory(h, 'alice', { from: '2026-11-01', to: '2026-12-31' });
		expect(r2.totalPaise).toBe(0);
	});
});

// ── Step 3, the fund rules ─────────────────

describe('Step 3: the return flag each row carries into the engine (migration 0012, the contract field)', () => {
	it('comes from the row\'s category, or a transfer leg\'s partner\'s; a value update and an uncategorised row carry none', async () => {
		const b = await bank('SBI', L(0));
		const fd = await holding('fd', 'FD', L(1_00_000), '2024-04-01');
		const epf = await holding('otherAsset', 'EPF', L(1_00_000), '2024-04-01');
		const interest = await createTransaction(h, ALICE, { accountId: fd.id, date: '2025-03-31', amountPaise: L(7_000), categoryId: cat('Interest') });
		const salary = await createTransaction(h, ALICE, { accountId: epf.id, date: '2025-03-31', amountPaise: L(7_200), categoryId: cat('Salary') });
		const plain = await createTransaction(h, ALICE, { accountId: epf.id, date: '2025-04-30', amountPaise: L(500) });
		const payout = await createTransfer(h, ALICE, { fromId: fd.id, toId: b.id, amountPaise: L(7_000), date: '2025-04-01', categoryId: cat('Interest') });
		const sip = await createTransfer(h, ALICE, { fromId: b.id, toId: epf.id, amountPaise: L(1_000), date: '2025-04-02', categoryId: cat('SIP') });
		const move = await createTransfer(h, ALICE, { fromId: b.id, toId: fd.id, amountPaise: L(1_000), date: '2025-04-03' });
		const mark = await postValuationMark(h, ALICE, { accountId: fd.id, targetPaise: L(2_00_000), date: '2025-05-01' });
		const rows = h.db.select().from(schema.transactions).all();
		const flags = returnFlags(h.db, rows);
		const legOn = (t: { fromTxId: string; toTxId: string }, accountId: string) =>
			rows.find((r) => (r.id === t.fromTxId || r.id === t.toTxId) && r.accountId === accountId)!.id;
		expect(flags.get(interest.id)).toBe(true);
		expect(flags.get(salary.id)).toBe(false);
		expect(flags.has(plain.id)).toBe(false);
		expect(flags.get(legOn(payout, fd.id))).toBe(true); // the FD's leg reads the bank leg's Interest
		expect(flags.get(legOn(sip, epf.id))).toBe(false);
		expect(flags.has(legOn(move, fd.id))).toBe(false);
		expect(flags.has(mark.id!)).toBe(false);
	});
	it('a new file seeds "Loan interest" and "Tax (TDS)" as spending, in Essentials before its Other (C11)', async () => {
		const ess = h.db.select().from(schema.categoryGroups).where(eq(schema.categoryGroups.name, 'Essentials')).get()!;
		expect(ess.kind).toBe('spending');
		const names = h.db.select({ name: schema.categories.name, on: schema.categories.countsAsReturn }).from(schema.categories)
			.where(eq(schema.categories.groupId, ess.id)).orderBy(schema.categories.sortOrder).all();
		expect(names.map((c) => c.name).slice(-3)).toEqual(['Loan interest', 'Tax (TDS)', 'Other']);
		expect(names.every((c) => !c.on)).toBe(true);
		// Gross interest plus a TDS row: income the gross, spending the tax.
		const b = await bank('SBI', L(0));
		await createTransaction(h, ALICE, { accountId: b.id, date: '2026-10-31', amountPaise: L(10_000), categoryId: cat('Interest') });
		await createTransaction(h, ALICE, { accountId: b.id, date: '2026-10-31', amountPaise: -L(1_000), categoryId: cat('Tax (TDS)') });
		const r3 = await incomeVsExpense(h, 'alice', { from: '2026-10-01', to: '2026-10-31' });
		expect([r3.totalIncomePaise, r3.totalExpensePaise]).toEqual([L(10_000), L(1_000)]);
	});
	it('a new file seeds Interest, Dividends and Balance adjustment as return, and Investments as its own kind', async () => {
		const on = h.db.select({ name: schema.categories.name }).from(schema.categories)
			.where(eq(schema.categories.countsAsReturn, true)).all().map((c) => c.name).sort();
		expect(on).toEqual(['Balance adjustment', 'Dividends', 'Interest']);
		const inv = h.db.select({ kind: schema.categoryGroups.kind }).from(schema.categoryGroups)
			.where(eq(schema.categoryGroups.name, 'Investments')).get();
		expect(inv?.kind).toBe('investments');
	});
});
