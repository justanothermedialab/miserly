/**
 * account-label.test.ts — two accounts the viewer sees with one name in
 * different sections read "HDFC (Bank accounts)" / "HDFC (Mutual funds)" wherever an account is
 * named, beside C8's "(Bob's)" and "(closed)"; a name only one account has stays bare; lists under a
 * section heading show the bare name and the field the whole label.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { createDb, type Db } from '../src/lib/server/db/client';
import { allStatements } from '../src/lib/server/db/migrate';
import * as schema from '../src/lib/server/db/schema';
import { createAccount, createHoldingAccount, closeAccount } from '../src/lib/server/accounts';
import { createTransaction, inboxTransactions, registerView } from '../src/lib/server/transactions';
import { createTransfer } from '../src/lib/server/transfers';
import { resolveTransferTarget, transferTargetsFor } from '../src/lib/server/inline-transfer';
import { recentActivity } from '../src/lib/server/dashboard';
import { flowTransactions } from '../src/lib/server/reports';
import { shareAccount } from '../src/lib/server/sharing';
import { seedStarterCategories } from '../src/lib/server/seed';
import { accountLabel, sharedNames, transferOptions } from '../src/lib/transfer-targets';

describe('the label rule', () => {
	const accounts = [
		{ name: 'HDFC', type: 'bank' },
		{ name: 'hdfc ', type: 'mutualFunds' }, // case and spaces aside, the same name
		{ name: 'SBI', type: 'bank' },
		{ name: 'ICICI', type: 'bank' },
		{ name: 'ICICI', type: 'bank' } // same section: the section tells nothing apart
	];
	const shared = sharedNames(accounts);
	const label = (name: string, type: string, ownerId = 'alice', status = 'open', ownerName: string | null = null) =>
		accountLabel({ name, type, ownerId, status }, ownerName, 'alice', shared);

	it('a name in two sections adds the section; a unique name and a same-section pair stay bare', () => {
		expect(label('HDFC', 'bank')).toBe('HDFC (Bank accounts)');
		expect(label('HDFC', 'mutualFunds')).toBe('HDFC (Mutual funds)');
		expect(label('SBI', 'bank')).toBe('SBI');
		expect(label('ICICI', 'bank')).toBe('ICICI');
	});
	it('goes beside "(Bob\'s)" and "(closed)"', () => {
		expect(label('HDFC', 'mutualFunds', 'bob', 'open', 'Bob')).toBe("HDFC (Mutual funds) (Bob's)");
		expect(label('HDFC', 'bank', 'alice', 'closed')).toBe('HDFC (Bank accounts) (closed)');
		expect(label('HDFC', 'bank', 'bob', 'closed', 'Bob')).toBe("HDFC (Bank accounts) (Bob's) (closed)");
		expect(label('SBI', 'bank', 'bob', 'open', 'Bob')).toBe("SBI (Bob's)");
	});
	it('without the set, C8 alone (the line under a heading)', () => {
		expect(accountLabel({ name: 'HDFC', type: 'bank', ownerId: 'bob', status: 'open' }, 'Bob', 'alice')).toBe("HDFC (Bob's)");
	});
});

describe('every screen reads it from one place', () => {
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

	const L = (rupees: number) => rupees * 100;
	const ALICE = { userId: 'alice' };
	const bank = (name: string, owner = 'alice') =>
		createAccount(h, { ownerId: owner, type: 'bank', name, currency: 'INR', openingPaise: L(1_00_000), openingDate: '2024-01-01' });
	const fund = (name: string) =>
		createHoldingAccount(h, { ownerId: 'alice', type: 'mutualFunds', name, currency: 'INR', investedPaise: L(50_000), investedDate: '2024-01-01', currentValuePaise: null });
	const salary = () => {
		const row = h.db.select({ id: schema.categories.id }).from(schema.categories)
			.where(and(eq(schema.categories.name, 'Salary'), isNull(schema.categories.deletedAt))).get();
		return row!.id;
	};

	it('payee lists, the field, a transfer, All transactions, Recent activity, the inbox and Reports', async () => {
		const hdfc = await bank('HDFC');
		const mf = await fund('HDFC');
		const sbi = await bank('SBI');

		// Payee list: the bare name under its heading; the field holds the whole label.
		const targets = await transferTargetsFor(h, 'alice');
		const lines = transferOptions(targets.filter((t) => t.id !== sbi.id));
		expect(lines.map((o) => [o.group, o.label, o.value])).toEqual([
			['Transfer: Bank accounts', 'HDFC', 'Transfer → HDFC (Bank accounts)'],
			['Transfer: Mutual funds', 'HDFC', 'Transfer → HDFC (Mutual funds)']
		]);
		expect(targets.find((t) => t.id === sbi.id)!.label).toBe('SBI');
		// The whole label typed by hand names one account; "HDFC" alone still names two.
		const typed = resolveTransferTarget(targets, sbi.id, 'Transfer → HDFC (Mutual funds)', '');
		expect(typeof typed === 'string' ? typed : typed.id).toBe(mf.id);
		expect(resolveTransferTarget(targets, sbi.id, 'Transfer → HDFC', '')).toBe('Two accounts are called HDFC: pick one from the list');

		await createTransfer(h, ALICE, { fromId: hdfc.id, toId: mf.id, amountPaise: L(5_000), date: '2026-11-02' });
		await createTransaction(h, ALICE, { accountId: hdfc.id, date: '2026-11-03', amountPaise: -L(300) }); // uncategorised
		await createTransaction(h, ALICE, { accountId: hdfc.id, date: '2026-11-04', amountPaise: L(900), categoryId: salary() });

		// The register's transfer text, on both sides.
		expect((await registerView(h, 'alice', hdfc.id)).rows.find((r) => r.transferPartnerId)!.counterpartAccountName).toBe('HDFC (Mutual funds)');
		expect((await registerView(h, 'alice', mf.id)).rows.find((r) => r.transferPartnerId)!.counterpartAccountName).toBe('HDFC (Bank accounts)');
		// All transactions and Recent activity (one feed).
		const feed = await recentActivity(h, 'alice', 10);
		const move = feed.find((r) => r.date === '2026-11-02')!;
		expect([move.accountName, move.transferFromName, move.transferToName]).toEqual(['HDFC (Bank accounts)', 'HDFC (Bank accounts)', 'HDFC (Mutual funds)']);
		// To categorize and the Reports drill.
		expect((await inboxTransactions(h, 'alice')).map((r) => r.accountName)).toEqual(['HDFC (Bank accounts)']);
		expect((await flowTransactions(h, 'alice', { from: '2026-11-01', to: '2026-11-30' }, 'income')).map((r) => r.accountName)).toEqual(['HDFC (Bank accounts)']);
	});

	it('a closed account still counts, and reads "(closed)" after its section', async () => {
		const sbi = await bank('SBI');
		const mf = await fund('HDFC');
		await createTransfer(h, ALICE, { fromId: mf.id, toId: sbi.id, amountPaise: L(50_000), date: '2026-10-01' });
		await closeAccount(h, mf.id, { actingUserId: 'alice' });
		const hdfc = await bank('HDFC');
		expect((await transferTargetsFor(h, 'alice')).find((t) => t.id === hdfc.id)!.label).toBe('HDFC (Bank accounts)');
		expect((await registerView(h, 'alice', sbi.id)).rows.find((r) => r.transferPartnerId)!.counterpartAccountName).toBe('HDFC (Mutual funds) (closed)');
	});

	it("comes in the sidebar's order: by section, then name A to Z", async () => {
		await bank('SBI');
		await fund('HDFC');
		await bank('HDFC');
		await createAccount(h, { ownerId: 'alice', type: 'loan', name: 'Home', currency: 'INR', openingPaise: -L(5_00_000), openingDate: '2024-01-01' });
		await createAccount(h, { ownerId: 'alice', type: 'loan', name: 'Car', currency: 'INR', openingPaise: -L(3_00_000), openingDate: '2024-01-01' });
		expect((await transferTargetsFor(h, 'alice')).map((t) => t.label)).toEqual([
			'HDFC (Bank accounts)', 'SBI', 'Car', 'Home', 'HDFC (Mutual funds)'
		]);
	});

	it("only the viewer's visible set counts (P0): Bob's HDFC stays bare beside Alice's private fund", async () => {
		await fund('HDFC');
		const bobs = await bank('HDFC', 'bob');
		expect((await transferTargetsFor(h, 'bob')).map((t) => t.label)).toEqual(['HDFC']);
		// Shared with Alice, she sees both: hers is a fund, his a bank, and it's his.
		await shareAccount(h.db, { userId: 'bob' }, bobs.id, 'alice');
		const labels = (await transferTargetsFor(h, 'alice')).map((t) => [t.label, t.listLabel]).sort();
		expect(labels).toEqual([
			["HDFC (Bank accounts) (Bob's)", "HDFC (Bob's)"],
			['HDFC (Mutual funds)', 'HDFC']
		]);
		expect((await transferTargetsFor(h, 'bob')).map((t) => t.label)).toEqual(['HDFC']);
	});
});
