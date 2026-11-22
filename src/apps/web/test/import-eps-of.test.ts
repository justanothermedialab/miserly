/**
 * import-eps-of.test.ts: the Actual import's "EPS of …" (F4 RD9, O25).
 * ============================================================================
 * Actual keeps an EPF and its EPS as two off-budget accounts. "Add as" offers "EPS of <EPF>" for each
 * EPF the person will have once the import lands (one already here, or an Actual account set to EPF
 * in this preview); the Actual account's rows then go into that EPF's EPS (the child account,
 * `parent_account_id`), never a new account. A re-import matches by Actual's ids; Undo returns the
 * file to before. "Today" is pinned to 2026-11-19.
 * ============================================================================
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { createDb } from '../src/lib/server/db/client';
import { allStatements } from '../src/lib/server/db/migrate';
import type { Db } from '../src/lib/server/db/client';
import * as schema from '../src/lib/server/db/schema';
import { accountBalance } from '../src/lib/server/db/balances';
import { createAccount, createChildAccount } from '../src/lib/server/accounts';
import { createTransaction } from '../src/lib/server/transactions';
import { seedStarterCategories } from '../src/lib/server/seed';
import type { ActualBudget, ActualRow } from '../src/lib/server/import/actual-read';
import {
	previewImport,
	runImport,
	defaultChoices,
	undoImport,
	ImportRefusedError,
	type ImportChoices,
	type ImportPreview
} from '../src/lib/server/import/actual-import';
import { epsOfKey, epsOfOptions, unresolvedAddAs } from '../src/lib/import-eps';

let h: Db;
beforeEach(async () => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(new Date('2026-11-19T06:00:00Z'));
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
const live = () => h.db.select().from(schema.accounts).where(isNull(schema.accounts.deletedAt)).all();
const named = (name: string) => live().find((a) => a.name === name);
const rowsOf = (accountId: string) =>
	h.db.select().from(schema.transactions).where(and(eq(schema.transactions.accountId, accountId), isNull(schema.transactions.deletedAt))).all();

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

/** The owner's shape: a salary account, an EPF and its EPS kept as two off-budget accounts. */
const file = abudget({
	accounts: [acct('a-hdfc', 'HDFC'), acct('a-epf', 'EPF', true), acct('a-eps', 'EPS', true)],
	rows: [
		arow({ id: 'h0', accountId: 'a-hdfc', date: '2026-01-01', amount: L(50_000), starting: true }),
		arow({ id: 'f0', accountId: 'a-epf', date: '2026-01-01', amount: L(3_00_000), starting: true }),
		arow({ id: 'f1', accountId: 'a-epf', date: '2026-02-01', amount: L(10_000) }),
		arow({ id: 's0', accountId: 'a-eps', date: '2026-01-01', amount: L(80_000), starting: true }),
		arow({ id: 's1', accountId: 'a-eps', date: '2026-02-01', amount: L(1_250) }),
		arow({ id: 's2', accountId: 'a-eps', date: '2026-03-01', amount: L(1_250) })
	]
});

const choicesOf = (p: ImportPreview, edit: (c: ImportChoices) => ImportChoices = (c) => c) => edit(defaultChoices(p));
const importFile = async (budget: ActualBudget, edit?: (c: ImportChoices) => ImportChoices) =>
	runImport(h, 'alice', budget, 'test.zip', choicesOf(previewImport(h, 'alice', budget), edit));
const withAddAs = (id: string, addAs: string) => (c: ImportChoices): ImportChoices => ({
	...c,
	accounts: { ...c.accounts, [id]: { ...c.accounts[id]!, addAs } }
});

async function epfHere(owner: string, name: string, eps: 'empty' | 'none' | 'paid' = 'empty') {
	const epf = await createAccount(h, { ownerId: owner, type: 'epf', name, currency: 'INR', openingPaise: L(1_00_000), openingDate: '2025-04-01' });
	if (eps !== 'none') await createChildAccount(h, epf.id, eps === 'paid' ? L(5_000) : 0, '2025-04-01');
	return epf;
}

describe('the guess and the options (O25)', () => {
	it('guesses "EPS of" the one EPF in the file for an off-budget account named EPS', async () => {
		const p = previewImport(h, 'alice', file);
		const eps = p.accounts.find((a) => a.actualId === 'a-eps')!;
		expect(eps.addAs).toBe(epsOfKey({ actual: 'a-epf' }));
		expect(p.accounts.find((a) => a.actualId === 'a-epf')!.addAs).toBe('epf:0');
		// The default choice files its plain deposits as money put in, as an EPF's (Salary).
		expect(defaultChoices(p).accounts['a-eps']!.deposits).toBe('moneyIn');
	});

	it('does not guess when the file has two EPFs', async () => {
		const two = abudget({ ...file, accounts: [...file.accounts, acct('a-epf2', 'Old employer EPF', true)] });
		expect(previewImport(h, 'alice', two).accounts.find((a) => a.actualId === 'a-eps')!.addAs).toBe('otherAsset:0');
	});

	it("lists the person's open EPFs here, never another member's", async () => {
		const mine = await epfHere('alice', 'Infosys EPF');
		await epfHere('bob', 'Bob EPF');
		const p = previewImport(h, 'alice', file);
		expect(p.epfsHere).toEqual([{ id: mine.id, name: 'Infosys EPF' }]);
	});

	it('offers one "EPS of" per EPF that will be here: those here and those set to EPF in the preview', async () => {
		const mine = await epfHere('alice', 'Infosys EPF');
		const p = previewImport(h, 'alice', file);
		const c = defaultChoices(p).accounts;
		const opts = epsOfOptions(p, c);
		expect(opts.map((o) => [o.key, o.label])).toEqual([
			[epsOfKey({ here: mine.id }), 'EPS of Infosys EPF'],
			[epsOfKey({ actual: 'a-epf' }), 'EPS of EPF']
		]);
		expect(opts.every((o) => o.type === 'eps' && o.holding && o.assetHolding && o.depositsMoneyIn)).toBe(true);
		// The EPF set to something else, or unticked: its "EPS of" goes, and the EPS's pick is unresolved.
		const off = { ...c, 'a-epf': { ...c['a-epf']!, include: false } };
		expect(epsOfOptions(p, off).map((o) => o.key)).toEqual([epsOfKey({ here: mine.id })]);
		expect(unresolvedAddAs(p, off)).toEqual(['a-eps']);
		expect(unresolvedAddAs(p, c)).toEqual([]);
	});
});

describe('importing an EPS into its EPF (O25)', () => {
	it("brings the EPS's rows into the new EPF's EPS, never a new account", async () => {
		const r = await importFile(file);
		const epf = named('EPF')!;
		const eps = live().filter((a) => a.parentAccountId === epf.id);
		expect(eps).toHaveLength(1);
		expect(eps[0]!).toMatchObject({ type: 'eps', name: 'EPS of EPF', openingPaise: L(80_000), openingDate: '2026-01-01' });
		expect(named('EPS')).toBeUndefined();
		expect(r.accounts).toBe(2); // HDFC and EPF; the EPS came with its EPF
		expect(rowsOf(eps[0]!.id)).toHaveLength(2);
		expect(accountBalance(h.sqlite, eps[0]!.id)).toBe(L(82_500));
		// Money put in, under Salary, as an EPF's plain deposits.
		const salary = h.db.select().from(schema.categories).where(eq(schema.categories.name, 'Salary')).get()!;
		expect(rowsOf(eps[0]!.id).every((x) => x.categoryId === salary.id)).toBe(true);
	});

	it('a re-import matches by Actual ids: the EPS is already here, nothing is added', async () => {
		await importFile(file);
		const p = previewImport(h, 'alice', file);
		const eps = p.accounts.find((a) => a.actualId === 'a-eps')!;
		expect(eps.existing).toMatchObject({ name: 'EPS of EPF', type: 'eps' });
		expect(eps.rows).toBe(0);
		const before = live().length;
		const again = await importFile(file);
		expect(again).toMatchObject({ accounts: 0, transactions: 0 });
		expect(live()).toHaveLength(before);
		// A newer export's new EPS row lands in the same EPS.
		const newer = abudget({ ...file, rows: [...file.rows, arow({ id: 's3', accountId: 'a-eps', date: '2026-04-01', amount: L(1_250) })] });
		expect((await importFile(newer)).transactions).toBe(1);
		expect(accountBalance(h.sqlite, live().find((a) => a.type === 'eps')!.id)).toBe(L(83_750));
	});

	it('into an EPF already here: its empty EPS gets the opening and the rows; Undo empties it again', async () => {
		const mine = await epfHere('alice', 'Infosys EPF');
		const eps = live().find((a) => a.parentAccountId === mine.id)!;
		const only = abudget({ ...file, accounts: [file.accounts[2]!], rows: file.rows.filter((r) => r.accountId === 'a-eps') });
		const r = await importFile(only, withAddAs('a-eps', epsOfKey({ here: mine.id })));
		expect(r.accounts).toBe(0);
		expect(live().filter((a) => a.type === 'eps')).toHaveLength(1);
		expect(h.db.select().from(schema.accounts).where(eq(schema.accounts.id, eps.id)).get()).toMatchObject({ openingPaise: L(80_000), openingDate: '2026-01-01' });
		expect(accountBalance(h.sqlite, eps.id)).toBe(L(82_500));

		undoImport(h, 'alice', r.importId);
		expect(h.db.select().from(schema.accounts).where(eq(schema.accounts.id, eps.id)).get()).toMatchObject({ openingPaise: 0, openingDate: null, deletedAt: null });
		expect(rowsOf(eps.id)).toHaveLength(0);
	});

	it('into an EPF here made before its EPS existed: the EPS is made with it, and Undo removes it', async () => {
		const old = await epfHere('alice', 'Old EPF', 'none');
		const only = abudget({ ...file, accounts: [file.accounts[2]!], rows: file.rows.filter((r) => r.accountId === 'a-eps') });
		const r = await importFile(only, withAddAs('a-eps', epsOfKey({ here: old.id })));
		const eps = live().filter((a) => a.parentAccountId === old.id);
		expect(eps).toHaveLength(1);
		expect(eps[0]!).toMatchObject({ type: 'eps', name: 'EPS of Old EPF', ownerId: 'alice', openingPaise: L(80_000) });
		undoImport(h, 'alice', r.importId);
		expect(live().filter((a) => a.parentAccountId === old.id)).toHaveLength(0);
		expect(named('Old EPF')).toBeDefined();
	});

	it('refuses an EPS that already has money in it, nothing written', async () => {
		const mine = await epfHere('alice', 'Infosys EPF', 'paid');
		const before = live().length;
		await expect(importFile(file, withAddAs('a-eps', epsOfKey({ here: mine.id })))).rejects.toThrow(ImportRefusedError);
		await expect(importFile(file, withAddAs('a-eps', epsOfKey({ here: mine.id })))).rejects.toThrow(
			'The EPS of Infosys EPF already has money in it. Add EPS as its own account, or untick it.'
		);
		expect(live()).toHaveLength(before);
	});

	it("refuses another member's EPF, an EPF left unticked, and two accounts into one EPS", async () => {
		const bobs = await epfHere('bob', 'Bob EPF');
		await expect(importFile(file, withAddAs('a-eps', epsOfKey({ here: bobs.id })))).rejects.toThrow('Choose what EPS is added as.');
		await expect(
			importFile(file, (c) => ({ ...c, accounts: { ...c.accounts, 'a-epf': { ...c.accounts['a-epf']!, include: false } } }))
		).rejects.toThrow('Tick EPF too, or choose another EPF for EPS.');
		const two = abudget({
			...file,
			accounts: [...file.accounts, acct('a-eps2', 'Pension', true)],
			rows: [...file.rows, arow({ id: 'p0', accountId: 'a-eps2', date: '2026-01-01', amount: L(1_000), starting: true })]
		});
		await expect(importFile(two, withAddAs('a-eps2', epsOfKey({ actual: 'a-epf' })))).rejects.toThrow(
			'EPS and Pension both go into the EPS of EPF. Choose one.'
		);
		expect(live().filter((a) => a.ownerId === 'alice')).toHaveLength(0);
	});

	it('a typed EPS row after the import stays when Undo runs on an EPS it did not make', async () => {
		const mine = await epfHere('alice', 'Infosys EPF');
		const eps = live().find((a) => a.parentAccountId === mine.id)!;
		const only = abudget({ ...file, accounts: [file.accounts[2]!], rows: file.rows.filter((r) => r.accountId === 'a-eps') });
		const r = await importFile(only, withAddAs('a-eps', epsOfKey({ here: mine.id })));
		await createTransaction(h, { userId: 'alice' }, { accountId: eps.id, date: '2026-05-01', amountPaise: L(1_250) });
		undoImport(h, 'alice', r.importId);
		expect(rowsOf(eps.id)).toHaveLength(1);
	});
});
