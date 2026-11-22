/**
 * transfers.ts — C3 transfers: the double-entry heart, as an ATOMIC linked pair.
 * ============================================================================
 * A transfer moves the user's own money between two accounts. It is NOT spending
 * and NOT income, and net worth is INVARIANT under it. The model (architecture
 * §4, C3) is TWO linked rows: an outflow in the source, an inflow in the
 * destination, mutually referenced by `transfer_partner_id`. Both are written in
 * ONE better-sqlite3 transaction, so it is impossible to observe an orphaned half
 * — the Firefly transfer-corruption bug class we structurally refuse to repeat.
 *
 * Net-worth invariance falls out of the sign convention (contract.ts): the source
 * gets `-amount`, the destination gets `+amount`, and net worth = Σ currentValue,
 * so the two cancel — for asset→asset, asset→liability (card payment reduces the
 * owed balance), and liability→asset alike, with NO per-side branching here.
 *
 * Guards (all server-side, defense in depth — pickers filter too but are never
 * the gate): from ≠ to; BOTH legs in the actor's visible set (a leg outside it
 * fails with the SAME AccountNotFoundError as a bogus id — you can never move
 * money into/out of an account you can't see); both OPEN; SAME currency in C3
 * (a mismatch is blocked with a "coming with multi-currency" message, not a
 * silent 1:1 — MC2/M9). A transfer between a spending account (bank, card) and a holding may
 * carry a category, on its spending-side leg (`transferTakesCategory`); any other carries none.
 * Each leg stamps
 * `entered_by`. The counterpart "payee" shown in each register is DERIVED from
 * the partner's account (registerView's join), never a real payee row — Actual's
 * transfer-as-payee UX without its shadow-payee data.
 *
 * The self-FK `fk_tx_transfer_partner` is enforced (`foreign_keys = ON`); the
 * insert order (A partner=NULL → B partner=A → A partner=B) satisfies it at every
 * step. R8: async.
 * ============================================================================
 */
import { isRealDate } from '../dates';
import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import * as schema from './db/schema';
import type { Db } from './db/client';
import { isAccountVisibleTo } from './visibility';
import {
  nextSequenceOn,
  transferTakesCategory,
  isSpendingType,
  AccountNotFoundError,
  ClosedAccountError,
  InvalidCategoryError,
  TransferCategoryError,
  requireHeldDate,
} from './transactions';
import { reconcileMarks } from './marks';
import { linkageRateFrom } from './rates';
import { isPickableCategory } from './category-rules';

/** Thrown when source and destination are the same account (no self-transfer). */
export class SelfTransferError extends Error {
  constructor() {
    super('Choose two different accounts');
    this.name = 'SelfTransferError';
  }
}

/**
 * Thrown when a cross-currency transfer is attempted WITHOUT the FX detail it
 * needs (a rate or a to-amount) — e.g. the inline register "Transfer → account"
 * path, which collects a single amount only. The explicit transfer form (MC2)
 * supplies the rate/to-amount and never hits this. NOT a silent 1:1 (the Firefly
 * trap) — a different-currency transfer is refused until the second amount exists.
 */
export class CurrencyMismatchError extends Error {
  constructor() {
    super('A transfer between currencies needs an exchange rate. Use the transfer form.');
    this.name = 'CurrencyMismatchError';
  }
}

/** Thrown when BOTH a rate and a to-amount are supplied (exactly one is entered). */
export class AmbiguousFxInputError extends Error {
  constructor() {
    super('Enter either the exchange rate or the received amount, not both');
    this.name = 'AmbiguousFxInputError';
  }
}

export interface CreateTransferInput {
  readonly fromId: string;
  readonly toId: string;
  /** SOURCE-side magnitude in POSITIVE integer paise (native to `fromId`). */
  readonly amountPaise: number;
  readonly date: string;
  readonly notes?: string | null;
  /** A category, for a transfer between a spending account and a holding (else
   *  TransferCategoryError); stored on the spending-side leg. */
  readonly categoryId?: string | null;
  /**
   * MC2 (cross-currency only): the DESTINATION-side received amount in positive
   * integer paise (native to `toId`). Provide EITHER this or `rate` — the other
   * is derived. Ignored when both accounts share a currency.
   */
  readonly toAmountPaise?: number;
  /**
   * MC2 (cross-currency only): the linkage rate as a scaled integer
   * `scaled / 10^scale` destination-per-1-source. Provide EITHER this or
   * `toAmountPaise`. Ignored when both accounts share a currency.
   */
  readonly rate?: { readonly scaled: number; readonly scale: number };
}

/** Round `num / den` (both non-negative) half-away-from-zero. */
function roundDivPos(num: bigint, den: bigint): bigint {
  const q = num / den;
  const r = num % den;
  return r * 2n >= den ? q + 1n : q;
}

/**
 * The frozen linkage rate + the derived destination amount for a cross-currency
 * transfer. Exactly one of {rate, toAmount} is user-entered; the other is
 * computed here in BigInt (no float drift), matching GnuCash's radio model.
 */
function resolveFx(
  amountOut: number,
  input: CreateTransferInput,
): { toAmount: number; scaled: number; scale: number } {
  const hasRate = input.rate !== undefined;
  const hasToAmount = input.toAmountPaise !== undefined;
  if (hasRate && hasToAmount) throw new AmbiguousFxInputError();
  if (!hasRate && !hasToAmount) throw new CurrencyMismatchError();

  if (hasRate) {
    const { scaled, scale } = input.rate!;
    if (!Number.isSafeInteger(scaled) || scaled <= 0 || !Number.isInteger(scale) || scale < 0) {
      throw new Error('createTransfer: rate must be a positive scaled integer');
    }
    // toAmount = amountOut × scaled / 10^scale
    const toAmount = Number(roundDivPos(BigInt(amountOut) * BigInt(scaled), 10n ** BigInt(scale)));
    if (!Number.isSafeInteger(toAmount) || toAmount <= 0) {
      throw new Error('createTransfer: computed to-amount is not a positive safe integer');
    }
    return { toAmount, scaled, scale };
  }

  const toAmount = input.toAmountPaise!;
  if (!Number.isSafeInteger(toAmount) || toAmount <= 0) {
    throw new Error('createTransfer: toAmountPaise must be a positive safe integer');
  }
  // rate = toAmount / amountOut (both paise, so the ×100s cancel — destination-per-1-source in
  // currency units), the one rule an edit uses too.
  return { toAmount, ...linkageRateFrom(amountOut, toAmount) };
}

export interface CreatedTransfer {
  readonly fromTxId: string;
  readonly toTxId: string;
  readonly amountPaise: number;
  readonly date: string;
}

/**
 * Load an account for a transfer leg, enforcing visibility (→ AccountNotFoundError,
 * identical to a bogus id) and open status (→ ClosedAccountError). Returns the
 * currency needed for the same-currency check.
 */
async function requireOpenVisible(
  db: Db['db'],
  userId: string,
  accountId: string,
): Promise<{ currency: string; type: string }> {
  if (!(await isAccountVisibleTo(db, userId, accountId))) throw new AccountNotFoundError();
  const account = db
    .select({ status: schema.accounts.status, currency: schema.accounts.currency, type: schema.accounts.type })
    .from(schema.accounts)
    .where(and(eq(schema.accounts.id, accountId), isNull(schema.accounts.deletedAt)))
    .get();
  if (!account) throw new AccountNotFoundError();
  if (account.status !== 'open') throw new ClosedAccountError();
  return { currency: account.currency, type: account.type };
}

/**
 * Create a transfer as an atomic linked pair. Both legs are validated (visible +
 * open), then written — outflow in `from`, inflow in `to`, cross-linked — inside
 * ONE transaction. For a SAME-currency transfer the two legs are equal-and-
 * opposite (C3). For a CROSS-currency transfer (MC2) the destination leg carries
 * the received amount in ITS OWN currency (source −out, dest +to), and the frozen
 * linkage rate is stored on both legs; the two legs deliberately do NOT net to
 * zero in base (the honest realized-FX effect falls out of derivation). Returns
 * both row ids.
 */
export async function createTransfer(
  database: Db,
  actor: { readonly userId: string },
  input: CreateTransferInput,
): Promise<CreatedTransfer> {
  const { db } = database;

  if (input.fromId === input.toId) throw new SelfTransferError();
  if (!isRealDate(input.date)) {
    throw new Error(`createTransfer: date must be a real day as 'YYYY-MM-DD', got '${input.date}'`);
  }
  if (!Number.isSafeInteger(input.amountPaise) || input.amountPaise <= 0) {
    throw new Error('createTransfer: amountPaise must be a positive safe integer');
  }

  const from = await requireOpenVisible(db, actor.userId, input.fromId);
  const to = await requireOpenVisible(db, actor.userId, input.toId);
  // C5 C: both legs on a date the actor holds each account (a member, from the day they joined).
  requireHeldDate(db, actor.userId, input.fromId, input.date);
  requireHeldDate(db, actor.userId, input.toId, input.date);

  // C3: a category only on a spending ↔ holding pair, kept on the spending-side leg.
  const categoryId = input.categoryId ?? null;
  if (categoryId !== null) {
    if (!transferTakesCategory(from.type, to.type)) throw new TransferCategoryError();
    if (!isPickableCategory(db, categoryId)) throw new InvalidCategoryError();
  }
  const fromIsSpending = isSpendingType(from.type);

  // Same currency → equal-and-opposite legs, no linkage rate. Different currency
  // → resolve the received amount + frozen linkage rate from the FX input (rate
  // OR to-amount; neither ⇒ CurrencyMismatchError, never a silent 1:1).
  const crossCurrency = from.currency !== to.currency;
  const fx = crossCurrency
    ? resolveFx(input.amountPaise, input)
    : { toAmount: input.amountPaise, scaled: null as number | null, scale: null as number | null };

  const fromTxId = randomUUID();
  const toTxId = randomUUID();
  const notes = input.notes?.trim() ? input.notes.trim() : null;
  const nowIso = new Date().toISOString();

  db.transaction((tx) => {
    const txDb = tx as unknown as Db['db'];
    const fromSeq = nextSequenceOn(txDb, input.fromId, input.date);
    const toSeq = nextSequenceOn(txDb, input.toId, input.date);

    // A: source outflow, partner NULL for now (B does not exist yet).
    tx.insert(schema.transactions)
      .values({
        id: fromTxId,
        accountId: input.fromId,
        date: input.date,
        sequence: fromSeq,
        amountPaise: -input.amountPaise,
        transferPartnerId: null,
        enteredBy: actor.userId,
        kind: 'ordinary',
        notes,
        categoryId: fromIsSpending ? categoryId : null,
        fxRateScaled: fx.scaled,
        fxScale: fx.scale,
        createdAt: nowIso,
        updatedAt: nowIso,
      })
      .run();

    // B: destination inflow (its OWN native amount), partner = A → FK satisfied.
    tx.insert(schema.transactions)
      .values({
        id: toTxId,
        accountId: input.toId,
        date: input.date,
        sequence: toSeq,
        amountPaise: fx.toAmount,
        transferPartnerId: fromTxId,
        enteredBy: actor.userId,
        kind: 'ordinary',
        notes,
        categoryId: fromIsSpending ? null : categoryId,
        fxRateScaled: fx.scaled,
        fxScale: fx.scale,
        createdAt: nowIso,
        updatedAt: nowIso,
      })
      .run();

    // Close the mutual link: A.partner = B (B now exists → FK satisfied).
    tx.update(schema.transactions)
      .set({ transferPartnerId: toTxId, updatedAt: nowIso })
      .where(eq(schema.transactions.id, fromTxId))
      .run();

    // A transfer INTO a holding is a contribution; a back-dated one shifts a
    // later mark's before-value → re-derive both accounts' marks (S3 RD1).
    reconcileMarks(txDb, input.fromId, nowIso);
    reconcileMarks(txDb, input.toId, nowIso);
  });

  return { fromTxId, toTxId, amountPaise: input.amountPaise, date: input.date };
}
