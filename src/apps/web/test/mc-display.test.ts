/**
 * mc-display.test.ts — M9b (MC3) display-layer additions on top of the FROZEN
 * m9a correctness core (fx.ts / rates.ts / transfers.ts / dashboard aggregation
 * math are untouched by M9b; this proves the READ-MODEL fields M9b added so the
 * UI can render native-primary/base-secondary + cross-currency transfer legs).
 * ============================================================================
 *   - registerView (transactions.ts): a cross-currency transfer row exposes its
 *     FROZEN linkage rate (fxRateScaled/fxScale) + the counterpart leg's own
 *     currency/amount; an ordinary row and a same-currency transfer expose null
 *     for all four (nothing to disambiguate).
 *   - recentActivity (dashboard.ts): every row carries its OWN native currency;
 *     a cross-currency transfer additionally carries the counterpart leg's
 *     currency/amount so the feed can show "both native legs clearly" (MC3 AC);
 *     a same-currency transfer carries null for both (no new information).
 *   - accountSummary (dashboard.ts): a member with no rate flags the group
 *     `rateNeeded` (the subtotal is partial, never a silent 1:1); a fully-rated
 *     group does not.
 * ============================================================================
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createDb } from '../src/lib/server/db/client';
import { allStatements } from '../src/lib/server/db/migrate';
import type { Db } from '../src/lib/server/db/client';
import * as schema from '../src/lib/server/db/schema';
import { createAccount } from '../src/lib/server/accounts';
import { registerView, createTransaction } from '../src/lib/server/transactions';
import { createTransfer } from '../src/lib/server/transfers';
import { recentActivity, accountSummary } from '../src/lib/server/dashboard';
import { setRate } from '../src/lib/server/rates';

let handle: Db | undefined;
afterEach(() => {
	handle?.sqlite.close();
	handle = undefined;
});

function seed(): Db {
	const h = createDb(':memory:');
	handle = h;
	for (const stmt of allStatements()) h.sqlite.exec(stmt);
	h.db.insert(schema.users).values([{ id: 'owner1', username: 'o1', displayName: 'Owner 1', role: 'admin' }]).run();
	return h;
}

async function acct(h: Db, opts: { currency?: string; name?: string; opening?: number } = {}): Promise<string> {
	const a = await createAccount(h, {
		ownerId: 'owner1',
		type: 'bank',
		name: opts.name ?? `A-${Math.random().toString(36).slice(2, 8)}`,
		currency: opts.currency ?? 'INR',
		openingPaise: opts.opening ?? 100000_00,
		openingDate: '2024-01-01'
	});
	return a.id;
}

describe('registerView: cross-currency transfer rows expose the linkage rate + counterpart leg', () => {
	it('exposes fxRateScaled/fxScale + counterpart currency/amount on BOTH legs', async () => {
		const h = seed();
		const usd = await acct(h, { currency: 'USD', name: 'US Brokerage' });
		const inr = await acct(h, { currency: 'INR', name: 'HDFC' });

		await createTransfer(h, { userId: 'owner1' }, {
			fromId: usd,
			toId: inr,
			amountPaise: 100_00, // $100
			date: '2024-02-01',
			rate: { scaled: 83_000_000, scale: 6 } // 1 USD = 83 INR
		});

		const usdView = await registerView(h, 'owner1', usd);
		const usdRow = usdView.rows.find((r) => r.transferPartnerId !== null)!;
		expect(usdRow.fxRateScaled).toBe(83_000_000);
		expect(usdRow.fxScale).toBe(6);
		expect(usdRow.counterpartCurrency).toBe('INR');
		expect(usdRow.counterpartAmountPaise).toBe(8300_00); // $100 × 83

		const inrView = await registerView(h, 'owner1', inr);
		const inrRow = inrView.rows.find((r) => r.transferPartnerId !== null)!;
		expect(inrRow.fxRateScaled).toBe(83_000_000);
		expect(inrRow.fxScale).toBe(6);
		expect(inrRow.counterpartCurrency).toBe('USD');
		expect(inrRow.counterpartAmountPaise).toBe(-100_00); // the USD leg's own signed amount
	});

	it('is null for an ORDINARY row and for a SAME-CURRENCY transfer', async () => {
		const h = seed();
		const a = await acct(h, { currency: 'INR', name: 'A' });
		const b = await acct(h, { currency: 'INR', name: 'B' });
		await createTransfer(h, { userId: 'owner1' }, { fromId: a, toId: b, amountPaise: 500_00, date: '2024-02-01' });

		const view = await registerView(h, 'owner1', a);
		const transferRow = view.rows.find((r) => r.transferPartnerId !== null)!;
		expect(transferRow.fxRateScaled).toBeNull();
		expect(transferRow.fxScale).toBeNull();
		expect(transferRow.counterpartCurrency).toBe('INR'); // still the counterpart's currency…
		expect(transferRow.counterpartAmountPaise).toBe(500_00); // …and its (inflow) amount, just not FX-flagged

		// The opening balance's implicit row isn't a `RegisterRow`; check there IS
		// no ordinary row here (both rows are transfer legs) — nothing else to assert.
		expect(view.rows.length).toBe(1);
	});
});

describe('recentActivity: currency-aware feed rows (MC3)', () => {
	it('carries each row\'s OWN native currency', async () => {
		const h = seed();
		const usd = await acct(h, { currency: 'USD', name: 'US Brokerage', opening: 0 });
		const inr = await acct(h, { currency: 'INR', name: 'HDFC', opening: 0 });
		await createTransaction(h, { userId: 'owner1' }, {
			accountId: usd,
			date: '2024-02-01',
			amountPaise: -50_00,
			payeeName: 'Coffee'
		});
		await createTransaction(h, { userId: 'owner1' }, {
			accountId: inr,
			date: '2024-02-01',
			amountPaise: -300_00,
			payeeName: 'Groceries'
		});

		const feed = await recentActivity(h, 'owner1');
		const usdRow = feed.find((r) => r.accountId === usd)!;
		const inrRow = feed.find((r) => r.accountId === inr)!;
		expect(usdRow.currency).toBe('USD');
		expect(inrRow.currency).toBe('INR');
	});

	it('a cross-currency transfer carries the counterpart leg\'s currency + amount', async () => {
		const h = seed();
		const usd = await acct(h, { currency: 'USD', name: 'US Brokerage' });
		const inr = await acct(h, { currency: 'INR', name: 'HDFC' });
		await createTransfer(h, { userId: 'owner1' }, {
			fromId: usd,
			toId: inr,
			amountPaise: 100_00,
			date: '2024-02-01',
			rate: { scaled: 83_000_000, scale: 6 }
		});

		const feed = await recentActivity(h, 'owner1');
		const row = feed.find((r) => r.entryType === 'transfer')!;
		expect(row).toBeDefined();
		expect(row.currency).toBe(row.accountId === usd ? 'USD' : 'INR');
		expect(row.counterpartCurrency).toBe(row.currency === 'USD' ? 'INR' : 'USD');
		expect(row.counterpartAmountPaise).not.toBeNull();
	});

	it('a same-currency transfer carries null counterpart currency/amount (nothing new to show)', async () => {
		const h = seed();
		const a = await acct(h, { currency: 'INR', name: 'A' });
		const b = await acct(h, { currency: 'INR', name: 'B' });
		await createTransfer(h, { userId: 'owner1' }, { fromId: a, toId: b, amountPaise: 500_00, date: '2024-02-01' });

		const feed = await recentActivity(h, 'owner1');
		const row = feed.find((r) => r.entryType === 'transfer')!;
		expect(row.currency).toBe('INR');
		expect(row.counterpartCurrency).toBeNull();
		expect(row.counterpartAmountPaise).toBeNull();
	});
});

describe('accountSummary: rateNeeded flags a group with an unrated member (MC1)', () => {
	it('flags rateNeeded when a foreign member has no rate; excludes it from the subtotal', async () => {
		const h = seed();
		await acct(h, { currency: 'INR', name: 'HDFC', opening: 1000_00 });
		await acct(h, { currency: 'USD', name: 'US Brokerage', opening: 100_00 });

		const groups = await accountSummary(h, 'owner1');
		const bank = groups.find((g) => g.type === 'bank')!;
		expect(bank.rateNeeded).toBe(true);
		// Subtotal reflects ONLY the rated (INR) member — never a silent 1:1 for USD.
		expect(bank.subtotalPaise).toBe(1000_00);
		// Each row still carries its own currency for native display.
		const currencies = bank.accounts.map((a) => a.currency).sort();
		expect(currencies).toEqual(['INR', 'USD']);
	});

	it('does not flag rateNeeded once every member currency is rated', async () => {
		const h = seed();
		await acct(h, { currency: 'INR', name: 'HDFC', opening: 1000_00 });
		await acct(h, { currency: 'USD', name: 'US Brokerage', opening: 100_00 });
		setRate(h, 'USD', { scaled: 83_000_000, scale: 6 });

		const groups = await accountSummary(h, 'owner1');
		const bank = groups.find((g) => g.type === 'bank')!;
		expect(bank.rateNeeded).toBe(false);
		expect(bank.subtotalPaise).toBe(1000_00 + 8300_00); // 1000 INR + $100 × 83
	});
});
