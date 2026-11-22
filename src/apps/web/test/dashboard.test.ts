/**
 * dashboard.test.ts — the M7 aggregation service (D1–D4).
 * ============================================================================
 * Proves the invariants dashboard.ts owns:
 *   - RECONCILIATION: netWorth == assets + liabilities; Σ allocation slices ==
 *     total assets (the pie can never disagree with the hero).
 *   - THE D1/D3 ASYMMETRY: D1 excludes closed accounts; D3 history counts them
 *     for the periods they were open, then 0 after their zeroing close; the
 *     latest history point equals the D1 hero.
 *   - F1 RD10 dated opening: an account contributes 0 to months before its
 *     opening_date.
 *   - TRANSFER COLLAPSE: a two-legged transfer is ONE feed entry, never two.
 *   - PRIVACY (P0): the admin gets NO aggregate over accounts they don't hold;
 *     an empty visible set yields zero/empty, never "all".
 * ============================================================================
 */
import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb } from '../src/lib/server/db/client';
import { allStatements } from '../src/lib/server/db/migrate';
import type { Db } from '../src/lib/server/db/client';
import * as schema from '../src/lib/server/db/schema';
import { closeAccount } from '../src/lib/server/accounts';
import {
	dashboardSummary,
	netWorthHistory,
	recentActivity,
	accountSummary
} from '../src/lib/server/dashboard';

let handle: Db | undefined;
afterEach(() => {
	handle?.sqlite.close();
	handle = undefined;
});

function seed(): Db {
	const h = createDb(':memory:');
	handle = h;
	for (const stmt of allStatements()) h.sqlite.exec(stmt);
	h.db
		.insert(schema.users)
		.values([
			{ id: 'alice', username: 'alice', displayName: 'Alice', role: 'admin' },
			{ id: 'bob', username: 'bob', displayName: 'Bob', role: 'member' },
			{ id: 'carol', username: 'carol', displayName: 'Carol', role: 'member' }
		])
		.run();
	return h;
}

interface AcctSpec {
	id: string;
	ownerId?: string;
	type?: string;
	name: string;
	openingPaise?: number;
	openingDate?: string | null;
	status?: 'open' | 'closed';
}
function addAccount(h: Db, a: AcctSpec): void {
	h.db
		.insert(schema.accounts)
		.values({
			id: a.id,
			ownerId: a.ownerId ?? 'alice',
			type: a.type ?? 'bank',
			name: a.name,
			currency: 'INR',
			status: a.status ?? 'open',
			openingPaise: a.openingPaise ?? 0,
			openingDate: a.openingDate ?? null
		})
		.run();
}
function addTx(
	h: Db,
	t: {
		id: string;
		accountId: string;
		date: string;
		sequence?: number;
		amountPaise: number;
		transferPartnerId?: string;
		kind?: 'ordinary' | 'valuationMark';
		enteredBy?: string;
	}
): void {
	h.db
		.insert(schema.transactions)
		.values({
			id: t.id,
			accountId: t.accountId,
			date: t.date,
			sequence: t.sequence ?? 0,
			amountPaise: t.amountPaise,
			transferPartnerId: t.transferPartnerId ?? null,
			kind: t.kind ?? 'ordinary',
			enteredBy: t.enteredBy ?? null
		})
		.run();
}

describe('dashboardSummary: reconciliation', () => {
	it('netWorth == assets + liabilities, and Σ allocation slices == total assets', async () => {
		const h = seed();
		addAccount(h, { id: 'bank', name: 'HDFC', openingPaise: 100_000, openingDate: '2024-01-01' });
		addAccount(h, { id: 'cc', type: 'creditCard', name: 'Amex', openingPaise: -30_000, openingDate: '2024-01-01' });

		const s = await dashboardSummary(h, 'alice');
		expect(s.assetsPaise).toBe(100_000);
		expect(s.liabilitiesPaise).toBe(-30_000);
		expect(s.netWorthPaise).toBe(70_000);
		expect(s.netWorthPaise).toBe(s.assetsPaise + s.liabilitiesPaise);

		const classTotal = s.byClass.reduce((sum, x) => sum + x.amountPaise, 0);
		const liqTotal = s.byLiquidity.reduce((sum, x) => sum + x.amountPaise, 0);
		expect(classTotal).toBe(s.assetsPaise); // liabilities never sliced
		expect(liqTotal).toBe(s.assetsPaise);
		expect(s.liquidAssetsPaise).toBe(100_000);
		expect(s.hasOpenAccounts).toBe(true);
	});

	it('a joint account counts at the share; the shared line lists it in full and at the share (D1 RD12)', async () => {
		const h = seed();
		addAccount(h, { id: 'priv', name: 'Private', openingPaise: 100_000, openingDate: '2024-01-01' });
		addAccount(h, { id: 'joint', name: 'Joint', openingPaise: 60_000, openingDate: '2024-01-01' });
		h.db.insert(schema.accountMembers).values({ accountId: 'joint', userId: 'bob' }).run();

		const s = await dashboardSummary(h, 'alice');
		// Chat J (D1 RD12): the joint account counts at alice's share, equal with bob (no stated split).
		expect(s.netWorthPaise).toBe(130_000);
		expect(s.sharedLine).toEqual({
			fullPaise: 60_000,
			sharePaise: 30_000,
			accounts: [{ id: 'joint', name: 'Joint', side: 'Asset', fullPaise: 60_000, sharePaise: 30_000, shareBp: 5_000 }]
		});
		const classTotal = s.byClass.reduce((sum, x) => sum + x.amountPaise, 0);
		expect(classTotal).toBe(s.assetsPaise); // allocation at the share reconciles too
		// No joint account, no line (hidden, D1 RD12).
		h.db.delete(schema.accountMembers).run();
		expect((await dashboardSummary(h, 'alice')).sharedLine).toBeNull();
	});

	it('empty visible set → zero net worth + no-accounts empty state (never "all")', async () => {
		const h = seed();
		addAccount(h, { id: 'bank', ownerId: 'bob', name: 'Bob Bank', openingPaise: 100_000, openingDate: '2024-01-01' });
		const s = await dashboardSummary(h, 'carol'); // carol holds nothing
		expect(s.netWorthPaise).toBe(0);
		expect(s.hasOpenAccounts).toBe(false);
		expect(s.byClass).toEqual([]);
	});
});

describe('privacy: admin gets no aggregate bypass', () => {
	it("the admin's dashboard excludes an account they neither own nor share", async () => {
		const h = seed();
		// Bob's private account — alice is admin but not a holder.
		addAccount(h, { id: 'bobbank', ownerId: 'bob', name: 'Bob Private', openingPaise: 500_000, openingDate: '2024-01-01' });
		const s = await dashboardSummary(h, 'alice');
		expect(s.netWorthPaise).toBe(0);
		expect(s.hasOpenAccounts).toBe(false);
		expect(await recentActivity(h, 'alice')).toEqual([]);
		expect(await accountSummary(h, 'alice')).toEqual([]);
	});
});

describe('D1/D3 asymmetry: closed accounts', () => {
	it('D1 excludes a closed account; D3 counts it while open then 0 after close; latest point == hero', async () => {
		const h = seed();
		addAccount(h, { id: 'keep', name: 'Keep', openingPaise: 100_000, openingDate: '2024-01-01' });
		addAccount(h, { id: 'gone', name: 'Gone', openingPaise: 50_000, openingDate: '2024-01-01' });
		// Force-close 'gone' on 2024-02-10 (posts a zeroing -50_000 adjustment).
		await closeAccount(h, 'gone', { closeDate: '2024-02-10' });

		const s = await dashboardSummary(h, 'alice');
		expect(s.netWorthPaise).toBe(100_000); // D1: closed 'gone' excluded

		const hist = await netWorthHistory(h, 'alice', 'ALL');
		// First month-end (2024-01-31): both open → 150_000 (closed counted while open).
		// The line begins on the ledger's first day (2026-11-04), then month ends.
		expect(hist.points[0]?.date).toBe('2024-01-01');
		expect(hist.points.find((p) => p.date === '2024-01-31')?.netWorthPaise).toBe(150_000);
		// Latest point (today) == D1 hero.
		expect(hist.points.at(-1)?.netWorthPaise).toBe(100_000);
		// A point after the close is back to 100_000 (gone zeroed).
		const feb = hist.points.find((p) => p.date === '2024-02-29');
		expect(feb?.netWorthPaise).toBe(100_000);
		expect(hist.changeSinceLastMonth).not.toBeNull();
	});

	it('honors RD10 dated opening: an account contributes 0 to months before its opening_date', async () => {
		const h = seed();
		addAccount(h, { id: 'early', name: 'Early', openingPaise: 100_000, openingDate: '2024-01-01' });
		addAccount(h, { id: 'late', name: 'Late', openingPaise: 200_000, openingDate: '2024-06-15' });

		const hist = await netWorthHistory(h, 'alice', 'ALL');
		// 2024-01-31: 'late' didn't exist yet → only 'early' counts (its opening must not leak).
		// The line begins on the ledger's first day (2026-11-04), then month ends.
		expect(hist.points[0]?.date).toBe('2024-01-01');
		expect(hist.points.find((p) => p.date === '2024-01-31')?.netWorthPaise).toBe(100_000);
		// 2024-06-30: both exist → 300_000.
		const jun = hist.points.find((p) => p.date === '2024-06-30');
		expect(jun?.netWorthPaise).toBe(300_000);
	});
});

describe('recentActivity: transfer collapse', () => {
	it('a two-legged transfer appears as ONE feed entry, source → destination', async () => {
		const h = seed();
		addAccount(h, { id: 'a', name: 'Savings' });
		addAccount(h, { id: 'b', name: 'Wallet' });
		// Insert-then-link: the mutual self-referential FK can't be satisfied in one shot.
		addTx(h, { id: 'legOut', accountId: 'a', date: '2024-03-01', amountPaise: -50_000 });
		addTx(h, { id: 'legIn', accountId: 'b', date: '2024-03-01', amountPaise: 50_000, transferPartnerId: 'legOut' });
		h.db.update(schema.transactions).set({ transferPartnerId: 'legIn' }).where(eq(schema.transactions.id, 'legOut')).run();

		const feed = await recentActivity(h, 'alice');
		const transfers = feed.filter((r) => r.entryType === 'transfer');
		expect(transfers).toHaveLength(1); // never two legs
		expect(transfers[0]?.transferFromName).toBe('Savings');
		expect(transfers[0]?.transferToName).toBe('Wallet');
	});

	it('surfaces entered_by on a shared account (H3 audit)', async () => {
		const h = seed();
		addAccount(h, { id: 'shared', name: 'Joint', ownerId: 'alice' });
		h.db.insert(schema.accountMembers).values({ accountId: 'shared', userId: 'bob' }).run();
		addTx(h, { id: 't1', accountId: 'shared', date: '2024-03-01', amountPaise: 10_000, enteredBy: 'bob' });

		const feed = await recentActivity(h, 'alice');
		const row = feed.find((r) => r.id === 't1');
		expect(row?.isSharedAccount).toBe(true);
		expect(row?.enteredByName).toBe('Bob');
	});
});

describe('recentActivity search (All transactions, D4 RD6)', () => {
	it('matches the account, the transfer counterpart and notes; a typed % is literal', async () => {
		const h = seed();
		addAccount(h, { id: 'a', name: 'Savings' });
		addAccount(h, { id: 'b', name: 'Wallet' });
		addTx(h, { id: 'legOut', accountId: 'a', date: '2024-03-01', amountPaise: -50_000 });
		addTx(h, { id: 'legIn', accountId: 'b', date: '2024-03-01', amountPaise: 50_000, transferPartnerId: 'legOut' });
		h.db.update(schema.transactions).set({ transferPartnerId: 'legIn' }).where(eq(schema.transactions.id, 'legOut')).run();
		addTx(h, { id: 'n1', accountId: 'a', date: '2024-03-02', amountPaise: -100 });
		h.db.update(schema.transactions).set({ notes: '50% off' }).where(eq(schema.transactions.id, 'n1')).run();
		addTx(h, { id: 'n2', accountId: 'a', date: '2024-03-03', amountPaise: -200 });

		expect((await recentActivity(h, 'alice', 50, 'wallet')).map((r) => r.entryType)).toEqual(['transfer']);
		expect((await recentActivity(h, 'alice', 50, '50%')).map((r) => r.id)).toEqual(['n1']);
		expect((await recentActivity(h, 'alice', 50, '5_')).map((r) => r.id)).toEqual([]);
		expect(await recentActivity(h, 'alice', 50, '  ')).toHaveLength(3);
	});
});

describe('accountSummary: grouped subtotals reconcile to the hero', () => {
	it('group subtotals sum to the D1 net worth (open accounts only)', async () => {
		const h = seed();
		addAccount(h, { id: 'b1', name: 'HDFC', openingPaise: 100_000, openingDate: '2024-01-01' });
		addAccount(h, { id: 'b2', name: 'ICICI', openingPaise: 40_000, openingDate: '2024-01-01' });

		const groups = await accountSummary(h, 'alice');
		const total = groups.reduce((sum, g) => sum + g.subtotalPaise, 0);
		const s = await dashboardSummary(h, 'alice');
		expect(total).toBe(s.netWorthPaise);
	});
});
