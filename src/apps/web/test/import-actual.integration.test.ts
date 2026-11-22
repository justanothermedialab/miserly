/**
 * import-actual.integration.test.ts — F4: Actual Budget's export comes in on the
 * sample file (`test/fixtures/Sample-budget-export.zip`, made with Actual's own
 * API): every balance equals Actual's (net worth −₹11,34,105.50), transfers paired, the split as its
 * parts, the adjustment a value update, plain deposits per holding (EPF money put in, PPF return),
 * re-import adds nothing, Undo returns the file to before; and each refusal.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { and, eq, isNull } from 'drizzle-orm';
import { formatDate, today, systemClock, parseDate } from '@miserly/core';
import type { AuthedUser } from '../src/lib/server/auth/session';
import { makeZip } from './fixtures/make-zip';
import { readZipExactly } from '../src/lib/server/import/zip';

const DB_PATH = path.join(os.tmpdir(), `miserly-import-${randomUUID()}.db`);
process.env.MISERLY_DB_PATH = DB_PATH;

import { getDb } from '../src/lib/server/db/instance';
import * as schema from '../src/lib/server/db/schema';
import { createAdmin, createMember } from '../src/lib/server/auth/users';
import { seedStarterCategories } from '../src/lib/server/seed';
import { accountBalance } from '../src/lib/server/db/balances';
import { createAccount } from '../src/lib/server/accounts';
import { createTransaction } from '../src/lib/server/transactions';
import { shareAccount, unshareAccount } from '../src/lib/server/sharing';
import { dashboardSummary, holdingMetrics } from '../src/lib/server/dashboard';
import { actions as settingsActions, load as settingsLoad } from '../src/routes/settings/+page.server';
import { readActualExport, ActualFileError, type ActualBudget } from '../src/lib/server/import/actual-read';
import {
	previewImport,
	runImport,
	defaultChoices,
	undoImport,
	undoCheck,
	listImports,
	ImportRefusedError,
	type ImportChoices
} from '../src/lib/server/import/actual-import';

const SAMPLE = path.resolve(__dirname, 'fixtures/Sample-budget-export.zip');
const TODAY = formatDate(today(systemClock()));
const TOMORROW = formatDate(parseDate(TODAY).add({ days: 1 }));

let alice: AuthedUser;
let bob: AuthedUser;
let budget: ActualBudget;

beforeAll(async () => {
	const { db } = getDb();
	alice = await createAdmin(db, { username: 'alice', displayName: 'Alice', password: 'alice-password-123' });
	bob = await createMember(db, { username: 'bob', displayName: 'Bob', tempPassword: 'bob-password-123' });
	await seedStarterCategories(db);
	budget = readActualExport(fs.readFileSync(SAMPLE));
});
afterAll(() => {
	getDb().sqlite.close();
	for (const suffix of ['', '-wal', '-shm']) fs.rmSync(DB_PATH + suffix, { force: true });
});

const accountsOf = (userId: string) =>
	getDb().db.select().from(schema.accounts).where(and(eq(schema.accounts.ownerId, userId), isNull(schema.accounts.deletedAt))).all();
const byName = (name: string) => accountsOf(alice.id).find((a) => a.name === name)!;
const rowsOf = (accountId: string) =>
	getDb().db.select().from(schema.transactions).where(and(eq(schema.transactions.accountId, accountId), isNull(schema.transactions.deletedAt))).all();
const count = (table: string) => (getDb().sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
const snapshot = () => ({
	accounts: count('accounts'),
	transactions: count('transactions'),
	groups: count('category_groups'),
	categories: count('categories'),
	payees: count('payees'),
	accountPayee: count('account_payee'),
	userPayee: count('user_payee')
});
/** Actual's balance per account name (the sum of its rows). */
const actualBalances = () =>
	new Map(budget.accounts.map((a) => [a.name, budget.rows.filter((r) => r.accountId === a.id).reduce((s, r) => s + r.amount, 0)]));

/** A changed copy of the sample, as a zip (the database edited in memory, then serialised). */
function changedSample(edit: (db: Database.Database) => void): Buffer {
	const zip = fs.readFileSync(SAMPLE);
	const db = new Database(readZipEntryRaw(zip));
	edit(db);
	const bytes = db.serialize();
	db.close();
	return makeZip([
		{ name: 'db.sqlite', data: bytes },
		{ name: 'metadata.json', data: Buffer.from('{"id":"changed","budgetName":"Changed"}') }
	]);
}
function readZipEntryRaw(zip: Buffer): Buffer {
	return readZipExactly(zip, { 'db.sqlite': 10_000_000, 'metadata.json': 65_536 }, 'x').get('db.sqlite')!;
}

describe('reading the file (F4)', () => {
	it("reads Actual's export: ten accounts, 273 live rows (the split's parent left out), one deleted", async () => {
		expect(budget.accounts.map((a) => a.name)).toEqual([
			'HDFC Salary', 'ICICI Savings', 'HDFC Regalia Card', 'Cash', 'Axis Old Savings',
			'Kuvera MF', 'PPF (SBI)', 'EPF', 'SGB 2023 Series III', 'SBI Home Loan'
		]);
		expect(budget.rows).toHaveLength(273);
		expect(budget.splits).toBe(1);
		expect(budget.deletedRows).toBe(1);
		expect(budget.rows.filter((r) => r.starting)).toHaveLength(10);
		expect(budget.rows.filter((r) => r.adjustment)).toHaveLength(1);
	});

	it('refuses a zip that is not an Actual export, in plain words', async () => {
		const other = makeZip([
			{ name: 'db.sqlite', data: Buffer.from('not sqlite') },
			{ name: 'metadata.json', data: Buffer.from('{}') }
		]);
		expect(() => readActualExport(other)).toThrow(ActualFileError);
		expect(() => readActualExport(other)).toThrow("This zip isn't Actual Budget's export");
		// An older Actual: its transactions table lacks a column read (the file's views are not read).
		const old = changedSample((db) =>
			db.exec('DROP VIEW v_transactions; DROP VIEW v_transactions_internal_alive; DROP VIEW v_transactions_internal; ALTER TABLE transactions DROP COLUMN transferred_id')
		);
		expect(() => readActualExport(old)).toThrow("This export is from a version of Actual that Miserly can't read");
	});
});

describe('the preview (F4, choice 4 I-C)', () => {
	it('guesses each type, shows Invested and Value, and plain deposits by type', async () => {
		const p = previewImport(getDb(), alice.id, budget);
		const a = new Map(p.accounts.map((x) => [x.name, x]));
		expect([...a.values()].map((x) => x.addAs)).toEqual([
			'bank:0', 'bank:0', 'creditCard:0', 'bank:0', 'bank:0', 'mutualFunds:0', 'ppf:0', 'epf:0', 'sgb:0', 'loan:0'
		]);
		expect(p.options.find((o) => o.key === 'loan:0')!.label).toBe('Home loan');
		expect(a.get('Axis Old Savings')!.inActual).toBe('Closed');
		expect(a.get('Kuvera MF')).toMatchObject({ investedIfReturn: 790000_00, balancePaise: 848230_00, plainDeposits: 0 });
		expect(a.get('PPF (SBI)')).toMatchObject({ investedIfReturn: 560000_00, balancePaise: 588700_00, plainDeposits: 1 });
		expect(a.get('EPF')).toMatchObject({ investedIfMoneyIn: 1007830_00, balancePaise: 1007830_00, plainDeposits: 6 });
		expect(p.options.find((o) => o.key === 'epf:0')!.depositsMoneyIn).toBe(true);
		expect(p.accounts.reduce((s, x) => s + x.rows, 0)).toBe(263);
		expect(p.transferGroups.map((g) => g.name)).toEqual(['Savings']);
		expect([...p.transferGroups[0]!.holdings].sort()).toEqual(['Kuvera MF', 'PPF (SBI)', 'SBI Home Loan']);
		// Its EMI goes into a loan, not a holding, so it keeps Spending by default (O23).
		expect(p.transferGroups[0]!.defaultKind).toBe('spending');
		expect(p).toMatchObject({ categories: 22, groups: 8, deletedRows: 1, from: '2026-03-31', to: '2026-10-31', alreadyHere: false });
	});
});

describe('the import (F4)', () => {
	let before: ReturnType<typeof snapshot>;
	let importId: string;

	it('a name clash is refused and nothing is written', async () => {
		const clash = await createAccount(getDb(), { ownerId: alice.id, type: 'bank', name: 'Cash', currency: 'INR', openingPaise: 0, openingDate: null });
		const p = previewImport(getDb(), alice.id, budget);
		expect(p.takenNames.bank).toContain('cash');
		const s = snapshot();
		await expect(runImport(getDb(), alice.id, budget, 'sample.zip', defaultChoices(p))).rejects.toThrow(ImportRefusedError);
		await expect(runImport(getDb(), alice.id, budget, 'sample.zip', defaultChoices(p))).rejects.toThrow('You already have an open Bank account named Cash. Rename it in the list.');
		expect(snapshot()).toEqual(s);
		getDb().sqlite.prepare('DELETE FROM accounts WHERE id = ?').run(clash.id);
	});

	it('brings every account in at Actual’s balance: net worth −₹11,34,105.50', async () => {
		before = snapshot();
		const p = previewImport(getDb(), alice.id, budget);
		const choices: ImportChoices = { ...defaultChoices(p), groupKinds: { [p.transferGroups[0]!.actualId]: 'investments' } };
		const result = await runImport(getDb(), alice.id, budget, '2026-11-05-Sample budget.zip', choices);
		importId = result.importId;
		expect(result).toMatchObject({ accounts: 10, transactions: 263 });

		const expected = actualBalances();
		for (const a of accountsOf(alice.id)) expect([a.name, accountBalance(getDb().sqlite, a.id)]).toEqual([a.name, expected.get(a.name) ?? 0]);
		const s = await dashboardSummary(getDb(), alice.id);
		expect(s.netWorthPaise).toBe(-1134105_50);
	});

	it('types, openings and closing follow the file and the service rules', async () => {
		expect(byName('HDFC Regalia Card').type).toBe('creditCard');
		expect(byName('SBI Home Loan')).toMatchObject({ type: 'loan', infoJson: JSON.stringify({ kind: 'Home loan' }) });
		// The opening date is the earliest row: the PPF's interest of 31 Mar sits before its 1 May start.
		expect(byName('PPF (SBI)')).toMatchObject({ type: 'ppf', openingPaise: 410000_00, openingDate: '2026-03-31' });
		expect(byName('Axis Old Savings').status).toBe('closed');
		// S5 RD16: the EPF comes with its EPS (empty), so its page has the EPF | EPS tabs.
		expect(byName('EPS of EPF')).toMatchObject({ type: 'eps', parentAccountId: byName('EPF').id, openingPaise: 0, status: 'open' });
		expect(accountsOf(alice.id).filter((a) => a.status === 'open')).toHaveLength(10);
	});

	it('transfers come in as linked pairs; the category sits on the spending leg', async () => {
		const all = accountsOf(alice.id).flatMap((a) => rowsOf(a.id));
		const byId = new Map(all.map((r) => [r.id, r]));
		const legs = all.filter((r) => r.transferPartnerId);
		expect(legs.length).toBe(budget.rows.filter((r) => r.transferId).length);
		for (const r of legs) {
			const p = byId.get(r.transferPartnerId!)!;
			expect(p.transferPartnerId).toBe(r.id);
			expect(p.amountPaise).toBe(-r.amountPaise);
		}
		const sip = rowsOf(byName('Kuvera MF').id).filter((r) => r.transferPartnerId);
		expect(sip).toHaveLength(6);
		expect(sip.every((r) => r.categoryId === null)).toBe(true);
		expect(byId.get(sip[0]!.transferPartnerId!)!.categoryId).not.toBeNull();
		const savings = getDb().db.select().from(schema.categoryGroups).where(eq(schema.categoryGroups.name, 'Savings')).get()!;
		expect(savings.kind).toBe('investments');
	});

	it('the split comes in as its two parts with their categories, the note joined', async () => {
		const card = rowsOf(byName('HDFC Regalia Card').id).filter((r) => r.date === '2026-07-14' && r.notes?.startsWith('Prime Day order'));
		expect(card.map((r) => [r.amountPaise, r.notes]).sort()).toEqual([
			[-1900_00, 'Prime Day order: Atta, oil'],
			[-3500_00, 'Prime Day order: Headphones']
		]);
		const names = card.map((r) => getDb().db.select().from(schema.categories).where(eq(schema.categories.id, r.categoryId!)).get()!.name).sort();
		expect(names).toEqual(['Groceries', 'Shopping']);
	});

	it('the reconciliation adjustment is a value update: Invested 7,90,000, Value 8,48,230', async () => {
		const mf = byName('Kuvera MF');
		const marks = rowsOf(mf.id).filter((r) => r.kind === 'valuationMark');
		expect(marks).toMatchObject([{ date: '2026-10-31', markTargetPaise: 848230_00, amountPaise: 58230_00 }]);
		const m = (await holdingMetrics(getDb(), alice.id, mf.id))!;
		expect(m.costBasisPaise).toBe(790000_00);
	});

	it('plain deposits: EPF money put in (Salary), PPF return (as Actual left it)', async () => {
		const epf = (await holdingMetrics(getDb(), alice.id, byName('EPF').id))!;
		const ppf = (await holdingMetrics(getDb(), alice.id, byName('PPF (SBI)').id))!;
		expect(epf.costBasisPaise).toBe(1007830_00);
		expect(ppf.costBasisPaise).toBe(560000_00);
		const salary = rowsOf(byName('EPF').id).filter((r) => r.categoryId);
		expect(salary).toHaveLength(6);
		const cat = getDb().db.select().from(schema.categories).where(eq(schema.categories.id, salary[0]!.categoryId!)).get()!;
		expect(cat.name).toBe('Salary');
	});

	it('names already here are reused; a new Interest counts as return; hidden stays hidden', async () => {
		const cats = getDb().db.select().from(schema.categories).where(isNull(schema.categories.deletedAt)).all();
		expect(cats.filter((c) => c.name === 'Salary')).toHaveLength(1);
		expect(cats.filter((c) => c.name === 'Groceries')).toHaveLength(1);
		expect(cats.filter((c) => c.name === 'Rent')).toHaveLength(1);
		expect(cats.find((c) => c.name === 'Maid')).toBeDefined();
		expect(cats.find((c) => c.name === 'Interest')!.countsAsReturn).toBe(true);
		expect(cats.find((c) => c.name === 'Maid')!.hidden).toBe(true);
		const old = getDb().db.select().from(schema.categoryGroups).where(eq(schema.categoryGroups.name, 'Old stuff')).get()!;
		expect(old.hidden).toBe(true);
		expect(cats.some((c) => c.name === 'Starting Balances')).toBe(false);
	});

	it('the importer owns every account, private; the log lists the import', async () => {
		expect(accountsOf(bob.id)).toHaveLength(0);
		expect(listImports(getDb(), alice.id)).toMatchObject([{ fileName: '2026-11-05-Sample budget.zip', accounts: 10, transactions: 263, canUndo: true }]);
		expect(listImports(getDb(), bob.id)).toEqual([]);
	});

	it('importing the same file again adds nothing', async () => {
		const s = snapshot();
		const p = previewImport(getDb(), alice.id, budget);
		expect(p.alreadyHere).toBe(true);
		expect(p.accounts.every((a) => a.existing !== null && a.rows === 0)).toBe(true);
		const r = await runImport(getDb(), alice.id, budget, 'again.zip', defaultChoices(p));
		expect(r).toMatchObject({ accounts: 0, transactions: 0, categories: 0, payees: 0 });
		expect(snapshot().transactions).toBe(s.transactions);
		expect(snapshot().accounts).toBe(s.accounts);
		undoImport(getDb(), alice.id, r.importId); // the empty one, so the first is the latest again
	});

	it('a newer export adds only its new rows', async () => {
		const newer = readActualExport(
			changedSample((db) => {
				const acct = (db.prepare("SELECT id FROM accounts WHERE name = 'Cash'").get() as { id: string }).id;
				db.prepare('INSERT INTO transactions (id, acct, amount, date, notes, isParent, isChild, tombstone, sort_order, starting_balance_flag) VALUES (?, ?, ?, ?, ?, 0, 0, 0, ?, 0)').run(
					'new-row-1', acct, -25000, 20261101, 'Chai again', 1
				);
			})
		);
		const p = previewImport(getDb(), alice.id, newer);
		expect(p.accounts.find((a) => a.name === 'Cash')!.rows).toBe(1);
		const r = await runImport(getDb(), alice.id, newer, 'newer.zip', defaultChoices(p));
		expect(r.transactions).toBe(1);
		expect(accountBalance(getDb().sqlite, byName('Cash').id)).toBe(actualBalances().get('Cash')! - 250_00);
		undoImport(getDb(), alice.id, r.importId);
		expect(accountBalance(getDb().sqlite, byName('Cash').id)).toBe(actualBalances().get('Cash')!);
	});

	it('Undo: refused while an imported account is shared; warns with rows typed since; then restores the file', async () => {
		const cash = byName('Cash');
		await shareAccount(getDb().db, { userId: alice.id }, cash.id, bob.id);
		expect(undoCheck(getDb(), alice.id, importId).refusal).toBe('Cash was shared after the import. Stop sharing it, then undo.');
		expect(() => undoImport(getDb(), alice.id, importId)).toThrow(ImportRefusedError);
		await unshareAccount(getDb().db, { userId: alice.id }, cash.id, bob.id);

		await createTransaction(getDb(), { userId: alice.id }, { accountId: cash.id, date: TODAY, amountPaise: -100_00, payeeName: 'Swiggy' });
		expect(undoCheck(getDb(), alice.id, importId)).toEqual({ refusal: null, typedSince: 1 });

		undoImport(getDb(), alice.id, importId);
		expect(accountsOf(alice.id)).toHaveLength(0);
		const after = snapshot();
		expect(after).toEqual(before);
		expect(listImports(getDb(), alice.id)).toEqual([]);
		expect(undoCheck(getDb(), alice.id, importId).refusal).toBe('That import is already undone.');
	});
});

describe('refusals and flags (F4)', () => {
	it('a closed Actual account with a row after today comes in open, flagged', async () => {
		const b = readActualExport(
			changedSample((db) => {
				const acct = (db.prepare("SELECT id FROM accounts WHERE name = 'Axis Old Savings'").get() as { id: string }).id;
				db.prepare('INSERT INTO transactions (id, acct, amount, date, isParent, isChild, tombstone, sort_order, starting_balance_flag) VALUES (?, ?, ?, ?, 0, 0, 0, 1, 0)').run(
					'future-1', acct, 500, Number(TOMORROW.replaceAll('-', ''))
				);
			})
		);
		const p = previewImport(getDb(), alice.id, b);
		expect(p.accounts.find((a) => a.name === 'Axis Old Savings')!.comesInOpen).toBe(true);
		const choices = defaultChoices(p);
		const only: ImportChoices = { ...choices, accounts: Object.fromEntries(Object.entries(choices.accounts).map(([k, v]) => [k, { ...v, include: p.accounts.find((a) => a.actualId === k)!.name === 'Axis Old Savings' }])) };
		const r = await runImport(getDb(), alice.id, b, 'future.zip', only);
		expect(byName('Axis Old Savings').status).toBe('open');
		undoImport(getDb(), alice.id, r.importId);
	});

	it('an account that would start after today is flagged, unticked by default, and refused if ticked', async () => {
		const b = readActualExport(
			changedSample((db) => {
				db.prepare("INSERT INTO accounts (id, name, offbudget, closed, sort_order, tombstone) VALUES ('fd-new', 'New FD', 1, 0, 99999, 0)").run();
				const start = (db.prepare("SELECT id FROM payees WHERE name = 'Starting Balance'").get() as { id: string }).id;
				db.prepare('INSERT INTO transactions (id, acct, amount, date, description, isParent, isChild, tombstone, sort_order, starting_balance_flag) VALUES (?, ?, ?, ?, ?, 0, 0, 0, 1, 0)').run(
					'fd-start', 'fd-new', 10000000, Number(TOMORROW.replaceAll('-', '')), start
				);
			})
		);
		const p = previewImport(getDb(), alice.id, b);
		const fd = p.accounts.find((a) => a.name === 'New FD')!;
		expect(fd).toMatchObject({ startsAfterToday: true, addAs: 'fd:0' });
		const choices = defaultChoices(p);
		expect(choices.accounts[fd.actualId]!.include).toBe(false);
		const s = snapshot();
		const forced: ImportChoices = { ...choices, accounts: { ...choices.accounts, [fd.actualId]: { ...choices.accounts[fd.actualId]!, include: true } } };
		await expect(runImport(getDb(), alice.id, b, 'fd.zip', forced)).rejects.toThrow('New FD would start after today');
		expect(snapshot()).toEqual(s);
	});

	it('a transfer to an account left out comes in as a plain row named after it; balances unchanged', async () => {
		const p = previewImport(getDb(), alice.id, budget);
		const choices = defaultChoices(p);
		const kuvera = p.accounts.find((a) => a.name === 'Kuvera MF')!.actualId;
		const r = await runImport(getDb(), alice.id, budget, 'no-mf.zip', { ...choices, accounts: { ...choices.accounts, [kuvera]: { ...choices.accounts[kuvera]!, include: false } } });
		const salary = byName('HDFC Salary');
		expect(accountBalance(getDb().sqlite, salary.id)).toBe(actualBalances().get('HDFC Salary'));
		const sips = rowsOf(salary.id).filter((r2) => r2.notes === 'SIP');
		expect(sips).toHaveLength(6);
		expect(sips.every((x) => x.transferPartnerId === null && x.payeeId !== null && x.categoryId !== null)).toBe(true);
		const payee = getDb().db.select().from(schema.payees).where(eq(schema.payees.id, sips[0]!.payeeId!)).get()!;
		expect(payee.displayName).toBe('Kuvera MF');
		undoImport(getDb(), alice.id, r.importId);
	});
});

describe("Settings' Import card (F4 route actions)", () => {
	const me = (): AuthedUser => ({ id: alice.id, username: 'alice', role: 'admin' });
	function ev(fields: Record<string, string | File>) {
		const body = new FormData();
		for (const [k, v] of Object.entries(fields)) body.set(k, v);
		return { locals: { user: me() }, params: {}, url: new URL('http://localhost/settings'), request: new Request('http://localhost/settings', { method: 'POST', body }) } as never;
	}
	const zipFile = () => new File([fs.readFileSync(SAMPLE)], '2026-11-05-Sample budget.zip', { type: 'application/zip' });
	const act = (name: string) => settingsActions[name] as (e: never) => Promise<Record<string, unknown>>;

	it('preview, import with the choices, the log on the page, then Undo', async () => {
		const p = (await act('importPreview')(ev({ file: zipFile() }))) as { importPreview: Parameters<typeof defaultChoices>[0]; importFileName: string };
		expect(p.importFileName).toBe('2026-11-05-Sample budget.zip');
		expect(p.importPreview.accounts).toHaveLength(10);

		const r = (await act('importRun')(ev({ file: zipFile(), choices: JSON.stringify(defaultChoices(p.importPreview)) }))) as { imported: { transactions: number } };
		expect(r.imported.transactions).toBe(263);

		const page = (await settingsLoad({ locals: { user: me() }, url: new URL('http://localhost/settings'), request: new Request('http://localhost/settings') } as never)) as { imports: { id: string; canUndo: boolean; undo: { refusal: string | null } }[] };
		expect(page.imports).toHaveLength(1);
		expect(page.imports[0]).toMatchObject({ canUndo: true, undo: { refusal: null, typedSince: 0 } });

		expect(await act('undoImport')(ev({ importId: page.imports[0]!.id }))).toEqual({ importUndone: true });
		expect(accountsOf(alice.id)).toHaveLength(0);
	});

	it('a file that is not a zip, or none, fails in plain words', async () => {
		const bad = (await act('importPreview')(ev({ file: new File([Buffer.from('hello there, not a zip file')], 'notes.txt') }))) as { status: number; data: { importError: string } };
		expect(bad.status).toBe(400);
		expect(bad.data.importError).toBe("This file isn't a zip.");
		const none = (await act('importPreview')(ev({}))) as { data: { importError: string } };
		expect(none.data.importError).toBe('Choose the zip Actual saved.');
		const garbled = (await act('importRun')(ev({ file: zipFile(), choices: '{nope' }))) as { data: { importError: string } };
		expect(garbled.data.importError).toBe('Something in the list was unreadable. Open the file again.');
	});
});
