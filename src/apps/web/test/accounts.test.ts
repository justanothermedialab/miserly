/**
 * accounts.test.ts — F1 account lifecycle (create · force-close · reopen · list).
 * ============================================================================
 * Proves the two invariants that make accounts.ts the correctness core:
 *   - balance is DERIVED (create → balance == opening; no stored value);
 *   - a closed account NEVER carries value (force-close posts EXACTLY ONE
 *     zeroing adjustment; the derived balance is EXACTLY 0), reversibly.
 * Plus privacy (owner-stamped, private by default) and the owner-scoped,
 * open-only name-uniqueness rule (a closed name is reusable; two owners may
 * share a name; reopen re-checks the name).
 * ============================================================================
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createDb } from '../src/lib/server/db/client';
import { allStatements } from '../src/lib/server/db/migrate';
import type { Db } from '../src/lib/server/db/client';
import * as schema from '../src/lib/server/db/schema';
import { accountBalance } from '../src/lib/server/db/balances';
import {
	createAccount,
	closeAccount,
	reopenAccount,
	renameAccount,
	setAccountInfo,
	listAccounts,
	setOpeningBalance,
	AccountNameConflictError
} from '../src/lib/server/accounts';
import { accountsVisibleTo } from '../src/lib/server/visibility';
import { seedStarterCategories, BALANCE_ADJUSTMENT_CATEGORY_ID } from '../src/lib/server/seed';
import { kindOf } from '../src/lib/server/categories';
import { readInfoForm, infoDetails, moduleProfile } from '../src/lib/modules';

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
			{ id: 'owner1', username: 'o1', displayName: 'Owner 1', role: 'admin' },
			{ id: 'owner2', username: 'o2', displayName: 'Owner 2', role: 'member' }
		])
		.run();
	return h;
}

describe('accounts: create', () => {
	it('balance equals opening at creation (derived, not stored)', async () => {
		const h = seed();
		const a = await createAccount(h, {
			ownerId: 'owner1',
			type: 'bank',
			name: 'HDFC',
			currency: 'INR',
			openingPaise: 1500_00,
			openingDate: '2024-01-01'
		});
		expect(a.balancePaise).toBe(1500_00);
		expect(accountBalance(h.sqlite, a.id)).toBe(1500_00);
	});

	it('stamps the owner and is private by default (only the owner sees it)', async () => {
		const h = seed();
		const a = await createAccount(h, {
			ownerId: 'owner1',
			type: 'bank',
			name: 'Private',
			currency: 'INR',
			openingPaise: 0,
			openingDate: null
		});
		expect(a.ownerId).toBe('owner1');
		expect(await accountsVisibleTo(h.db, 'owner1')).toContain(a.id);
		expect(await accountsVisibleTo(h.db, 'owner2')).not.toContain(a.id);
	});

	it('a zero opening balance carries no opening date', async () => {
		const h = seed();
		const a = await createAccount(h, {
			ownerId: 'owner1',
			type: 'bank',
			name: 'Zero',
			currency: 'INR',
			openingPaise: 0,
			openingDate: '2024-01-01' // ignored because opening is 0
		});
		expect(a.openingDate).toBeNull();
		expect(a.balancePaise).toBe(0);
	});

	it('a negative opening balance is valid (a liability)', async () => {
		const h = seed();
		const a = await createAccount(h, {
			ownerId: 'owner1',
			type: 'creditCard',
			name: 'Amex',
			currency: 'INR',
			openingPaise: -25000_00,
			openingDate: '2024-02-01'
		});
		expect(a.balancePaise).toBe(-25000_00);
	});

	it('rejects a non-zero opening balance with no opening date', async () => {
		const h = seed();
		await expect(
			createAccount(h, {
				ownerId: 'owner1',
				type: 'bank',
				name: 'NoDate',
				currency: 'INR',
				openingPaise: 100_00,
				openingDate: null
			})
		).rejects.toThrow();
	});

	// MC1/MC3: currency must be one of the supported ISO-4217 codes — the
	// service-layer choke point every creation path (incl. holding onboarding)
	// funnels through, so an unsupported code can never enter the ledger.
	it('accepts a supported foreign currency (USD)', async () => {
		const h = seed();
		const a = await createAccount(h, {
			ownerId: 'owner1',
			type: 'bank',
			name: 'US Brokerage Cash',
			currency: 'USD',
			openingPaise: 1000_00,
			openingDate: '2024-01-01'
		});
		expect(a.currency).toBe('USD');
	});

	it('rejects an unsupported currency code', async () => {
		const h = seed();
		await expect(
			createAccount(h, {
				ownerId: 'owner1',
				type: 'bank',
				name: 'Bad Currency',
				currency: 'ZZZ',
				openingPaise: 0,
				openingDate: null
			})
		).rejects.toThrow(/not a supported currency/);
	});
});

describe('accounts: force-close', () => {
	it('a non-zero account force-closes to EXACTLY 0 with exactly ONE adjustment', async () => {
		const h = seed();
		const a = await createAccount(h, {
			ownerId: 'owner1',
			type: 'bank',
			name: 'ToClose',
			currency: 'INR',
			openingPaise: 4200_00,
			openingDate: '2024-01-01'
		});
		const closed = await closeAccount(h, a.id, { actingUserId: 'owner1' });
		expect(closed.status).toBe('closed');
		expect(accountBalance(h.sqlite, a.id)).toBe(0);

		const live = h.db
			.select()
			.from(schema.transactions)
			.all()
			.filter((t) => t.accountId === a.id && t.deletedAt === null);
		expect(live.length).toBe(1);
		expect(live[0]!.amountPaise).toBe(-4200_00);
		// No seeded taxonomy in this harness → the adjustment degrades to
		// uncategorized (the fallback path).
		expect(live[0]!.categoryId).toBeNull();
	});

	it('stamps the seeded Balance-adjustment category on the closing entry when it exists', async () => {
		const h = seed();
		await seedStarterCategories(h.db);
		const a = await createAccount(h, {
			ownerId: 'owner1',
			type: 'bank',
			name: 'CategorizedClose',
			currency: 'INR',
			openingPaise: 990_00,
			openingDate: '2024-01-01'
		});
		await closeAccount(h, a.id, { actingUserId: 'owner1' });

		const live = h.db
			.select()
			.from(schema.transactions)
			.all()
			.filter((t) => t.accountId === a.id && t.deletedAt === null);
		expect(live.length).toBe(1);
		// Categorized (→ never in the C5 inbox) with the fixed system id, whose
		// group is Neutral (→ excluded from R2/R3 spending & income).
		expect(live[0]!.categoryId).toBe(BALANCE_ADJUSTMENT_CATEGORY_ID);
		expect(await kindOf(h.db, BALANCE_ADJUSTMENT_CATEGORY_ID)).toBe('neutral');
	});

	it('a zero-balance account closes with NO adjustment row', async () => {
		const h = seed();
		const a = await createAccount(h, {
			ownerId: 'owner1',
			type: 'bank',
			name: 'EmptyClose',
			currency: 'INR',
			openingPaise: 0,
			openingDate: null
		});
		const closed = await closeAccount(h, a.id);
		expect(closed.status).toBe('closed');
		const live = h.db
			.select()
			.from(schema.transactions)
			.all()
			.filter((t) => t.accountId === a.id && t.deletedAt === null);
		expect(live.length).toBe(0);
	});
});

describe('accounts: setOpeningBalance (F1 opening-edit surface)', () => {
	it('correcting the opening shifts the derived balance (no row rewrite)', async () => {
		const h = seed();
		const a = await createAccount(h, {
			ownerId: 'owner1',
			type: 'bank',
			name: 'FixOpening',
			currency: 'INR',
			openingPaise: 1000_00,
			openingDate: '2024-01-01'
		});
		const updated = await setOpeningBalance(h, a.id, 1500_00, '2024-01-01');
		expect(updated.openingPaise).toBe(1500_00);
		expect(accountBalance(h.sqlite, a.id)).toBe(1500_00);
	});

	// MC1: currency is immutable after creation. There is no field for it in
	// `setOpeningBalance`'s signature at all — the strongest form of the
	// guarantee (not just "rejected", but "not expressible"). This test locks
	// that shape in: editing the opening never touches currency.
	it('never changes currency (MC1 immutability — not even expressible here)', async () => {
		const h = seed();
		const a = await createAccount(h, {
			ownerId: 'owner1',
			type: 'bank',
			name: 'ImmutableCcy',
			currency: 'USD',
			openingPaise: 1000_00,
			openingDate: '2024-01-01'
		});
		const updated = await setOpeningBalance(h, a.id, 2000_00, '2024-01-02');
		expect(updated.currency).toBe('USD');
	});

	it('setting a zero opening clears the opening date', async () => {
		const h = seed();
		const a = await createAccount(h, {
			ownerId: 'owner1',
			type: 'bank',
			name: 'ZeroOut',
			currency: 'INR',
			openingPaise: 500_00,
			openingDate: '2024-01-01'
		});
		const updated = await setOpeningBalance(h, a.id, 0, '2024-01-01');
		expect(updated.openingPaise).toBe(0);
		expect(updated.openingDate).toBeNull();
	});

	it('rejects a non-zero opening with no date', async () => {
		const h = seed();
		const a = await createAccount(h, {
			ownerId: 'owner1',
			type: 'bank',
			name: 'NeedsDate',
			currency: 'INR',
			openingPaise: 0,
			openingDate: null
		});
		await expect(setOpeningBalance(h, a.id, 100_00, null)).rejects.toThrow();
	});
});

describe('accounts: reopen', () => {
	it('restores open status and keeps all transactions', async () => {
		const h = seed();
		const a = await createAccount(h, {
			ownerId: 'owner1',
			type: 'bank',
			name: 'Roundtrip',
			currency: 'INR',
			openingPaise: 1000_00,
			openingDate: '2024-01-01'
		});
		await closeAccount(h, a.id); // posts one -1000_00 adjustment
		const reopened = await reopenAccount(h, a.id, 'owner1');
		expect(reopened.status).toBe('open');
		// The closing adjustment survives the reopen (history intact) → still 0.
		expect(accountBalance(h.sqlite, a.id)).toBe(0);
		const live = h.db
			.select()
			.from(schema.transactions)
			.all()
			.filter((t) => t.accountId === a.id && t.deletedAt === null);
		expect(live.length).toBe(1);
	});
});

describe('accounts: name uniqueness (owner-scoped, open-only)', () => {
	it('rejects a duplicate open name within the same owner + type', async () => {
		const h = seed();
		await createAccount(h, {
			ownerId: 'owner1',
			type: 'bank',
			name: 'HDFC',
			currency: 'INR',
			openingPaise: 0,
			openingDate: null
		});
		await expect(
			createAccount(h, {
				ownerId: 'owner1',
				type: 'bank',
				name: ' hdfc ', // normalized collision
				currency: 'INR',
				openingPaise: 0,
				openingDate: null
			})
		).rejects.toBeInstanceOf(AccountNameConflictError);
	});

	it("a CLOSED account's name is reusable by a new open account", async () => {
		const h = seed();
		const first = await createAccount(h, {
			ownerId: 'owner1',
			type: 'bank',
			name: 'SBI',
			currency: 'INR',
			openingPaise: 0,
			openingDate: null
		});
		await closeAccount(h, first.id);
		const second = await createAccount(h, {
			ownerId: 'owner1',
			type: 'bank',
			name: 'SBI',
			currency: 'INR',
			openingPaise: 0,
			openingDate: null
		});
		expect(second.id).not.toBe(first.id);
		expect(second.name).toBe('SBI');
	});

	it('two different owners may each have an account with the same name', async () => {
		const h = seed();
		await createAccount(h, {
			ownerId: 'owner1',
			type: 'bank',
			name: 'Shared Name',
			currency: 'INR',
			openingPaise: 0,
			openingDate: null
		});
		const other = await createAccount(h, {
			ownerId: 'owner2',
			type: 'bank',
			name: 'Shared Name',
			currency: 'INR',
			openingPaise: 0,
			openingDate: null
		});
		expect(other.ownerId).toBe('owner2');
	});

	it('reopen throws if the name now collides with a live open account', async () => {
		const h = seed();
		const first = await createAccount(h, {
			ownerId: 'owner1',
			type: 'bank',
			name: 'ICICI',
			currency: 'INR',
			openingPaise: 0,
			openingDate: null
		});
		await closeAccount(h, first.id);
		// A NEW open account grabs the freed name...
		await createAccount(h, {
			ownerId: 'owner1',
			type: 'bank',
			name: 'ICICI',
			currency: 'INR',
			openingPaise: 0,
			openingDate: null
		});
		// ...so reopening the original must be refused.
		await expect(reopenAccount(h, first.id, 'owner1')).rejects.toBeInstanceOf(AccountNameConflictError);
	});
});

describe('accounts: rename (UX-REVIEW P7)', () => {
	const bank = (h: Db, name: string) =>
		createAccount(h, { ownerId: 'owner1', type: 'bank', name, currency: 'INR', openingPaise: 0, openingDate: null });

	it('renames, trimming the name', async () => {
		const h = seed();
		const a = await bank(h, 'HDFC Savngs');
		const r = await renameAccount(h, a.id, '  HDFC Savings ', 'owner1');
		expect(r.name).toBe('HDFC Savings');
	});

	it('refuses a name another open account of the same owner and module has', async () => {
		const h = seed();
		await bank(h, 'ICICI');
		const b = await bank(h, 'Axis');
		await expect(renameAccount(h, b.id, 'icici', 'owner1')).rejects.toBeInstanceOf(AccountNameConflictError);
		expect((await listAccounts(h, 'owner1')).map((x) => x.name).sort()).toEqual(['Axis', 'ICICI']);
	});

	it('allows the name of a closed account, and a change of case on itself', async () => {
		const h = seed();
		const old = await bank(h, 'SBI');
		await closeAccount(h, old.id);
		const b = await bank(h, 'Kotak');
		expect((await renameAccount(h, b.id, 'SBI', 'owner1')).name).toBe('SBI');
		expect((await renameAccount(h, b.id, 'sbi', 'owner1')).name).toBe('sbi');
	});

	it('refuses a blank name', async () => {
		const h = seed();
		const a = await bank(h, 'Yes Bank');
		await expect(renameAccount(h, a.id, '   ', 'owner1')).rejects.toThrow(/name is required/);
	});
});

describe('accounts: listAccounts (viewer-scoped)', () => {
	it('open-only by default; includeClosed adds the closed set; other owners excluded', async () => {
		const h = seed();
		const open1 = await createAccount(h, {
			ownerId: 'owner1',
			type: 'bank',
			name: 'Open 1',
			currency: 'INR',
			openingPaise: 0,
			openingDate: null
		});
		const toClose = await createAccount(h, {
			ownerId: 'owner1',
			type: 'bank',
			name: 'Closed 1',
			currency: 'INR',
			openingPaise: 0,
			openingDate: null
		});
		await closeAccount(h, toClose.id);
		await createAccount(h, {
			ownerId: 'owner2',
			type: 'bank',
			name: 'Owner2 acct',
			currency: 'INR',
			openingPaise: 0,
			openingDate: null
		});

		const openOnly = await listAccounts(h, 'owner1');
		expect(openOnly.map((a) => a.id)).toEqual([open1.id]);

		const withClosed = await listAccounts(h, 'owner1', { includeClosed: true });
		expect(new Set(withClosed.map((a) => a.id))).toEqual(new Set([open1.id, toClose.id]));
	});
});

describe('account details (S5 RD8)', () => {
	const fd = moduleProfile('fd')!;
	const form = (entries: Record<string, string>) => {
		const f = new FormData();
		for (const [k, v] of Object.entries(entries)) f.set(k, v);
		return f;
	};

	it('reads the filled fields, drops blanks and checks dates', () => {
		expect(readInfoForm(fd, form({ info_rate: ' 7.1 ', info_maturity: '2027-03-14', info_payout: '' }))).toEqual({
			infoJson: JSON.stringify({ rate: '7.1', maturity: '2027-03-14' })
		});
		expect(readInfoForm(fd, form({}))).toEqual({ infoJson: null });
		expect(readInfoForm(fd, form({ info_maturity: '14/03/2027' }))).toEqual({
			errors: { info_maturity: 'Enter a valid date' }
		});
	});

	it('lists only the filled ones, in the profile order, labels without their unit', () => {
		const d = infoDetails('fd', JSON.stringify({ maturity: '2027-03-14', rate: '7.1' }));
		expect(d.map((x) => [x.label, x.value, x.percent])).toEqual([
			['Interest rate', '7.1', true],
			['Maturity date', '2027-03-14', false]
		]);
		// A choice shows its value alone ("Payout", not "Payout Payout").
		expect(infoDetails('fd', JSON.stringify({ rate: '7.1', payout: 'Payout' })).map((x) => [x.label, x.showLabel])).toEqual([
			['Interest rate', true],
			['Payout', false]
		]);
		expect(infoDetails('fd', null)).toEqual([]);
		expect(infoDetails('fd', 'not json')).toEqual([]);
		expect(infoDetails('bank', JSON.stringify({ rate: '3' }))).toEqual([]); // a bank has no details
	});

	it('Edit account replaces the details and clears them with null', async () => {
		const h = seed();
		const a = await createAccount(h, { ownerId: 'owner1', type: 'otherAsset', name: 'Plot', currency: 'INR', openingPaise: 0, openingDate: null });
		await setAccountInfo(h, a.id, JSON.stringify({ note: 'joint with mum' }));
		expect((await listAccounts(h, 'owner1'))[0]!.infoJson).toBe(JSON.stringify({ note: 'joint with mum' }));
		await setAccountInfo(h, a.id, null);
		expect((await listAccounts(h, 'owner1'))[0]!.infoJson).toBe(null);
		await expect(setAccountInfo(h, 'nope', null)).rejects.toThrow(/no account/);
	});
});

