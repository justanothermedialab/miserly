/**
 * inline-transfer.ts — a transfer typed as a payee: "Transfer → <account name>" (C3's inline path,
 * Actual's model). Shared by the register's entry row and Quick Add (Quick
 * Add works like the register, no Expense / Income / Transfer tabs), so the two can't diverge (C2).
 * Direction follows the column used: a withdrawal moves money OUT of `selfId` into the named account,
 * a deposit moves it IN from there. Across currencies the other account's amount comes as `received`
 * (MC2 / DEV-41).
 * The account is the picked line's id (`transferAccountId`), never the text; text typed by
 * hand that names two accounts is refused (`resolveTransferTarget`).
 */
import { inArray } from 'drizzle-orm';
import type { Db } from '$lib/server/db/client';
import { listAccounts, type AccountSummary } from '$lib/server/accounts';
import { users } from '$lib/server/db/schema';
import {
	ClosedAccountError,
	InvalidCategoryError,
	TransferCategoryError,
	transferTakesCategory
} from '$lib/server/transactions';
import { createTransfer, CurrencyMismatchError, SelfTransferError } from '$lib/server/transfers';
import { TRANSFER_PREFIX, accountLabel, namedBy, sharedNames, type TransferTarget } from '$lib/transfer-targets';
import { MODULE_PROFILES } from '$lib/modules';

export { TRANSFER_PREFIX };

export const isInlineTransfer = (payeeName: string | null | undefined): payeeName is string =>
	!!payeeName && payeeName.startsWith(TRANSFER_PREFIX);

export type ServerTransferTarget = TransferTarget & { readonly account: AccountSummary };

const ORDER = new Map(MODULE_PROFILES.map((p, i) => [p.type, i]));

/** The viewer's open accounts as payee lists offer them (C8 labels: "HDFC (Bob's)"; a
 *  name another account the viewer sees has too, open or closed, adds the section), in the
 *  sidebar's order: by section, then name A to Z (the account lists and the close dialog read
 *  them as they came from the database, "SBI" before "HDFC"). */
export async function transferTargetsFor(db: Db, userId: string): Promise<ServerTransferTarget[]> {
	const all = await listAccounts(db, userId, { includeClosed: true });
	const shared = sharedNames(all);
	const open = all
		.filter((a) => a.status === 'open')
		.sort((a, b) => (ORDER.get(a.type) ?? 99) - (ORDER.get(b.type) ?? 99) || a.name.localeCompare(b.name));
	const others = [...new Set(open.map((a) => a.ownerId).filter((id) => id !== userId))];
	const names = new Map(
		others.length === 0
			? []
			: db.db.select({ id: users.id, name: users.displayName }).from(users).where(inArray(users.id, others)).all().map((u) => [u.id, u.name])
	);
	return open.map((a) => ({
		id: a.id,
		name: a.name,
		label: accountLabel(a, names.get(a.ownerId) ?? null, userId, shared),
		listLabel: accountLabel(a, names.get(a.ownerId) ?? null, userId),
		type: a.type,
		currency: a.currency,
		account: a
	}));
}

/**
 * The account a "Transfer → X" payee moves money to or from, other than `selfId`: the posted id
 * when there is one, else the one account the text names. A string is the payee field's error.
 */
export function resolveTransferTarget(
	targets: readonly ServerTransferTarget[],
	selfId: string,
	payeeName: string,
	accountId: string | null | undefined
): ServerTransferTarget | string {
	const pool = targets.filter((t) => t.id !== selfId);
	if (accountId) return pool.find((t) => t.id === accountId) ?? 'No such account to transfer to';
	const hits = namedBy(pool, payeeName);
	if (hits.length === 1) return hits[0]!;
	const text = payeeName.slice(TRANSFER_PREFIX.length).trim();
	return hits.length === 0 ? 'No such account to transfer to' : `Two accounts are called ${text}: pick one from the list`;
}

export interface InlineTransferInput {
	payeeName: string;
	/** The picked line's account id; empty when the text was typed by hand. */
	transferAccountId?: string | null;
	amountPaise: number; // signed: < 0 a withdrawal from selfId, > 0 a deposit into it
	date: string;
	notes: string | null;
	categoryId: string | null;
	received: string; // the other account's amount, as typed; only read across currencies
}

/** Field errors for the form, or null when the pair was created. Not-found errors are rethrown for
 *  the caller to map (the register 404s, Quick Add names the field). */
export async function addInlineTransfer(
	db: Db,
	userId: string,
	selfId: string,
	input: InlineTransferInput
): Promise<Record<string, string> | null> {
	const targets = await transferTargetsFor(db, userId);
	const self = targets.find((t) => t.id === selfId)?.account;
	const resolved = resolveTransferTarget(targets, selfId, input.payeeName, input.transferAccountId);
	if (typeof resolved === 'string') return { payee: resolved };
	const target = resolved.account;
	const magnitude = Math.abs(input.amountPaise);
	const outflow = input.amountPaise < 0;

	const fx: { toAmountPaise?: number } = {};
	let sourceAmountPaise = magnitude;
	if (self && target.currency !== self.currency) {
		const receivedInput = input.received.trim();
		if (!/^\d+(\.\d{1,2})?$/u.test(receivedInput)) return { received: `Enter the amount in ${target.currency}` };
		const receivedPaise = Math.round(Number(receivedInput) * 100);
		if (!Number.isSafeInteger(receivedPaise) || receivedPaise <= 0) return { received: 'Enter a positive amount' };
		if (outflow) {
			fx.toAmountPaise = receivedPaise; // self (source) → target (destination)
		} else {
			sourceAmountPaise = receivedPaise; // target (source) → self (destination)
			fx.toAmountPaise = magnitude;
		}
	}
	try {
		await createTransfer(db, { userId }, {
			fromId: outflow ? selfId : target.id,
			toId: outflow ? target.id : selfId,
			amountPaise: sourceAmountPaise,
			date: input.date,
			notes: input.notes,
			// A category is kept when the pair takes one (bank or card ↔ a holding, item 2.5) and dropped
			// otherwise, as Actual shows none on such a row.
			categoryId: self && transferTakesCategory(self.type, target.type) ? input.categoryId : null,
			...fx
		});
		return null;
	} catch (err) {
		if (err instanceof ClosedAccountError || err instanceof CurrencyMismatchError) return { _: err.message };
		if (err instanceof SelfTransferError) return { payee: err.message };
		if (err instanceof InvalidCategoryError || err instanceof TransferCategoryError) return { category: err.message };
		throw err;
	}
}
