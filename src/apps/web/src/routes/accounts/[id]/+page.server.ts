/**
 * Per-account register (C1). The load resolves visibility SERVER-SIDE via
 * `registerView` (which throws `AccountNotFoundError` → 404) BEFORE revealing
 * anything — a non-visible account 404s IDENTICALLY to a bogus id, so existence
 * is never leaked (P0; route-guards.integration.test proves this). It surfaces
 * the passbook rows + as-of-today/projected split, the category picker tree, and
 * the viewer's payees (autocomplete + fill-when-blank prefill), plus the F1
 * Close/Reopen and opening-balance-edit actions.
 */
import { isRealDate } from '$lib/dates';
import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad, PageServerData, RequestEvent } from './$types';
import { getDb } from '$lib/server/db/instance';
import { isAccountVisibleTo, accountsVisibleTo, sharesFor, holdsOnDate, SINCE_START } from '$lib/server/visibility';
import {
	childAccountIds,
	closeAccount,
	reopenAccount,
	renameAccount,
	setAccountInfo,
	setOpeningBalance,
	closeRefusal,
	AccountNameConflictError,
	OpeningDateError,
	UpcomingRowsError
} from '$lib/server/accounts';
import {
	registerView,
	createTransaction,
	updateTransaction,
	deleteTransaction,
	restoreTransaction,
	restoreTransactions,
	duplicateTransaction,
	DuplicateTransactionError,
	reorderWithinDate,
	bulkUpdate,
	capturePayees,
	rememberedTransferCategories,
	AccountNotFoundError,
	ClosedAccountError,
	InvalidCategoryError,
	StaleEditError,
	TransferCategoryError,
	TransferEditError,
	setTransferAccount,
	transferToPayee,
	type BulkAction
} from '$lib/server/transactions';
import {
	listAccountMembers,
	listCircleMembers,
	shareAccount,
	unshareAccount,
	setAccountShares,
	splitState,
	NotAccountOwnerError,
	InvalidShareTargetError,
	InvalidSplitError
} from '$lib/server/sharing';
import { listCategoryTree } from '$lib/server/categories';
import { holdingMetrics, returnFlags, valueInvestedHistory, recentActivity, type Timeframe } from '$lib/server/dashboard';
import { postValuationMark, editMarkTarget, NotMarkableError, MarkBeforeStartError } from '$lib/server/marks';
import { sectionLabel, sectionTypeOf, moduleProfile, readInfoForm, workedOutFigures } from '$lib/modules';
import { parseForm, transactionCreateSchema, rupeesToPaise } from '$lib/server/validation';
import { loadRateTable } from '$lib/server/rates';
import { baseCurrency } from '$lib/server/settings';
import { toBase, Money, getModule, today, formatDate } from '@miserly/core';
import { accountBalance } from '$lib/server/db/balances';
import { appClock } from '$lib/server/clock';
import { createTransfer, CurrencyMismatchError, SelfTransferError } from '$lib/server/transfers';
import { textProblem } from '$lib/text-limits';
import { firstPageSize } from '$lib/list-pages';
import { isUntouchedNote } from '$lib/server/listed-notes';
import * as v from 'valibot';
import { and, eq, gte, isNull } from 'drizzle-orm';
import { transactions as txTable, accounts as accountsTable } from '$lib/server/db/schema';

import {
	TRANSFER_PREFIX,
	isInlineTransfer,
	addInlineTransfer,
	resolveTransferTarget,
	transferTargetsFor
} from '$lib/server/inline-transfer';

/** Map the service's not-found/visibility error to the shared 404 (no leak). */
function notFoundGuard(err: unknown): never {
	if (err instanceof AccountNotFoundError) throw error(404, 'Not found');
	throw err;
}

const TIMEFRAMES: readonly Timeframe[] = ['1M', '3M', '6M', 'YTD', '1Y', 'ALL'];

/** Register rows with the engine's "counts as return" flag each carries (`returnFlags`), for the
 *  worked-out figures. Only a type with a yearly limit (PPF) reads them, so others skip the query. */
function withReturnFlags<R extends { id: string; kind: 'ordinary' | 'valuationMark'; categoryId: string | null; transferPartnerId: string | null }>(
	db: ReturnType<typeof getDb>['db'],
	type: string,
	rows: readonly R[]
): (R & { countsAsReturn?: boolean })[] {
	if (!(moduleProfile(type)?.workedOut ?? []).some((w) => w.kind !== 'date')) return [...rows];
	const flags = returnFlags(db, rows);
	return rows.map((r) => (flags.has(r.id) ? { ...r, countsAsReturn: flags.get(r.id)! } : r));
}

/** S5 RD16: the account's parent and children the viewer can see ([parent, child] for an EPF and its
 *  EPS), or null for an account with neither. */
async function accountFamily(db: ReturnType<typeof getDb>, userId: string, accountId: string) {
	const me = db.db.select().from(accountsTable).where(eq(accountsTable.id, accountId)).get();
	if (!me) return null;
	const parentId = me.parentAccountId ?? me.id;
	const parent = parentId === me.id ? me : db.db.select().from(accountsTable).where(eq(accountsTable.id, parentId)).get();
	const kids = childAccountIds(db, parentId);
	if (!parent || kids.length === 0) return null;
	const visible = new Set(await accountsVisibleTo(db.db, userId));
	const child = kids.map((id) => db.db.select().from(accountsTable).where(eq(accountsTable.id, id)).get()).find((a) => a && visible.has(a.id));
	if (!child || !visible.has(parent.id)) return null;
	return {
		parent: { id: parent.id, label: moduleProfile(parent.type)?.label ?? parent.type },
		child: { id: child.id, label: moduleProfile(child.type)?.label.split(' ')[0] ?? child.type }
	};
}

export const load: PageServerLoad = async ({ params, locals, url }) => {
	const user = locals.user;
	if (!user) throw redirect(303, '/signin');

	const db = getDb();
	// The newest page of rows, the rest by pages as the register scrolls (`rows/+server.ts`).
	// A link to a row (`?tx=`) or a save's answer (`?from=`) takes every row from that date on.
	const txId = url.searchParams.get('tx');
	const linked = txId
		? db.db.select({ date: txTable.date }).from(txTable).where(and(eq(txTable.id, txId), eq(txTable.accountId, params.id), isNull(txTable.deletedAt))).get()?.date
		: undefined;
	const fromParam = url.searchParams.get('from');
	const from = fromParam !== null && isRealDate(fromParam) ? fromParam : linked;
	let view;
	try {
		view = await registerView(db, user.id, params.id, from !== undefined ? { from } : { limit: firstPageSize(url) });
	} catch (err) {
		notFoundGuard(err);
	}
	// S5 RD14's worked-out figures (PPF, SGB) sum the person's own rows: every row, not a page.
	const allRows = (moduleProfile(view.account.type)?.workedOut ?? []).length > 0 && view.next !== null ? (await registerView(db, user.id, params.id)).rows : view.rows;

	// Picker + prefill reference data (both viewer-safe: categories are global
	// taxonomy; payees are already viewer-scoped inside capturePayees).
	const groups = await listCategoryTree(db.db);
	const payees = await capturePayees(db.db, user.id);
	// The category a transfer typed here fills in, per destination account (looked up).
	const transferCategories = await rememberedTransferCategories(db.db, user.id);
	// Inline-transfer targets: the viewer's OTHER open accounts (C3), each with its id, its
	// label ("HDFC (Bob's)", C8) and section, and its currency so the inline entry row can reveal the
	// MC2 FX field (received amount) when a "Transfer → X" crosses currencies.
	const transferTargets = (await transferTargetsFor(db, user.id))
		.filter((t) => t.id !== params.id)
		.map(({ id, name, label, listLabel, type, currency }) => ({ id, name, label, listLabel, type, currency }));

	// S2/S3: holding value/invested/return + whether "Update value" is offered.
	const holding = await holdingMetrics(db, user.id, params.id);

	// MC3: the account-total header shows a "≈ ₹X" secondary line for a FOREIGN
	// account (native stays primary — nothing here touches the register rows,
	// which render in the account's own currency untouched). Converted through
	// the ONE `toBase` boundary (MC1) — never computed here. An account in base
	// needs neither (isForeign short-circuits).
	const isForeign = view.account.currency !== baseCurrency(db.db);
	let baseApproxPaise: number | null = null;
	let rateNeeded = false;
	if (isForeign) {
		const rates = loadRateTable(db.db);
		const converted = toBase(Money.fromPaise(view.asOfTodayPaise, view.account.currency), rates);
		if (converted === null) rateNeeded = true; // MC1: never a silent 1:1
		else baseApproxPaise = converted.paise;
	}

	// H2: the account's Members panel. `listAccountMembers` re-checks visibility
	// (already proven above by `registerView`) — cheap and keeps this call
	// independently correct if the load is ever refactored. The viewer's OWN
	// holder row tells us whether they are the owner (no separate account query
	// needed — `listAccountMembers` already resolved ownership once).
	// C5 C: a member who has left reads the dates they held and nothing else: no holders list, no
	// share controls, no current figures (`view.access.canWrite` is false).
	const holders = view.access.canWrite ? await listAccountMembers(db.db, user.id, params.id) : [];
	const isOwner = holders.find((h) => h.userId === user.id)?.isOwner ?? false;
	// The owner's share picker needs the full Circle roster (identity only) so it
	// can offer people not already holding this account — non-owners never see
	// or need this list (the Svelte component filters owner + existing holders).
	const circleMembers = isOwner ? await listCircleMembers(db.db) : [];
	const split = holders.length > 1 ? await splitState(db.db, user.id, params.id) : { statedFrom: null };
	// H2 RD8: the register is the record (full amounts); a joint account's header says the viewer's
	// share of it, and a joint debt that each holder is liable for all of it.
	const todayIso = formatDate(today(appClock()));
	const myShares = holders.length > 1 ? await sharesFor(db.db, user.id, [params.id]) : null;
	const myShare = myShares && {
		bp: myShares.shareBpOn(params.id, todayIso),
		partPaise: myShares.partOn(params.id, view.asOfTodayPaise, todayIso)
	};

	// I1 placement B: an investment's page opens on Transactions, always;
	// `?view=chart` swaps the register for its value against money put in (the Dashboard's ranges).
	const showReturn = !!holding?.isHolding && getModule(view.account.type).metadata.side === 'Asset';
	const chartView = showReturn && url.searchParams.get('view') === 'chart';
	const rawRange = url.searchParams.get('range');
	const timeframe: Timeframe = TIMEFRAMES.includes(rawRange as Timeframe) ? (rawRange as Timeframe) : 'ALL';
	const chart = chartView ? await valueInvestedHistory(db, user.id, { accountId: params.id }, timeframe) : null;

	// S5 RD16: an EPF and its EPS are one page with two tabs (EPF | EPS | Chart), each its own
	// account; the pair is found by the parent link, and only accounts the viewer can see count.
	const family = await accountFamily(db, user.id, view.account.id);

	return {
		view,
		chartView,
		family,
		paidInOnly: !!moduleProfile(view.account.type)?.paidInOnly,
		chart,
		// A precise top-bar breadcrumb (the account's own name) instead of a
		// generic "Account" derived from the path.
		crumb: view.account.name,
		// The section between All accounts and the account in the top bar's path.
		crumbSection: { label: sectionLabel(sectionTypeOf(view.account.type)), href: `/sections/${sectionTypeOf(view.account.type)}` },
		holding,
		// S5 RD14: dates fixed by the scheme and sums of the person's own rows (PPF, SGB), shown
		// after the details; never an interest figure. Each row carries its "counts as return" flag,
		// so "Deposited this year" counts what Invested counts.
		workedOut: workedOutFigures(view.account.type, view.account.infoJson, withReturnFlags(db.db, view.account.type, allRows), todayIso),
		// Invested and return belong to ASSET holdings (S1 RD9): a loan's page leads with its
		// balance, as its section page does. The side comes from the module's contract metadata.
		showReturn,
		side: getModule(view.account.type).metadata.side,
		myShare,
		sectionLabel: sectionLabel(view.account.type),
		categoryGroups: groups.map((g) => ({
			id: g.id,
			name: g.name,
			kind: g.kind,
			categories: g.categories.map((c) => ({ id: c.id, name: c.name }))
		})),
		payees,
		transferCategories,
		transferTargets,
		// F1 RD15: what a close must move or adjust, as of today. Rows dated later refuse the
		// close, and the dialog says so in place of its choices.
		closeBalancePaise: view.account.status === 'open' ? view.asOfTodayPaise : 0,
		closeUpcoming: view.account.status === 'open' && view.access.canWrite ? closeRefusal(db, params.id, view.todayDate) : null,
		// C5 C: the opening is from before a member joined; only someone holding it from the start
		// changes it.
		openingLocked: !heldFromStart(user.id, params.id),
		baseApproxPaise,
		rateNeeded,
		holders,
		isOwner,
		circleMembers,
		split
	};
};

/**
 * What a save answers with: never the whole list. The page keeps its rows and patches them
 * (the sidebar reloads alone, `app:nav`):
 *  - the register: the page's figures as its load computes them, and its rows from `from` on (every
 *    row dated on or after the earliest date the save touched, with its running balance: a
 *    back-dated save moves the balances after it, and a value update reconciles the ones after);
 *  - All transactions (`view=all` posted with the save): the saved rows in its own shape, with the
 *    value updates after them in the same account (their amounts follow).
 * Keyed by the saved row's own account. The save is done by then: if the answer can't be made, it
 * is left out and the page reloads, as before.
 */
async function savedAnswer(event: RequestEvent, form: FormData, accountId: string | undefined, ids: readonly string[], from: string) {
	const user = event.locals.user!;
	const db = getDb();
	if (!accountId) return {};
	try {
		if (form.get('view') === 'all') {
			const marks = db.db
				.select({ id: txTable.id })
				.from(txTable)
				.where(and(eq(txTable.accountId, accountId), eq(txTable.kind, 'valuationMark'), gte(txTable.date, from), isNull(txTable.deletedAt)))
				.all()
				.map((r) => r.id);
			const all = [...new Set([...ids, ...marks])];
			return { activity: await recentActivity(db, user.id, all.length, undefined, { ids: all }) };
		}
		// The register's figures as its load makes them (the chart view never saves rows: no `?view=`).
		// Every row from `from` on, whatever page the person has scrolled to.
		const at = { ...event, params: { id: accountId }, url: new URL(`http://localhost/accounts/${accountId}?from=${isRealDate(from) ? from : SINCE_START}`) };
		const page = (await load(at as never)) as PageServerData;
		return {
			page: { ...page, view: { ...page.view, rows: [] } },
			tail: { from, rows: page.view.rows.filter((r) => r.date >= from) }
		};
	} catch {
		return {};
	}
}

/** The earlier of two ISO dates (the date a save moved a row from, or to). */
const earlier = (a: string | undefined, b: string): string => (a !== undefined && a < b ? a : b);

const OPENING_NOT_HELD = 'The starting balance is from before this account was shared with you, so only its owner can change it.';

/** True when the actor holds the account from its start (the owner, or a grant from before 0013). */
function heldFromStart(userId: string, accountId: string): boolean {
	return holdsOnDate(getDb().db, userId, accountId, SINCE_START);
}

/** Guard: the actor may only act on an account visible to them (same 404). */
async function requireVisible(userId: string, accountId: string): Promise<void> {
	const db = getDb();
	if (!(await isAccountVisibleTo(db.db, userId, accountId))) {
		throw error(404, 'Not found');
	}
}

export const actions: Actions = {
	/** C1: add a transaction to THIS account's register. */
	addTransaction: async (event) => {
		const { params, request, locals } = event;
		const user = locals.user;
		if (!user) throw redirect(303, '/signin');
		await requireVisible(user.id, params.id);

		const fd = await request.formData();
		const parsed = parseForm(transactionCreateSchema, fd);
		if (!parsed.success) return fail(400, { errors: parsed.errors });

		// C3 inline path: a "Transfer → <account>" payee creates a linked pair
		// instead of an ordinary row. Direction follows the column used — an
		// outflow moves money OUT of this account, an inflow moves it IN.
		if (isInlineTransfer(parsed.data.payeeName)) {
			try {
				const errors = await addInlineTransfer(getDb(), user.id, params.id, {
					payeeName: parsed.data.payeeName,
					transferAccountId: String(fd.get('transferAccountId') ?? ''),
					amountPaise: parsed.data.amountPaise,
					date: parsed.data.date,
					notes: parsed.data.notes,
					categoryId: parsed.data.categoryId,
					received: String(fd.get('received') ?? '')
				});
				if (errors) return fail(400, { errors });
				return { added: true, transfer: true };
			} catch (err) {
				if (err instanceof AccountNotFoundError) throw error(404, 'Not found');
				throw err;
			}
		}

		try {
			const tx = await createTransaction(
				getDb(),
				{ userId: user.id },
				{
					accountId: params.id,
					date: parsed.data.date,
					amountPaise: parsed.data.amountPaise,
					payeeName: parsed.data.payeeName,
					categoryId: parsed.data.categoryId,
					notes: parsed.data.notes
				}
			);
			return { added: true, txId: tx.id, ...(await savedAnswer(event, fd, tx.accountId, [tx.id], tx.date)) };
		} catch (err) {
			if (err instanceof AccountNotFoundError) throw error(404, 'Not found');
			if (err instanceof ClosedAccountError) return fail(400, { errors: { _: err.message } });
			if (err instanceof InvalidCategoryError)
				return fail(400, { errors: { category: err.message } });
			throw err;
		}
	},

	/** F1: correct the opening balance (amount/date) — account-field surface,
	 *  not a C4 row edit (build reconciliation: opening is a dated column). */
	setOpening: async ({ params, request, locals }) => {
		const user = locals.user;
		if (!user) throw redirect(303, '/signin');
		await requireVisible(user.id, params.id);

		const form = await request.formData();
		const openingRupees = String(form.get('opening') ?? '').trim().replace(/[,\s₹$€£]/gu, '');
		const openingDate = String(form.get('openingDate') ?? '').trim() || null;
		if (!/^-?\d+(\.\d{1,2})?$/u.test(openingRupees)) {
			return fail(400, { errors: { opening: 'Enter an amount like 1000 or -250' } });
		}
		const openingPaise = Math.round(Number(openingRupees) * 100);
		if (!Number.isSafeInteger(openingPaise)) {
			return fail(400, { errors: { opening: 'Amount is too large' } });
		}
		if (!heldFromStart(user.id, params.id)) return fail(400, { errors: { _: OPENING_NOT_HELD } });
		try {
			await setOpeningBalance(getDb(), params.id, openingPaise, openingDate);
		} catch (err) {
			if (err instanceof ClosedAccountError) return fail(400, { errors: { _: err.message } });
			if (err instanceof OpeningDateError) return fail(400, { errors: { openingDate: err.message } });
			if (err instanceof Error && /opening date/u.test(err.message)) {
				return fail(400, { errors: { openingDate: 'A start date is required for a non-zero opening balance' } });
			}
			throw err;
		}
		return { openingUpdated: true };
	},

	/** The Edit account dialog, one Save for the name, the opening balance (F1: an
	 *  account field, not a transaction edit) and the optional details (S5 RD8). */
	editAccount: async ({ params, request, locals }) => {
		const user = locals.user;
		if (!user) throw redirect(303, '/signin');
		await requireVisible(user.id, params.id);

		const form = await request.formData();
		const name = String(form.get('name') ?? '').trim();
		if (name === '') return fail(400, { errors: { name: 'Give the account a name' } });
		const nameProblem = textProblem(name, 'name');
		if (nameProblem) return fail(400, { errors: { name: nameProblem } });
		const db = getDb();
		const account = db.db
			.select({ type: accountsTable.type, status: accountsTable.status })
			.from(accountsTable)
			.where(eq(accountsTable.id, params.id))
			.get();
		// A closed account's opening is read-only ("Reopen to change"); its name and details
		// still save (they move no money). C5 C: so is it for a member who joined after it.
		const closed = account?.status === 'closed' || !heldFromStart(user.id, params.id);
		// Add account's field and sign: a card or loan posts its outstanding as a
		// positive amount owed, stored negative; a holding's amount invested can't be negative.
		const onboarding = account ? moduleProfile(account.type)?.onboarding : undefined;
		const owed = onboarding === 'cardOutstanding' || onboarding === 'loanOutstanding';
		const field = owed ? 'outstanding' : 'opening';
		const openingRupees = String(form.get(field) ?? '').trim().replace(/[,\s₹$€£]/gu, '') || '0';
		const openingDate = String(form.get('openingDate') ?? '').trim() || null;
		if (!closed && !/^-?\d+(\.\d{1,2})?$/u.test(openingRupees)) {
			return fail(400, { errors: { [field]: 'Enter an amount like 1000 or -250' } });
		}
		const typedPaise = Math.round(Number(openingRupees) * 100);
		if (!closed && !Number.isSafeInteger(typedPaise)) {
			return fail(400, { errors: { [field]: 'Amount is too large' } });
		}
		if (!closed && onboarding === 'investedValue' && typedPaise < 0) {
			return fail(400, { errors: { opening: 'Amount cannot be negative' } });
		}
		const openingPaise = owed && typedPaise !== 0 ? -typedPaise : typedPaise;
		if (!closed && openingPaise !== 0 && !openingDate) {
			return fail(400, { errors: { openingDate: 'A start date is required for a non-zero opening balance' } });
		}
		const profile = account && moduleProfile(account.type);
		const details = profile ? readInfoForm(profile, form) : null;
		if (details && 'errors' in details) return fail(400, { errors: details.errors });
		try {
			await renameAccount(db, params.id, name, user.id);
		} catch (err) {
			if (err instanceof AccountNameConflictError) return fail(400, { errors: { name: err.message } });
			throw err;
		}
		if (!closed) {
			try {
				await setOpeningBalance(db, params.id, openingPaise, openingDate);
			} catch (err) {
				if (err instanceof OpeningDateError) return fail(400, { errors: { openingDate: err.message } });
				throw err;
			}
		}
		// A type with no details keeps whatever is stored (there was nothing to edit).
		if (details && profile && profile.infoFields.length > 0) await setAccountInfo(db, params.id, details.infoJson);
		return { accountSaved: true };
	},

	/** C4: edit a transaction (optimistic on updatedAt). Reuses the two-column
	 *  amount schema; transfer rows sync their partner inside the service. */
	editTx: async (event) => {
		const { request, locals } = event;
		const user = locals.user;
		if (!user) throw redirect(303, '/signin');
		const form = await request.formData();
		const txId = String(form.get('txId') ?? '');
		const expected = String(form.get('expectedUpdatedAt') ?? '');
		// The grid re-posts the row's note as the list carried it; posted unchanged, the stored note
		// stays (a list cuts an older over-long one, which must not be written back cut or refused).
		const keepNotes = isUntouchedNote(getDb().sqlite, txId, String(form.get('notes') ?? ''));
		if (keepNotes) form.set('notes', '');
		const parsed = parseForm(transactionCreateSchema, form);
		if (!parsed.success) return fail(400, { errors: parsed.errors });
		try {
			// The payee cell of a transfer is its other account (Actual): "Transfer → X" re-pairs
			// it (or makes an ordinary row a transfer), a payee makes it an ordinary row.
			const payeeText = parsed.data.payeeName?.trim() ?? '';
			const db = getDb();
			const current = db.db
				.select({ partner: txTable.transferPartnerId, accountId: txTable.accountId, date: txTable.date })
				.from(txTable)
				.where(eq(txTable.id, txId))
				.get();
			if (payeeText.startsWith(TRANSFER_PREFIX)) {
				// The picked line's id; typed text names one account other than the row's own.
				const target = resolveTransferTarget(
					await transferTargetsFor(db, user.id),
					current?.accountId ?? '',
					payeeText,
					String(form.get('transferAccountId') ?? '')
				);
				if (typeof target === 'string') return fail(400, { errors: { payee: target } });
				await setTransferAccount(db, { userId: user.id }, txId, target.id, expected);
				return { edited: true };
			}
			// `field` = the one cell a grid save changed: an emptied payee cell converts back too.
			if (current?.partner && (payeeText !== '' || form.get('field') === 'payee')) {
				await transferToPayee(db, { userId: user.id }, txId, payeeText, expected);
				return { edited: true };
			}
			await updateTransaction(
				getDb(),
				{ userId: user.id },
				txId,
				{
					date: parsed.data.date,
					amountPaise: parsed.data.amountPaise,
					payeeName: parsed.data.payeeName,
					categoryId: parsed.data.categoryId,
					notes: keepNotes ? undefined : parsed.data.notes
				},
				expected
			);
			return { edited: true, ...(await savedAnswer(event, form, current?.accountId, [txId], earlier(current?.date, parsed.data.date))) };
		} catch (err) {
			if (err instanceof AccountNotFoundError) throw error(404, 'Not found');
			if (err instanceof StaleEditError) return fail(409, { errors: { _: err.message } });
			if (err instanceof InvalidCategoryError) return fail(400, { errors: { category: err.message } });
			if (err instanceof TransferCategoryError) return fail(400, { errors: { category: err.message } });
			if (err instanceof TransferEditError) return fail(400, { errors: { payee: err.message } });
			if (err instanceof ClosedAccountError) return fail(400, { errors: { _: err.message } });
			throw err;
		}
	},

	/** C4: delete a transaction (a transfer deletes both legs). */
	deleteTx: async ({ request, locals }) => {
		const user = locals.user;
		if (!user) throw redirect(303, '/signin');
		const form = await request.formData();
		const txId = String(form.get('txId') ?? '');
		const expected = String(form.get('expectedUpdatedAt') ?? '');
		try {
			const { deletedIds } = await deleteTransaction(getDb(), { userId: user.id }, txId, expected);
			return { deleted: true, undoId: txId, deletedCount: deletedIds.length };
		} catch (err) {
			if (err instanceof AccountNotFoundError) throw error(404, 'Not found');
			if (err instanceof StaleEditError) return fail(409, { errors: { _: err.message } });
			if (err instanceof ClosedAccountError) return fail(400, { errors: { _: err.message } });
			if (err instanceof TransferEditError) return fail(400, { errors: { _: err.message } });
			throw err;
		}
	},

	/** C4: undo the last delete (a transfer restores both legs). */
	restoreTx: async ({ request, locals }) => {
		const user = locals.user;
		if (!user) throw redirect(303, '/signin');
		const txId = String((await request.formData()).get('txId') ?? '');
		try {
			await restoreTransaction(getDb(), { userId: user.id }, txId);
		} catch (err) {
			if (err instanceof AccountNotFoundError) throw error(404, 'Not found');
			if (err instanceof ClosedAccountError) return fail(400, { errors: { _: err.message } });
			throw err;
		}
		return { restored: true };
	},

	/** C4: undo a BULK delete — restores every row the delete tombstoned. */
	restoreBulkTx: async ({ request, locals }) => {
		const user = locals.user;
		if (!user) throw redirect(303, '/signin');
		const ids = (await request.formData()).getAll('ids').map(String).filter(Boolean);
		try {
			const { restored } = await restoreTransactions(getDb(), { userId: user.id }, ids);
			return { restored: true, restoredCount: restored };
		} catch (err) {
			if (err instanceof AccountNotFoundError) throw error(404, 'Not found');
			if (err instanceof ClosedAccountError) return fail(400, { errors: { _: err.message } });
			throw err;
		}
	},

	/** C4: duplicate a row (fast repetitive entry). */
	duplicateTx: async ({ request, locals }) => {
		const user = locals.user;
		if (!user) throw redirect(303, '/signin');
		const txId = String((await request.formData()).get('txId') ?? '');
		try {
			await duplicateTransaction(getDb(), { userId: user.id }, txId);
		} catch (err) {
			if (err instanceof AccountNotFoundError) throw error(404, 'Not found');
			if (err instanceof ClosedAccountError) return fail(400, { errors: { _: err.message } });
			if (err instanceof TransferEditError) return fail(400, { errors: { _: err.message } });
			if (err instanceof DuplicateTransactionError) return fail(400, { errors: { _: err.message } });
			throw err;
		}
		return { duplicated: true };
	},

	/** C4: reorder a same-date row up/down (sequence swap). */
	reorderTx: async ({ request, locals }) => {
		const user = locals.user;
		if (!user) throw redirect(303, '/signin');
		const form = await request.formData();
		const txId = String(form.get('txId') ?? '');
		const direction = form.get('direction') === 'down' ? 'down' : 'up';
		try {
			await reorderWithinDate(getDb(), { userId: user.id }, txId, direction);
		} catch (err) {
			if (err instanceof AccountNotFoundError) throw error(404, 'Not found');
			if (err instanceof ClosedAccountError) return fail(400, { errors: { _: err.message } });
			throw err;
		}
		return { reordered: true };
	},

	/** C4: bulk set-category / delete over a multi-selection (atomic). */
	bulkTx: async ({ request, locals }) => {
		const user = locals.user;
		if (!user) throw redirect(303, '/signin');
		const form = await request.formData();
		const ids = form.getAll('ids').map(String).filter(Boolean);
		const op = String(form.get('op') ?? '');
		let action: BulkAction;
		if (op === 'delete') action = { kind: 'delete' };
		else if (op === 'setCategory') action = { kind: 'setCategory', categoryId: String(form.get('categoryId') ?? '') || null };
		else return fail(400, { errors: { _: 'Unknown bulk action' } });
		try {
			const res = await bulkUpdate(getDb(), { userId: user.id }, ids, action);
			return {
				bulked: true,
				op: action.kind,
				affected: res.affected,
				skippedTransfers: res.skippedTransfers,
				skippedHidden: res.skippedHidden,
				deletedIds: res.deletedIds
			};
		} catch (err) {
			if (err instanceof InvalidCategoryError) return fail(400, { errors: { _: err.message } });
			throw err;
		}
	},

	/** S3: post a valuation mark ("update value"). The entered figure is a
	 *  magnitude; for a liability holding it is signed negative (outstanding owed)
	 *  from the module side before hitting the service. */
	mark: async ({ params, request, locals }) => {
		const user = locals.user;
		if (!user) throw redirect(303, '/signin');
		const form = await request.formData();

		const parsedTarget = v.safeParse(rupeesToPaise, String(form.get('target') ?? '').trim());
		if (!parsedTarget.success || parsedTarget.output < 0) {
			return fail(400, { errors: { target: 'Enter a value like 500000' } });
		}
		const date = String(form.get('date') ?? '').trim();
		if (!isRealDate(date)) {
			return fail(400, { errors: { date: 'Enter a valid date' } });
		}

		// Sign the target by the account's side (a liability marks to a negative
		// value-after). `holdingMetrics` reads the module side (no type branch).
		const hm = await holdingMetrics(getDb(), user.id, params.id);
		if (!hm) throw error(404, 'Not found');
		const signed = hm.side === 'Liability' ? -parsedTarget.output : parsedTarget.output;

		try {
			await postValuationMark(getDb(), { userId: user.id }, {
				accountId: params.id,
				targetPaise: signed,
				date
			});
		} catch (err) {
			if (err instanceof AccountNotFoundError) throw error(404, 'Not found');
			if (err instanceof ClosedAccountError) return fail(400, { errors: { _: err.message } });
			if (err instanceof NotMarkableError) return fail(400, { errors: { _: err.message } });
			if (err instanceof MarkBeforeStartError) return fail(400, { errors: { date: err.message } });
			throw err;
		}
		return { marked: true };
	},

	/** S3: edit an existing mark's asserted target (re-derives its gap). */
	editMark: async (event) => {
		const { params, locals, request } = event;
		const user = locals.user;
		if (!user) throw redirect(303, '/signin');
		const form = await request.formData();
		const markId = String(form.get('markId') ?? '');
		const expected = String(form.get('expectedUpdatedAt') ?? '');
		const parsedTarget = v.safeParse(rupeesToPaise, String(form.get('target') ?? '').trim());
		if (!parsedTarget.success || parsedTarget.output < 0) {
			return fail(400, { errors: { target: 'Enter a value like 500000' } });
		}
		const hm = await holdingMetrics(getDb(), user.id, params.id);
		if (!hm) throw error(404, 'Not found');
		const signed = hm.side === 'Liability' ? -parsedTarget.output : parsedTarget.output;
		// The grid also sends the row's date and memo (a value update edits them in place).
		const date = form.has('date') ? String(form.get('date')).trim() : undefined;
		if (date !== undefined && !isRealDate(date)) return fail(400, { errors: { date: 'Enter a valid date' } });
		const postedNotes = form.has('notes') ? String(form.get('notes')) : undefined;
		const notes = postedNotes === undefined || isUntouchedNote(getDb().sqlite, markId, postedNotes) ? undefined : postedNotes;
		const notesProblem = notes === undefined ? null : textProblem(notes.trim(), 'note');
		if (notesProblem) return fail(400, { errors: { notes: notesProblem } });
		// The date it moves from (its own row, read before the edit; the service checks who may edit).
		const mark = getDb().db.select({ date: txTable.date, accountId: txTable.accountId }).from(txTable).where(eq(txTable.id, markId)).get();
		try {
			await editMarkTarget(getDb(), { userId: user.id }, markId, signed, expected, { date, notes });
		} catch (err) {
			if (err instanceof AccountNotFoundError) throw error(404, 'Not found');
			if (err instanceof StaleEditError) return fail(409, { errors: { _: err.message } });
			if (err instanceof ClosedAccountError) return fail(400, { errors: { _: err.message } });
			if (err instanceof MarkBeforeStartError) return fail(400, { errors: { date: err.message } });
			throw err;
		}
		return { markEdited: true, ...(await savedAnswer(event, form, mark?.accountId, [markId], earlier(mark?.date, date ?? mark?.date ?? ''))) };
	},

	/** H2: owner grants a Circle member full access. Owner-only (enforced by the
	 *  service); the same 404 as a bogus id for a caller who can't see the account. */
	shareMember: async ({ params, request, locals }) => {
		const user = locals.user;
		if (!user) throw redirect(303, '/signin');
		const form = await request.formData();
		const targetUserId = String(form.get('targetUserId') ?? '').trim();
		if (!targetUserId) return fail(400, { errors: { targetUserId: 'Choose a member' } });
		try {
			await shareAccount(getDb().db, { userId: user.id }, params.id, targetUserId);
		} catch (err) {
			if (err instanceof AccountNotFoundError) return fail(404, { errors: { _: 'Not found' } });
			if (err instanceof NotAccountOwnerError) return fail(403, { errors: { _: err.message } });
			if (err instanceof InvalidShareTargetError) return fail(400, { errors: { targetUserId: err.message } });
			throw err;
		}
		return { shared: true };
	},

	/** H2 RD8: the owner states the split from a date. Fields: `from` and one `share_<userId>`
	 *  percentage per holder ("50", "33.34"); the service checks the holders and the 100 % sum. */
	setShares: async ({ params, request, locals }) => {
		const user = locals.user;
		if (!user) throw redirect(303, '/signin');
		const form = await request.formData();
		const from = String(form.get('from') ?? '').trim();
		const split: Record<string, number> = {};
		for (const [key, value] of form.entries()) {
			if (!key.startsWith('share_')) continue;
			const m = /^(\d{1,3})(?:\.(\d{1,2}))?$/u.exec(String(value).trim());
			if (!m) return fail(400, { errors: { split: 'Type each share as a percentage, like 50 or 33.33' } });
			split[key.slice('share_'.length)] = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
		}
		try {
			await setAccountShares(getDb().db, { userId: user.id }, params.id, from, split);
		} catch (err) {
			if (err instanceof AccountNotFoundError) return fail(404, { errors: { _: 'Not found' } });
			if (err instanceof NotAccountOwnerError) return fail(403, { errors: { split: err.message } });
			if (err instanceof InvalidSplitError) return fail(400, { errors: { split: err.message } });
			throw err;
		}
		return { splitSaved: true };
	},

	/** H2: owner revokes a member's access (tombstone — no data is deleted). */
	unshareMember: async ({ params, request, locals }) => {
		const user = locals.user;
		if (!user) throw redirect(303, '/signin');
		const form = await request.formData();
		const targetUserId = String(form.get('targetUserId') ?? '').trim();
		try {
			await unshareAccount(getDb().db, { userId: user.id }, params.id, targetUserId);
		} catch (err) {
			if (err instanceof AccountNotFoundError) return fail(404, { errors: { _: 'Not found' } });
			if (err instanceof NotAccountOwnerError) return fail(403, { errors: { _: err.message } });
			throw err;
		}
		return { unshared: true };
	},

	/** F1 RD15: a zero balance closes at once. Money left either moves to another open account the
	 *  viewer can see (a linked transfer, C3; MC2 across currencies, `otherAmount` in the other
	 *  account's currency) or, with `mode=adjust`, is zeroed by RD11's adjustment. Neither = refused,
	 *  so a misclick can't move net worth. The transfer runs first: if the close then failed, the
	 *  account would be open at zero, never closed with money silently gone. */
	close: async ({ params, locals, request }) => {
		const user = locals.user;
		if (!user) throw redirect(303, '/signin');
		await requireVisible(user.id, params.id);
		const form = await request.formData();
		const toId = String(form.get('toId') ?? '').trim();
		const mode = String(form.get('mode') ?? '').trim();
		const db = getDb();
		// Refused while rows are dated after today, before Pay and close moves any money.
		const todayIso = formatDate(today(appClock()));
		const upcoming = closeRefusal(db, params.id, todayIso);
		if (upcoming) return fail(400, { errors: { _: upcoming } });
		const balance = accountBalance(db.sqlite, params.id, todayIso);
		if (balance !== 0 && mode !== 'adjust' && toId === '') {
			return fail(400, { errors: { closeTo: 'Choose where the balance goes' } });
		}
		if (balance !== 0 && mode !== 'adjust') {
			const otherRaw = String(form.get('otherAmount') ?? '').trim();
			let other: number | undefined;
			if (otherRaw !== '') {
				if (!/^\d+(\.\d{1,2})?$/u.test(otherRaw)) return fail(400, { errors: { closeAmount: 'Enter an amount like 1200.50' } });
				other = Math.round(Number(otherRaw) * 100);
				if (other <= 0) return fail(400, { errors: { closeAmount: 'Enter a positive amount' } });
			}
			const out = balance > 0;
			try {
				await createTransfer(db, { userId: user.id }, {
					fromId: out ? params.id : toId,
					toId: out ? toId : params.id,
					// The known side is this account's balance; the other account's amount is typed.
					amountPaise: out ? balance : (other ?? -balance),
					...(other === undefined ? {} : { toAmountPaise: out ? other : -balance }),
					date: todayIso
				});
			} catch (err) {
				if (err instanceof CurrencyMismatchError) return fail(400, { errors: { closeAmount: 'Enter the amount in the other account’s currency' } });
				if (err instanceof AccountNotFoundError || err instanceof ClosedAccountError || err instanceof SelfTransferError) {
					return fail(400, { errors: { closeTo: 'That account is not available' } });
				}
				throw err;
			}
		}
		try {
			await closeAccount(db, params.id, { actingUserId: user.id });
		} catch (err) {
			if (err instanceof UpcomingRowsError) return fail(400, { errors: { _: err.message } });
			throw err;
		}
		return { closed: true };
	},

	reopen: async ({ params, locals }) => {
		const user = locals.user;
		if (!user) throw redirect(303, '/signin');
		await requireVisible(user.id, params.id);
		try {
			await reopenAccount(getDb(), params.id, user.id);
		} catch (err) {
			if (err instanceof AccountNameConflictError) {
				return fail(400, { errors: { _: err.message } });
			}
			throw err;
		}
		return { reopened: true };
	}
};
