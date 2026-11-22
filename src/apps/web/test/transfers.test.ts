/**
 * transfers.test.ts — C3 transfers as an atomic, net-worth-invariant linked pair.
 * ============================================================================
 * Proves the double-entry invariants:
 *   - PAIR INTEGRITY: exactly two rows — outflow in `from`, inflow in `to` —
 *     MUTUALLY linked by transfer_partner_id (the mutation-b1 guard). Written in
 *     one db.transaction (the closeAccount/mergePayees atomicity pattern).
 *   - NET-WORTH INVARIANCE: the sum of the two account balances is unchanged,
 *     for asset→asset AND asset→liability (credit-card payment) — the sign
 *     convention makes this hold with no per-side branching. For Bank/CreditCard
 *     currentValue === ledger balance, so balance-sum invariance IS net-worth
 *     invariance.
 *   - GUARDS: both legs visible (a non-visible leg → AccountNotFoundError,
 *     identical to a bogus id — the mutation-b2 P0 guard); both open; same
 *     currency; no self-transfer.
 *   - DISPLAY: each leg's counterpart account name is derived (registerView).
 * ============================================================================
 */
import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb } from '../src/lib/server/db/client';
import { allStatements } from '../src/lib/server/db/migrate';
import type { Db } from '../src/lib/server/db/client';
import * as schema from '../src/lib/server/db/schema';
import { accountBalance } from '../src/lib/server/db/balances';
import { createAccount } from '../src/lib/server/accounts';
import { registerView, AccountNotFoundError, ClosedAccountError } from '../src/lib/server/transactions';
import {
  createTransfer,
  SelfTransferError,
  CurrencyMismatchError,
} from '../src/lib/server/transfers';

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
      { id: 'owner2', username: 'o2', displayName: 'Owner 2', role: 'member' },
    ])
    .run();
  return h;
}

async function acct(
  h: Db,
  opts: { owner?: string; type?: string; opening?: number; currency?: string; name?: string } = {},
): Promise<string> {
  const a = await createAccount(h, {
    ownerId: opts.owner ?? 'owner1',
    type: opts.type ?? 'bank',
    name: opts.name ?? `A-${Math.random().toString(36).slice(2, 8)}`,
    currency: opts.currency ?? 'INR',
    openingPaise: opts.opening ?? 0,
    openingDate: (opts.opening ?? 0) === 0 ? null : '2024-01-01',
  });
  return a.id;
}

describe('createTransfer: pair integrity', () => {
  it('creates exactly two mutually-linked rows (outflow in from, inflow in to)', async () => {
    const h = seed();
    const from = await acct(h, { opening: 1000_00 });
    const to = await acct(h, { opening: 0 });
    const t = await createTransfer(h, { userId: 'owner1' }, {
      fromId: from,
      toId: to,
      amountPaise: 300_00,
      date: '2024-02-01',
    });

    const fromRow = h.db.select().from(schema.transactions).where(eq(schema.transactions.id, t.fromTxId)).get()!;
    const toRow = h.db.select().from(schema.transactions).where(eq(schema.transactions.id, t.toTxId)).get()!;
    expect(fromRow.amountPaise).toBe(-300_00);
    expect(toRow.amountPaise).toBe(300_00);
    // Mutually linked — the mutation-b1 guard (drop the final link update → RED).
    expect(fromRow.transferPartnerId).toBe(toRow.id);
    expect(toRow.transferPartnerId).toBe(fromRow.id);
    // Neither carries a category.
    expect(fromRow.categoryId).toBeNull();
    expect(toRow.categoryId).toBeNull();
    expect(fromRow.enteredBy).toBe('owner1');
  });
});

describe('createTransfer: net-worth invariance (balance-sum unchanged)', () => {
  it('asset → asset leaves the total unchanged', async () => {
    const h = seed();
    const from = await acct(h, { opening: 1000_00 });
    const to = await acct(h, { opening: 500_00 });
    const before = accountBalance(h.sqlite, from) + accountBalance(h.sqlite, to);
    await createTransfer(h, { userId: 'owner1' }, { fromId: from, toId: to, amountPaise: 300_00, date: '2024-02-01' });
    expect(accountBalance(h.sqlite, from)).toBe(700_00);
    expect(accountBalance(h.sqlite, to)).toBe(800_00);
    expect(accountBalance(h.sqlite, from) + accountBalance(h.sqlite, to)).toBe(before);
  });

  it('asset → liability (credit-card payment) leaves net worth unchanged', async () => {
    const h = seed();
    const bank = await acct(h, { opening: 1000_00 });
    const card = await acct(h, { type: 'creditCard', opening: -2000_00 });
    const before = accountBalance(h.sqlite, bank) + accountBalance(h.sqlite, card); // -1000_00
    await createTransfer(h, { userId: 'owner1' }, { fromId: bank, toId: card, amountPaise: 300_00, date: '2024-02-01' });
    expect(accountBalance(h.sqlite, bank)).toBe(700_00);
    expect(accountBalance(h.sqlite, card)).toBe(-1700_00); // owes less
    expect(accountBalance(h.sqlite, bank) + accountBalance(h.sqlite, card)).toBe(before);
  });
});

describe('createTransfer: guards', () => {
  it('rejects a transfer whose DESTINATION is not visible to the actor (P0)', async () => {
    const h = seed();
    const mine = await acct(h, { owner: 'owner1', opening: 1000_00 });
    const theirs = await acct(h, { owner: 'owner2' });
    await expect(
      createTransfer(h, { userId: 'owner1' }, { fromId: mine, toId: theirs, amountPaise: 100_00, date: '2024-02-01' }),
    ).rejects.toBeInstanceOf(AccountNotFoundError);
    // Identical failure for a bogus id (no existence leak).
    await expect(
      createTransfer(h, { userId: 'owner1' }, { fromId: mine, toId: 'bogus', amountPaise: 100_00, date: '2024-02-01' }),
    ).rejects.toBeInstanceOf(AccountNotFoundError);
  });

  it('rejects a transfer whose SOURCE is not visible to the actor', async () => {
    const h = seed();
    const theirs = await acct(h, { owner: 'owner2' });
    const mine = await acct(h, { owner: 'owner1' });
    await expect(
      createTransfer(h, { userId: 'owner1' }, { fromId: theirs, toId: mine, amountPaise: 100_00, date: '2024-02-01' }),
    ).rejects.toBeInstanceOf(AccountNotFoundError);
  });

  it('rejects a self-transfer', async () => {
    const h = seed();
    const a = await acct(h, { opening: 500_00 });
    await expect(
      createTransfer(h, { userId: 'owner1' }, { fromId: a, toId: a, amountPaise: 100_00, date: '2024-02-01' }),
    ).rejects.toBeInstanceOf(SelfTransferError);
  });

  it('rejects a cross-currency pair (deferred to multi-currency)', async () => {
    const h = seed();
    const inr = await acct(h, { currency: 'INR', opening: 1000_00 });
    const usd = await acct(h, { currency: 'USD' });
    await expect(
      createTransfer(h, { userId: 'owner1' }, { fromId: inr, toId: usd, amountPaise: 100_00, date: '2024-02-01' }),
    ).rejects.toBeInstanceOf(CurrencyMismatchError);
  });

  it('rejects a transfer into a closed account', async () => {
    const h = seed();
    const open = await acct(h, { opening: 1000_00 });
    const willClose = await acct(h, { opening: 0 });
    // Close via a direct status flip (no balance to zero) to keep the test focused.
    h.db.update(schema.accounts).set({ status: 'closed' }).where(eq(schema.accounts.id, willClose)).run();
    await expect(
      createTransfer(h, { userId: 'owner1' }, { fromId: open, toId: willClose, amountPaise: 100_00, date: '2024-02-01' }),
    ).rejects.toBeInstanceOf(ClosedAccountError);
  });
});

describe('createTransfer: counterpart display', () => {
  it('each register shows the OTHER account as the counterpart', async () => {
    const h = seed();
    const from = await acct(h, { name: 'Checking', opening: 1000_00 });
    const to = await acct(h, { name: 'Savings', opening: 0 });
    await createTransfer(h, { userId: 'owner1' }, { fromId: from, toId: to, amountPaise: 250_00, date: '2024-02-01' });

    const fromView = await registerView(h, 'owner1', from);
    const toView = await registerView(h, 'owner1', to);
    expect(fromView.rows[0]!.counterpartAccountName).toBe('Savings');
    expect(toView.rows[0]!.counterpartAccountName).toBe('Checking');
  });
});
