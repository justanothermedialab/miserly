/**
 * transfer-visibility.test.ts — H4 both-legs-visible transfers (the Circle clause).
 * ============================================================================
 * H4 adds ONE clause to C3: a transfer is accepted only if BOTH legs are in the
 * actor's visible set (owned ∪ member-of). You can never move money into or out
 * of an account you can't see — so you can never touch another member's PRIVATE
 * account. Settle-up runs through a SHARED account both parties can see. This
 * rule is already enforced by transfers.ts (`requireOpenVisible`); this suite is
 * the H4 proof that it holds end-to-end and rejects server-side, not UI-only.
 * ============================================================================
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createDb } from '../src/lib/server/db/client';
import { allStatements } from '../src/lib/server/db/migrate';
import type { Db } from '../src/lib/server/db/client';
import * as schema from '../src/lib/server/db/schema';
import { createTransfer } from '../src/lib/server/transfers';
import { AccountNotFoundError } from '../src/lib/server/transactions';
import { accountBalance } from '../src/lib/server/db/balances';

let handle: Db | undefined;
afterEach(() => {
	handle?.sqlite.close();
	handle = undefined;
});

function seed(): Db {
	const h = createDb(':memory:');
	handle = h;
	for (const stmt of allStatements()) h.sqlite.exec(stmt);
	const { db } = h;

	db.insert(schema.users)
		.values([
			{ id: 'A', displayName: 'A', username: 'a', role: 'admin' },
			{ id: 'B', displayName: 'B', username: 'b', role: 'member' },
		])
		.run();

	db.insert(schema.accounts)
		.values([
			{ id: 'A_acct', ownerId: 'A', name: 'A salary', type: 'bank', currency: 'INR', openingPaise: 100_000_00 },
			{ id: 'B_acct', ownerId: 'B', name: 'B salary', type: 'bank', currency: 'INR', openingPaise: 100_000_00 },
			{ id: 'Pool', ownerId: 'A', name: 'Flat pool', type: 'bank', currency: 'INR', openingPaise: 0 },
		])
		.run();

	// The Pool is shared: A owns it, B is a member. Both can see it.
	db.insert(schema.accountMembers).values([{ accountId: 'Pool', userId: 'B' }]).run();

	return h;
}

const D = '2026-08-15';

describe('H4 — transfers limited to the actor visible set', () => {
	it('settle-up through a SHARED account works for both members', async () => {
		const h = seed();
		// A contributes to the pool (A owns both legs).
		await createTransfer(h, { userId: 'A' }, { fromId: 'A_acct', toId: 'Pool', amountPaise: 20_000_00, date: D });
		// B contributes to the pool (B owns B_acct, is a member of Pool → both visible).
		await createTransfer(h, { userId: 'B' }, { fromId: 'B_acct', toId: 'Pool', amountPaise: 30_000_00, date: D });

		expect(accountBalance(h.sqlite, 'Pool')).toBe(50_000_00);
		expect(accountBalance(h.sqlite, 'A_acct')).toBe(80_000_00);
		expect(accountBalance(h.sqlite, 'B_acct')).toBe(70_000_00);
	});

	it('A cannot fund B’s PRIVATE account (a leg outside A’s visible set) — 404, not a silent move', async () => {
		const h = seed();
		await expect(
			createTransfer(h, { userId: 'A' }, { fromId: 'A_acct', toId: 'B_acct', amountPaise: 10_000_00, date: D }),
		).rejects.toBeInstanceOf(AccountNotFoundError);
		// Nothing moved.
		expect(accountBalance(h.sqlite, 'A_acct')).toBe(100_000_00);
		expect(accountBalance(h.sqlite, 'B_acct')).toBe(100_000_00);
	});

	it('B cannot pull from an account it cannot see (source leg outside visible set)', async () => {
		const h = seed();
		await expect(
			createTransfer(h, { userId: 'B' }, { fromId: 'A_acct', toId: 'Pool', amountPaise: 10_000_00, date: D }),
		).rejects.toBeInstanceOf(AccountNotFoundError);
	});

	it('a crafted request to a non-existent account id is rejected identically', async () => {
		const h = seed();
		await expect(
			createTransfer(h, { userId: 'A' }, { fromId: 'A_acct', toId: 'ghost-acct', amountPaise: 1_00, date: D }),
		).rejects.toBeInstanceOf(AccountNotFoundError);
	});
});
