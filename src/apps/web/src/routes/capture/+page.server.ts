/**
 * capture — the C2/C3 global action endpoint. The quick-add overlay (in the
 * layout, reachable from every screen) posts here; these actions call the SAME
 * `createTransaction` / `createTransfer` services as the in-register path (C1),
 * so a row logged from the overlay is indistinguishable from one logged in the
 * register (C2 failure case: divergence between the two = a defect). There is no
 * page to render — a direct GET redirects home.
 */
import { isRealDate } from '$lib/dates';
import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { getDb } from '$lib/server/db/instance';
import {
	createTransaction,
	AccountNotFoundError,
	ClosedAccountError,
	InvalidCategoryError,
	TransferCategoryError
} from '$lib/server/transactions';
import {
	createTransfer,
	SelfTransferError,
	CurrencyMismatchError,
	AmbiguousFxInputError
} from '$lib/server/transfers';
import { parseForm, transactionCreateSchema } from '$lib/server/validation';
import { parseRateToScaled } from '$lib/server/rates';
import { textProblem } from '$lib/text-limits';
import { isInlineTransfer, addInlineTransfer } from '$lib/server/inline-transfer';

export const load: PageServerLoad = () => {
	// Not a real page — the overlay lives in the layout. Land somewhere useful.
	throw redirect(303, '/');
};

export const actions: Actions = {
	/** C2: add a transaction to a chosen account (shared create path with C1). */
	addTransaction: async ({ request, locals }) => {
		const user = locals.user;
		if (!user) throw redirect(303, '/signin');

		const form = await request.formData();
		const accountId = String(form.get('account') ?? '').trim();
		if (accountId === '') {
			return fail(400, { errors: { account: 'Choose an account' } });
		}

		const parsed = parseForm(transactionCreateSchema, form);
		if (!parsed.success) return fail(400, { errors: parsed.errors });

		// "Transfer → <account>" in Payee makes a linked pair, as in the register's entry row (owner
		// Quick Add works like the register).
		if (isInlineTransfer(parsed.data.payeeName)) {
			try {
				const errors = await addInlineTransfer(getDb(), user.id, accountId, {
					payeeName: parsed.data.payeeName,
					transferAccountId: String(form.get('transferAccountId') ?? ''),
					amountPaise: parsed.data.amountPaise,
					date: parsed.data.date,
					notes: parsed.data.notes,
					categoryId: parsed.data.categoryId,
					received: String(form.get('received') ?? '')
				});
				if (errors) return fail(400, { errors });
				return { added: true, transfer: true };
			} catch (err) {
				if (err instanceof AccountNotFoundError)
					return fail(400, { errors: { account: 'That account is not available' } });
				throw err;
			}
		}

		try {
			const tx = await createTransaction(
				getDb(),
				{ userId: user.id },
				{
					accountId,
					date: parsed.data.date,
					amountPaise: parsed.data.amountPaise,
					payeeName: parsed.data.payeeName,
					categoryId: parsed.data.categoryId,
					notes: parsed.data.notes
				}
			);
			return { added: true, txId: tx.id };
		} catch (err) {
			// A not-found/closed account from the overlay is a user-facing field
			// error (the picker could be stale), not a 404 page.
			if (err instanceof AccountNotFoundError)
				return fail(400, { errors: { account: 'That account is not available' } });
			if (err instanceof ClosedAccountError)
				return fail(400, { errors: { account: err.message } });
			if (err instanceof InvalidCategoryError)
				return fail(400, { errors: { category: err.message } });
			throw err;
		}
	},

	/** C3: create a same-currency transfer as an atomic linked pair. */
	addTransfer: async ({ request, locals }) => {
		const user = locals.user;
		if (!user) throw redirect(303, '/signin');

		const form = await request.formData();
		const fromId = String(form.get('from') ?? '').trim();
		const toId = String(form.get('to') ?? '').trim();
		const date = String(form.get('date') ?? '').trim();
		const amountRupees = String(form.get('amount') ?? '').trim();
		const notes = String(form.get('notes') ?? '').trim() || null;
		// Only sent when the pair takes a category (bank or card ↔ a holding, item 2.5).
		const categoryId = String(form.get('category') ?? '').trim() || null;
		// MC2 cross-currency detail (only sent by the overlay when the two accounts
		// differ in currency): EITHER a linkage rate OR the received amount.
		const rateInput = String(form.get('rate') ?? '').trim();
		const receivedInput = String(form.get('received') ?? '').trim();

		const errors: Record<string, string> = {};
		if (fromId === '') errors.from = 'Choose a source account';
		if (toId === '') errors.to = 'Choose a destination account';
		if (!isRealDate(date)) errors.date = 'Enter a valid date';
		if (!/^\d+(\.\d{1,2})?$/u.test(amountRupees)) errors.amount = 'Enter an amount like 500';
		const notesProblem = notes === null ? null : textProblem(notes, 'note');
		if (notesProblem) errors.notes = notesProblem;
		if (Object.keys(errors).length > 0) return fail(400, { errors });

		const amountPaise = Math.round(Number(amountRupees) * 100);
		if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0) {
			return fail(400, { errors: { amount: 'Enter a positive amount' } });
		}

		// Build the optional FX detail. createTransfer requires exactly one of
		// {rate, toAmountPaise} for a cross-currency pair and rejects both (it never
		// falls back to a silent 1:1). Same-currency transfers send neither.
		const fx: { rate?: { scaled: number; scale: number }; toAmountPaise?: number } = {};
		if (rateInput !== '') {
			if (!/^\d+(\.\d+)?$/u.test(rateInput))
				return fail(400, { errors: { rate: 'Enter a rate like 83.10' } });
			// A rate of 0 or with too many decimals is the parser's plain-words error, under Rate (it
			// threw past the action and opened the error page).
			try {
				fx.rate = parseRateToScaled(rateInput);
			} catch (err) {
				return fail(400, { errors: { rate: err instanceof Error ? err.message : 'Enter a rate like 83.10' } });
			}
		} else if (receivedInput !== '') {
			if (!/^\d+(\.\d{1,2})?$/u.test(receivedInput))
				return fail(400, { errors: { received: 'Enter a received amount' } });
			const toAmountPaise = Math.round(Number(receivedInput) * 100);
			if (!Number.isSafeInteger(toAmountPaise) || toAmountPaise <= 0)
				return fail(400, { errors: { received: 'Enter a positive amount' } });
			fx.toAmountPaise = toAmountPaise;
		}

		try {
			await createTransfer(getDb(), { userId: user.id }, { fromId, toId, amountPaise, date, notes, categoryId, ...fx });
			return { transferred: true };
		} catch (err) {
			if (err instanceof AccountNotFoundError)
				return fail(400, { errors: { _: 'One of those accounts is not available' } });
			if (err instanceof ClosedAccountError)
				return fail(400, { errors: { _: 'Both accounts must be open' } });
			if (err instanceof SelfTransferError) return fail(400, { errors: { to: err.message } });
			if (err instanceof AmbiguousFxInputError) return fail(400, { errors: { _: err.message } });
			if (err instanceof CurrencyMismatchError)
				return fail(400, { errors: { _: err.message } });
			if (err instanceof InvalidCategoryError || err instanceof TransferCategoryError)
				return fail(400, { errors: { category: err.message } });
			throw err;
		}
	}
};
