/**
 * actual-import.ts — Actual Budget's export into Miserly: the preview, the import, Undo (F4).
 * ============================================================================
 * The mapping (story F4):
 *   - one account per Actual account, typed by the person ("Add as", guessed from the name);
 *     the opening is Actual's first "Starting Balance" row, dated with the account's EARLIEST row
 *     (a row can sit before the starting balance: the sample's PPF interest of 31 Mar);
 *   - a transfer comes in as our two linked rows (C3), its category kept on the spending-side leg
 *     when the pair takes one (C3 RD5), dropped otherwise; a transfer whose other account isn't
 *     brought over comes in as a plain row, its payee that account's name, under Transfer to Self
 *     (a group reports leave out) unless Actual gave it a category;
 *   - a split comes in as its parts (we dropped splits), the parent's note and payee on each;
 *   - Actual's "Reconciliation balance adjustment" is a value update (S3 mark) on its own date on a
 *     holding, a Balance adjustment row elsewhere;
 *   - plain deposits on a holding (rows in that aren't transfers) count as return, as Actual left
 *     them, or as money put in (filed under the profile's `importDeposits`, else Investments,
 *     Other), per holding, defaulted by type (EPF and EPS money put in); a plain withdrawal on a
 *     holding whose deposits are money put in is money taken out, the same category;
 *   - Actual's income group comes in as Income, the others as Spending, or Investments where the
 *     person picks it for a group used on transfers into holdings (C2); a new Interest or Dividends
 *     in the income group counts as return (as 0012 did); names already here are reused inside
 *     the same kind.
 *
 * The service rules hold: accounts are made open, written, then closed (a closed
 * Actual account with money or rows after today comes in open, flagged); a start date after today
 * is refused; names differ per owner and type (C8). Everything is one database transaction: a
 * refusal leaves nothing behind. The importer owns every account, private (H2); `entered_by` is
 * them. The log (`imports`, `import_items`, migration 0015) keeps Actual's ids: a later import of a
 * newer export adds only rows whose id isn't here, and Undo removes exactly what an import added.
 * ============================================================================
 */
import { randomUUID } from 'node:crypto';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { formatDate, getModule, hasModule, Money, parseDate, today, type Transaction } from '@miserly/core';
import { appClock } from '../clock';
import * as schema from '../db/schema';
import type { Db } from '../db/client';
import { accountBalance } from '../db/balances';
import { openNameTaken, upcomingRowsMessage } from '../accounts';
import { isSpendingType, nextSequenceOn, transferTakesCategory } from '../transactions';
import { isMarkableType, reconcileMarks } from '../marks';
import { BALANCE_ADJUSTMENT_CATEGORY_ID } from '../seed';
import { baseCurrency } from '../settings';
import { normalizeName } from '../names';
import { nextSwatch } from '../../swatches';
import { moduleProfile, profileEntries, profilesByGroup } from '../../modules';
import { epsOfKey, parseEpsOf } from '../../import-eps';
import type { ActualAccount, ActualBudget, ActualRow } from './actual-read';

type AppDb = Db['db'];
export type DepositsAre = 'return' | 'moneyIn';

/** The category a left-out transfer comes in under (O24, the owner's name, 2026-11-12). */
export const TRANSFER_TO_SELF = 'Transfer to Self';
type GroupKind = 'income' | 'spending' | 'neutral' | 'investments';

/** Refused before anything is written; the message is the person's. */
export class ImportRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportRefusedError';
  }
}

// ── "Add as": the Add account list's entries ─────────────────────────────────

export interface AddAsOption {
  readonly key: string;
  readonly type: string;
  readonly label: string;
  readonly group: string;
  readonly preset: Readonly<Record<string, string>>;
  /** A holding on the Asset side: the preview shows its Invested. */
  readonly assetHolding: boolean;
  /** A holding: plain deposits on it can count as money put in. */
  readonly holding: boolean;
  /** Plain deposits count as money put in by default (the profile's `importDeposits`). */
  readonly depositsMoneyIn: boolean;
}

/** The Add account list (the same entries, in the same groups): Home loan, PPF, EPF, SGB and all. */
export function addAsOptions(): AddAsOption[] {
  return profilesByGroup().flatMap(({ group, profiles }) =>
    profiles
      .filter((p) => !p.comingSoon && hasModule(p.type))
      .flatMap((p) =>
        profileEntries(p).map((e, i) => ({
          key: `${p.type}:${i}`,
          type: p.type,
          label: e.label,
          group,
          preset: e.preset,
          assetHolding: p.sectionShape === 'holding' && getModule(p.type).metadata.side === 'Asset',
          holding: p.sectionShape === 'holding',
          depositsMoneyIn: p.importDeposits !== undefined,
        })),
      ),
  );
}

/** The template for an "EPS of …" entry (F4 RD9): the EPS profile's, keyed and named per EPF by
 *  `epsOfOptions` (`$lib/import-eps`). */
export function epsOptionTemplate(): AddAsOption {
  const p = moduleProfile('eps')!;
  return {
    key: 'eps',
    type: p.type,
    label: p.label,
    group: p.group,
    preset: {},
    assetHolding: p.sectionShape === 'holding' && getModule(p.type).metadata.side === 'Asset',
    holding: p.sectionShape === 'holding',
    depositsMoneyIn: p.importDeposits !== undefined,
  };
}

/** An off-budget account named like an EPS ("EPS", "Employee pension"). */
const looksLikeEps = (a: ActualAccount) => a.offBudget && /\beps\b|employees?['’]? pension/u.test(` ${a.name.toLowerCase()} `);

/**
 * Every account's guessed Add as: an account already here keeps its type; an account named like an
 * EPS is "EPS of" the file's EPF when the file has exactly one (F4 RD9); the rest by `guessAddAs`.
 */
function guesses(budget: ActualBudget, facts: Map<string, AccountFacts>, existing: Map<string, { id: string; type: string }>): Map<string, string> {
  const out = new Map(
    budget.accounts.map((a) => {
      const here = existing.get(a.id);
      return [a.id, here ? `${here.type}:0` : guessAddAs(a, facts.get(a.id)!.balancePaise)];
    }),
  );
  const epfs = budget.accounts.filter((a) => out.get(a.id) === 'epf:0' && !looksLikeEps(a));
  if (epfs.length === 1) {
    const epf = epfs[0]!;
    const here = existing.get(epf.id);
    for (const a of budget.accounts) {
      if (a !== epf && !existing.has(a.id) && looksLikeEps(a)) out.set(a.id, here ? epsOfKey({ here: here.id }) : epsOfKey({ actual: epf.id }));
    }
  }
  return out;
}

/** A holding on the Asset side (a fund, PPF, EPF, its EPS): where Net invested is counted. */
function isAssetHoldingType(type: string): boolean {
  return moduleProfile(type)?.sectionShape === 'holding' && hasModule(type) && getModule(type).metadata.side === 'Asset';
}
/** The type an Add as key makes ("EPS of" makes an EPS). */
const typeOfKey = (key: string) => (parseEpsOf(key) ? 'eps' : key.split(':')[0]!);

/**
 * The Actual groups whose categories sit only on transfers into holdings (O23): every row
 * filed under one of its categories is a transfer whose leg in an asset holding is money in. A new
 * such group defaults to Investments in the preview (still editable); every other new group keeps
 * Spending, as in Actual. `assetHolding` says, per Actual account, whether it lands as one.
 */
function investmentOnlyGroups(budget: ActualBudget, assetHolding: (actualAccountId: string) => boolean): Set<string> {
  const rowById = new Map(budget.rows.map((r) => [r.id, r]));
  const catGroup = new Map(budget.categories.map((c) => [c.id, c.groupId]));
  const yes = new Set<string>();
  const no = new Set<string>();
  for (const r of budget.rows) {
    if (r.starting || !r.categoryId) continue;
    const g = catGroup.get(r.categoryId);
    if (!g) continue;
    const partner = r.transferId ? rowById.get(r.transferId) : undefined;
    const into = partner !== undefined && [r, partner].some((leg) => leg.amount > 0 && assetHolding(leg.accountId));
    (into ? yes : no).add(g);
  }
  return new Set([...yes].filter((g) => !no.has(g)));
}

/** The guessed entry for an Actual account (Actual has no account types; the person checks each). */
export function guessAddAs(a: ActualAccount, balancePaise: number): string {
  const n = ` ${a.name.toLowerCase()} `;
  const has = (re: RegExp) => re.test(n);
  if (!a.offBudget) return has(/card/u) || balancePaise < 0 ? 'creditCard:0' : 'bank:0';
  if (has(/\bepf\b|provident/u)) return 'epf:0';
  if (has(/\bppf\b/u)) return 'ppf:0';
  if (has(/\bsgb\b|sovereign gold/u)) return 'sgb:0';
  // NPS before "fund" ("NPS - SBI Pension Fund"); Tier II by name, Tier I otherwise.
  if (has(/\bnps\b|national pension/u)) return has(/tier[\s-]*(ii|2)\b/u) ? 'npsTier2:0' : 'nps:0';
  if (has(/home loan|housing loan|mortgage/u)) return 'loan:0';
  if (has(/loan|\bemi\b/u)) return 'loan:1';
  if (has(/\bmf\b|mutual|fund|\bsip\b|kuvera|groww|coin\b/u)) return 'mutualFunds:0';
  if (has(/stock|demat|zerodha|equity|shares/u)) return 'stocks:0';
  if (has(/\bfd\b|fixed deposit/u)) return 'fd:0';
  if (has(/\brd\b|recurring/u)) return 'rd:0';
  if (has(/gold/u)) return 'gold:0';
  if (has(/flat|house|plot|apartment|property|land/u)) return 'property:0';
  return balancePaise < 0 ? 'otherLiability:0' : 'otherAsset:0';
}

// ── What earlier imports brought in ──────────────────────────────────────────

type ItemKind = 'account' | 'transaction' | 'group' | 'category' | 'payee';

/** Actual id → our id, per kind, from this person's imports not undone. */
function priorItems(db: AppDb, userId: string): Map<ItemKind, Map<string, string>> {
  const rows = db
    .select({ kind: schema.importItems.kind, actualId: schema.importItems.actualId, ourId: schema.importItems.ourId })
    .from(schema.importItems)
    .innerJoin(schema.imports, eq(schema.imports.id, schema.importItems.importId))
    .where(and(eq(schema.imports.userId, userId), isNull(schema.imports.undoneAt)))
    .all();
  const out = new Map<ItemKind, Map<string, string>>();
  for (const r of rows) {
    if (!out.has(r.kind)) out.set(r.kind, new Map());
    out.get(r.kind)!.set(r.actualId, r.ourId);
  }
  return out;
}

/** The accounts an earlier import made that are still here, owned by the importer. */
function priorAccounts(db: AppDb, userId: string, prior: Map<ItemKind, Map<string, string>>) {
  const out = new Map<string, typeof schema.accounts.$inferSelect>();
  for (const [actualId, ourId] of prior.get('account') ?? []) {
    const a = db.select().from(schema.accounts).where(and(eq(schema.accounts.id, ourId), isNull(schema.accounts.deletedAt))).get();
    if (a && a.ownerId === userId) out.set(actualId, a);
  }
  return out;
}

// ── Per-account facts the preview and the import share ──────────────────────

interface AccountFacts {
  readonly account: ActualAccount;
  readonly rows: readonly ActualRow[];
  /** The opening row (the first "Starting Balance"), or null. */
  readonly opening: ActualRow | null;
  readonly balancePaise: number;
  readonly firstDate: string | null;
}

function factsOf(budget: ActualBudget): Map<string, AccountFacts> {
  const byAccount = new Map<string, ActualRow[]>();
  for (const r of budget.rows) {
    if (!byAccount.has(r.accountId)) byAccount.set(r.accountId, []);
    byAccount.get(r.accountId)!.push(r);
  }
  return new Map(
    budget.accounts.map((a) => {
      const rows = byAccount.get(a.id) ?? [];
      return [
        a.id,
        {
          account: a,
          rows,
          opening: rows.find((r) => r.starting) ?? null,
          balancePaise: rows.reduce((s, r) => s + r.amount, 0),
          firstDate: rows.length > 0 ? rows.reduce((m, r) => (r.date < m ? r.date : m), rows[0]!.date) : null,
        },
      ];
    }),
  );
}

/** A plain deposit: money in that isn't a transfer, the opening or a value update. */
function isPlainDeposit(r: ActualRow, opening: ActualRow | null): boolean {
  return r !== opening && !r.transferId && !r.adjustment && r.amount > 0;
}

/** A plain withdrawal: the same, money out. Where deposits are money put in, it is money taken
 *  out, under the same category. */
function isPlainWithdrawal(r: ActualRow, opening: ActualRow | null): boolean {
  return r !== opening && !r.transferId && !r.adjustment && r.amount < 0;
}

/** Filed under the money-put-in category when deposits are money put in: a plain deposit or withdrawal. */
const movesMoneyIn = (r: ActualRow, opening: ActualRow | null) => isPlainDeposit(r, opening) || isPlainWithdrawal(r, opening);

/** Invested, by the core's own holding rule (an asset holding), with plain deposits counted one way or the other. */
function investedOf(f: AccountFacts, deposits: DepositsAre, currency: string): number {
  const rows: Transaction[] = f.rows
    .filter((r) => r !== f.opening)
    .map((r, i) => ({
      id: r.id,
      accountId: f.account.id,
      date: parseDate(r.date),
      sequence: i,
      amount: Money.fromPaise(r.amount, currency),
      ...(r.transferId ? { transferPartnerId: r.transferId } : {}),
      kind: r.adjustment ? 'valuationMark' : 'ordinary',
      ...(deposits === 'moneyIn' && movesMoneyIn(r, f.opening) ? { countsAsReturn: false } : {}),
    }));
  const view = {
    id: f.account.id,
    type: 'mutualFunds',
    currency,
    status: 'open' as const,
    opening: Money.fromPaise(f.opening?.amount ?? 0, currency),
    transactions: rows,
  };
  return getModule('mutualFunds').costBasis(view, parseDate('9999-12-31')).paise;
}

// ── The preview ──────────────────────────────────────────────────────────────

export interface PreviewAccount {
  readonly actualId: string;
  readonly name: string;
  readonly inActual: 'On budget' | 'Off budget' | 'Closed';
  /** Rows it will add (the opening is the account's opening, not a row). */
  readonly rows: number;
  /** Its balance in Actual (what it will read here). */
  readonly balancePaise: number;
  readonly addAs: string;
  /** Already here from an earlier import: its new rows go into that account. */
  readonly existing: { readonly name: string; readonly type: string; readonly closed: boolean } | null;
  /** Plain deposits on it (the "Plain deposits are" choice shows when there are any). */
  readonly plainDeposits: number;
  readonly investedIfReturn: number;
  readonly investedIfMoneyIn: number;
  /** Closed in Actual but holding money (or rows after today): comes in open. */
  readonly comesInOpen: boolean;
  /** Its start would be after today (an opening and nothing earlier): can't come in. */
  readonly startsAfterToday: boolean;
  /** For the counts line, over the ticked accounts: the accounts its transfers go to ('' when the
   *  other half can't come in: see `transferCounts`), its splits, payees, categories. */
  readonly transferTo: readonly string[];
  readonly splitIds: readonly string[];
  readonly payeeIds: readonly string[];
}

export interface PreviewGroup {
  readonly actualId: string;
  readonly name: string;
  /** Actual accounts (off budget) its categories' transfers go into. */
  readonly holdings: readonly string[];
  /** Investments when its categories sit only on transfers into holdings, else Spending (O23). */
  readonly defaultKind: 'spending' | 'investments';
}

export interface ImportPreview {
  readonly budgetName: string | null;
  /** The currency the new accounts are made in: the instance's base (Actual's file carries none). */
  readonly currency: string;
  readonly from: string | null;
  readonly to: string | null;
  readonly accounts: readonly PreviewAccount[];
  /** Groups used on transfers into holdings, new here: the kind choice (Spending, as in Actual, or Investments). */
  readonly transferGroups: readonly PreviewGroup[];
  readonly categories: number;
  readonly groups: number;
  readonly hiddenCategories: number;
  readonly deletedRows: number;
  /** Rows Actual changed after an earlier import aren't updated (said when anything is already here). */
  readonly alreadyHere: boolean;
  /** The importer's open account names per type, normalised (a clash is flagged as typed). */
  readonly takenNames: Readonly<Record<string, readonly string[]>>;
  readonly options: readonly AddAsOption[];
  /** The importer's open EPFs here: each gives an "EPS of" entry in Add as (F4 RD9). */
  readonly epfsHere: readonly { readonly id: string; readonly name: string }[];
  /** The template the "EPS of" entries are made from (`$lib/import-eps`). */
  readonly epsOption: AddAsOption;
}

/** Categories that only a starting balance uses, or named Actual's "Starting Balances": not brought over. */
function droppedCategories(budget: ActualBudget): Set<string> {
  const usedElsewhere = new Set(budget.rows.filter((r) => !r.starting && r.categoryId).map((r) => r.categoryId!));
  const dropped = new Set(budget.rows.filter((r) => r.starting && r.categoryId && !usedElsewhere.has(r.categoryId)).map((r) => r.categoryId!));
  for (const c of budget.categories) if (normalizeName(c.name) === 'starting balances') dropped.add(c.id);
  return dropped;
}

export function previewImport(database: Db, userId: string, budget: ActualBudget): ImportPreview {
  const { db } = database;
  const todayIso = formatDate(today(appClock()));
  const prior = priorItems(db, userId);
  const priorRows = prior.get('transaction') ?? new Map<string, string>();
  const existing = priorAccounts(db, userId, prior);
  const facts = factsOf(budget);
  const offBudget = new Map(budget.accounts.map((a) => [a.id, a.offBudget]));
  const accountName = new Map(budget.accounts.map((a) => [a.id, a.name]));
  const rowById = new Map(budget.rows.map((r) => [r.id, r]));
  const currency = baseCurrency(db);
  const guessed = guesses(budget, facts, existing);

  const accounts: PreviewAccount[] = budget.accounts.map((a) => {
    const f = facts.get(a.id)!;
    const here = existing.get(a.id);
    const adding = f.rows.filter((r) => r !== f.opening && !priorRows.has(r.id));
    const future = f.rows.some((r) => r.date > todayIso);
    return {
      actualId: a.id,
      name: a.name,
      inActual: a.closed ? 'Closed' : a.offBudget ? 'Off budget' : 'On budget',
      rows: adding.length,
      balancePaise: f.balancePaise,
      addAs: guessed.get(a.id)!,
      existing: here ? { name: here.name, type: here.type, closed: here.status !== 'open' } : null,
      plainDeposits: f.rows.filter((r) => isPlainDeposit(r, f.opening)).length,
      investedIfReturn: investedOf(f, 'return', currency),
      investedIfMoneyIn: investedOf(f, 'moneyIn', currency),
      comesInOpen: !here && a.closed && (f.balancePaise !== 0 || future),
      startsAfterToday: !here && (f.opening?.amount ?? 0) !== 0 && f.firstDate !== null && f.firstDate > todayIso,
      // '' where the other half can't come in with this one (missing, or brought in earlier): the
      // row then comes in alone, under Transfer to Self.
      transferTo: adding.filter((r) => r.transferId).map((r) => {
        const other = rowById.get(r.transferId!);
        return other && !priorRows.has(other.id) ? other.accountId : '';
      }),
      splitIds: [...new Set(adding.filter((r) => r.splitId).map((r) => r.splitId!))],
      payeeIds: [...new Set(adding.filter((r) => r.payeeId).map((r) => r.payeeId!))],
    };
  });

  // The groups whose categories sit on transfers into an off-budget account (SIP, PPF, EMI), new here.
  const dropped = droppedCategories(budget);
  const catGroup = new Map(budget.categories.map((c) => [c.id, c.groupId]));
  const holdingsByGroup = new Map<string, Set<string>>();
  for (const r of budget.rows) {
    if (!r.transferId || !r.categoryId) continue;
    const partner = rowById.get(r.transferId);
    if (!partner || !offBudget.get(partner.accountId)) continue;
    const g = catGroup.get(r.categoryId);
    if (!g) continue;
    if (!holdingsByGroup.has(g)) holdingsByGroup.set(g, new Set());
    holdingsByGroup.get(g)!.add(accountName.get(partner.accountId) ?? '');
  }
  const liveGroupNames = new Set(
    db.select({ name: schema.categoryGroups.name }).from(schema.categoryGroups).where(isNull(schema.categoryGroups.deletedAt)).all().map((g) => normalizeName(g.name)),
  );
  const priorGroups = prior.get('group') ?? new Map<string, string>();
  const investmentOnly = investmentOnlyGroups(budget, (id) => isAssetHoldingType(typeOfKey(guessed.get(id) ?? '')));
  const transferGroups = budget.groups
    .filter((g) => !g.isIncome && holdingsByGroup.has(g.id) && !priorGroups.has(g.id) && !liveGroupNames.has(normalizeName(g.name)))
    .map((g) => ({
      actualId: g.id,
      name: g.name,
      holdings: [...holdingsByGroup.get(g.id)!],
      defaultKind: investmentOnly.has(g.id) ? ('investments' as const) : ('spending' as const),
    }));

  const taken: Record<string, string[]> = {};
  for (const a of db
    .select({ type: schema.accounts.type, name: schema.accounts.name })
    .from(schema.accounts)
    .where(and(eq(schema.accounts.ownerId, userId), eq(schema.accounts.status, 'open'), isNull(schema.accounts.deletedAt)))
    .all()) {
    (taken[a.type] ??= []).push(normalizeName(a.name));
  }

  const kept = budget.categories.filter((c) => !dropped.has(c.id));
  const dates = budget.rows.map((r) => r.date).sort();
  return {
    budgetName: budget.budgetName,
    currency,
    from: dates[0] ?? null,
    to: dates.at(-1) ?? null,
    accounts,
    transferGroups,
    categories: kept.length,
    groups: new Set(kept.map((c) => c.groupId)).size,
    hiddenCategories: kept.filter((c) => c.hidden || budget.groups.find((g) => g.id === c.groupId)?.hidden).length,
    deletedRows: budget.deletedRows,
    alreadyHere: existing.size > 0 || priorRows.size > 0,
    takenNames: taken,
    options: addAsOptions(),
    epfsHere: db
      .select({ id: schema.accounts.id, name: schema.accounts.name })
      .from(schema.accounts)
      .where(and(eq(schema.accounts.ownerId, userId), eq(schema.accounts.type, 'epf'), eq(schema.accounts.status, 'open'), isNull(schema.accounts.deletedAt)))
      .orderBy(schema.accounts.name)
      .all(),
    epsOption: epsOptionTemplate(),
  };
}

// ── The import ───────────────────────────────────────────────────────────────

export interface AccountChoice {
  readonly include: boolean;
  readonly addAs: string;
  readonly name: string;
  readonly deposits: DepositsAre;
}

export interface ImportChoices {
  /** Per Actual account id. An account missing here comes in as previewed (ticked, its guess). */
  readonly accounts: Readonly<Record<string, AccountChoice>>;
  /** Per Actual group id (a group used on transfers into holdings): its kind here. */
  readonly groupKinds: Readonly<Record<string, 'spending' | 'investments'>>;
}

export interface ImportResult {
  readonly importId: string;
  readonly accounts: number;
  readonly transactions: number;
  readonly categories: number;
  readonly payees: number;
}

/** The default choices: every account ticked as guessed, plain deposits per type, groups Spending. */
export function defaultChoices(preview: ImportPreview): ImportChoices {
  const options = new Map(preview.options.map((o) => [o.key, o]));
  const moneyInByDefault = (key: string) => (parseEpsOf(key) ? preview.epsOption : options.get(key))?.depositsMoneyIn;
  return {
    accounts: Object.fromEntries(
      preview.accounts.map((a) => [
        a.actualId,
        { include: !a.startsAfterToday, addAs: a.addAs, name: a.name, deposits: moneyInByDefault(a.addAs) ? 'moneyIn' : 'return' },
      ]),
    ),
    groupKinds: Object.fromEntries(preview.transferGroups.map((g) => [g.actualId, g.defaultKind])),
  };
}

/** How far each member's import has got: its rows written of those it brings. */
const progress = new Map<string, { readonly done: number; readonly total: number }>();
export function importProgress(userId: string): { readonly done: number; readonly total: number } | null {
  return progress.get(userId) ?? null;
}

/** The thread is given back at least this often (ms) while an import runs. */
const SLICE_MS = 40;

/**
 * Run the import in one transaction. Throws `ImportRefusedError` (nothing written) on a refusal.
 *
 * It gives Node's thread back every `SLICE_MS` (it held it for the whole import: 5.8 s for
 * 10,000 rows on a low-power server, and every other request waited). The transaction stays one: begun
 * here, committed at the end, rolled back on any error. Run it through `exclusiveWrite`
 * (`write-gate.ts`), so no other request's write lands inside it while it is open.
 */
export async function runImport(
  database: Db,
  userId: string,
  budget: ActualBudget,
  fileName: string,
  choices: ImportChoices,
): Promise<ImportResult> {
  const { db, sqlite } = database;
  const todayIso = formatDate(today(appClock()));
  const nowIso = new Date().toISOString();
  const options = new Map(addAsOptions().map((o) => [o.key, o]));
  const facts = factsOf(budget);
  const importId = randomUUID();
  // Actual's export carries no currency: new accounts are made in the instance's base (MC1).
  const currency = baseCurrency(db);
  const counts = { accounts: 0, transactions: 0, categories: 0, payees: 0 };

  let last = performance.now();
  /** Give the thread back once a slice has run (other requests are served), then go on. */
  const pace = async (): Promise<void> => {
    if (performance.now() - last < SLICE_MS) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
    last = performance.now();
  };

  if (sqlite.inTransaction) throw new Error('runImport: a transaction is already open');
  sqlite.exec('BEGIN IMMEDIATE');
  try {
    const result = await importInside();
    sqlite.exec('COMMIT');
    return result;
  } catch (err) {
    if (sqlite.inTransaction) sqlite.exec('ROLLBACK');
    throw err;
  } finally {
    progress.delete(userId);
  }

  async function importInside(): Promise<ImportResult> {
    const t = db as unknown as AppDb;
    const prior = priorItems(t, userId);
    const priorRows = prior.get('transaction') ?? new Map<string, string>();
    const existing = priorAccounts(t, userId, prior);
    const items: { kind: ItemKind; ourId: string; actualId: string; created: boolean }[] = [];

    // ── Accounts: made open (closing comes last) ──
    type Target = { id: string; type: string; open: boolean; actual: ActualAccount; deposits: DepositsAre; isNew: boolean };
    const targets = new Map<string, Target>();
    const batchNames = new Set<string>();
    const guessed = guesses(budget, facts, existing);
    const epsChoices: { a: ActualAccount; deposits: DepositsAre; epf: { here: string } | { actual: string } }[] = [];
    /** S5 RD16: an EPF's EPS, made with it (empty unless an Actual account goes into it). */
    const makeChild = (parentId: string, parentType: string, parentName: string, openingPaise: number, openingDate: string | null): string | null => {
      const child = moduleProfile(parentType)?.child;
      if (!child) return null;
      const id = randomUUID();
      t.insert(schema.accounts)
        .values({
          id,
          ownerId: userId,
          name: `${child.namePrefix}${parentName}`,
          type: child.type,
          currency,
          status: 'open',
          openingPaise,
          openingDate,
          parentAccountId: parentId,
          createdAt: nowIso,
          updatedAt: nowIso,
        })
        .run();
      return id;
    };
    for (const a of budget.accounts) {
      const choice = choices.accounts[a.id] ?? { include: true, addAs: guessed.get(a.id)!, name: a.name, deposits: 'return' };
      if (!choice.include) continue;
      const here = existing.get(a.id);
      if (here) {
        targets.set(a.id, { id: here.id, type: here.type, open: here.status === 'open', actual: a, deposits: choice.deposits, isNew: false });
        continue;
      }
      // "EPS of" an EPF: placed once every account of this import is made (F4 RD9).
      const epf = parseEpsOf(choice.addAs);
      if (epf) {
        epsChoices.push({ a, deposits: choice.deposits, epf });
        continue;
      }
      const option = options.get(choice.addAs);
      if (!option) throw new ImportRefusedError(`Choose what ${a.name} is added as.`);
      const name = choice.name.trim();
      if (name === '') throw new ImportRefusedError(`Give ${a.name} a name.`);
      const key = `${option.type}|${normalizeName(name)}`;
      if (batchNames.has(key) || openNameTaken(t, userId, option.type, name)) {
        throw new ImportRefusedError(`You already have an open ${option.label} named ${name}. Rename it in the list.`);
      }
      batchNames.add(key);

      const f = facts.get(a.id)!;
      const opening = f.opening?.amount ?? 0;
      const openingDate = opening === 0 ? null : f.firstDate;
      if (openingDate !== null && openingDate > todayIso) {
        throw new ImportRefusedError(`${name} would start after today. Untick it, or import it once its first row has passed.`);
      }
      const id = randomUUID();
      t.insert(schema.accounts)
        .values({
          id,
          ownerId: userId,
          name,
          type: option.type,
          currency,
          status: 'open',
          openingPaise: opening,
          openingDate,
          infoJson: Object.keys(option.preset).length > 0 ? JSON.stringify(option.preset) : null,
          createdAt: nowIso,
          updatedAt: nowIso,
        })
        .run();
      items.push({ kind: 'account', ourId: id, actualId: a.id, created: true });
      counts.accounts++;
      // S5 RD16: an EPF comes with its EPS, as Add account makes them (empty unless an Actual account
      // is added as "EPS of" it, below); its page shows the EPF | EPS tabs. Undo removes it with its EPF.
      makeChild(id, option.type, name, 0, null);
      targets.set(a.id, { id, type: option.type, open: true, actual: a, deposits: choice.deposits, isNew: true });
    }

    // ── "EPS of" an EPF (F4 RD9, O25): the Actual account's rows go into that EPF's EPS, never a new
    // account. The EPS must be empty (no opening, no rows): it takes Actual's opening, and Undo
    // empties it again (an `account` item not made by the import); one missing is made, as Add
    // account would have. The item keeps Actual's id, so a re-import finds the EPS "Already here".
    const epsTaken = new Map<string, string>();
    for (const { a, deposits, epf: ref } of epsChoices) {
      let epfId: string | null = null;
      if ('here' in ref) epfId = ref.here;
      else {
        const parent = targets.get(ref.actual);
        if (!parent) {
          const epfName = budget.accounts.find((x) => x.id === ref.actual)?.name;
          throw new ImportRefusedError(epfName ? `Tick ${epfName} too, or choose another EPF for ${a.name}.` : `Choose what ${a.name} is added as.`);
        }
        epfId = parent.id;
      }
      const epf = t.select().from(schema.accounts).where(and(eq(schema.accounts.id, epfId), isNull(schema.accounts.deletedAt))).get();
      if (!epf || epf.ownerId !== userId || epf.type !== 'epf' || epf.status !== 'open') throw new ImportRefusedError(`Choose what ${a.name} is added as.`);

      const f = facts.get(a.id)!;
      const opening = f.opening?.amount ?? 0;
      const openingDate = opening === 0 ? null : f.firstDate;
      if (openingDate !== null && openingDate > todayIso) {
        throw new ImportRefusedError(`${a.name} would start after today. Untick it, or import it once its first row has passed.`);
      }
      const child = t
        .select()
        .from(schema.accounts)
        .where(and(eq(schema.accounts.parentAccountId, epf.id), isNull(schema.accounts.deletedAt)))
        .get();
      let epsId: string;
      const other = child ? epsTaken.get(child.id) : undefined;
      if (other) throw new ImportRefusedError(`${other} and ${a.name} both go into the EPS of ${epf.name}. Choose one.`);
      if (!child) {
        epsId = makeChild(epf.id, epf.type, epf.name, opening, openingDate)!;
        items.push({ kind: 'account', ourId: epsId, actualId: a.id, created: true });
      } else {
        const hasRows = sqlite.prepare('SELECT 1 FROM transactions WHERE account_id = ? AND deleted_at IS NULL LIMIT 1').get(child.id) !== undefined;
        if (child.status !== 'open' || child.openingPaise !== 0 || hasRows) {
          throw new ImportRefusedError(`The EPS of ${epf.name} already has money in it. Add ${a.name} as its own account, or untick it.`);
        }
        epsId = child.id;
        t.update(schema.accounts).set({ openingPaise: opening, openingDate, updatedAt: nowIso }).where(eq(schema.accounts.id, epsId)).run();
        items.push({ kind: 'account', ourId: epsId, actualId: a.id, created: false });
      }
      epsTaken.set(epsId, a.name);
      targets.set(a.id, { id: epsId, type: 'eps', open: true, actual: a, deposits, isNew: false });
    }

    // ── Groups and categories: reused by name, else made ──
    const dropped = droppedCategories(budget);
    const groupMap = new Map<string, string>();
    const groupKindOf = new Map<string, GroupKind>();
    const liveGroups = () => t.select().from(schema.categoryGroups).where(isNull(schema.categoryGroups.deletedAt)).all();
    const nextGroupOrder = () =>
      (t.select({ m: sql<number>`COALESCE(MAX(${schema.categoryGroups.sortOrder}), -1)` }).from(schema.categoryGroups).get()?.m ?? -1) + 1;
    const makeGroup = (name: string, kind: GroupKind, hidden: boolean, actualId: string): string => {
      const id = randomUUID();
      t.insert(schema.categoryGroups).values({ id, name, kind, hidden, sortOrder: nextGroupOrder(), createdAt: nowIso, updatedAt: nowIso }).run();
      items.push({ kind: 'group', ourId: id, actualId, created: true });
      return id;
    };
    const priorGroups = prior.get('group') ?? new Map<string, string>();
    const actualGroup = new Map(budget.groups.map((g) => [g.id, g]));
    // A group's kind as chosen, else as the preview defaulted it (O23): Investments when its
    // categories sit only on transfers into holdings (by the same guesses), else Spending.
    const investmentOnly = investmentOnlyGroups(budget, (id) => isAssetHoldingType(typeOfKey(guessed.get(id) ?? '')));
    const chosenKind = (actualGroupId: string): 'spending' | 'investments' =>
      choices.groupKinds[actualGroupId] ?? (investmentOnly.has(actualGroupId) ? 'investments' : 'spending');
    /** Our group for an Actual group: an earlier import's, else one of the same name, else (when a
     *  category of it is new here) made, its kind Income for Actual's income group, else as chosen. */
    /** Our live group an Actual group already maps to: an earlier import's, else one of the same name. */
    const existingGroupFor = (g: { id: string; name: string }) => {
      const live = liveGroups();
      const priorId = priorGroups.get(g.id);
      return (priorId ? live.find((x) => x.id === priorId) : undefined) ?? live.find((x) => normalizeName(x.name) === normalizeName(g.name));
    };
    /** The kind an Actual group's categories land as, without making the group. */
    const kindFor = (actualGroupId: string): GroupKind | null => {
      const known = groupKindOf.get(actualGroupId);
      if (known) return known;
      const g = actualGroup.get(actualGroupId);
      if (!g) return null;
      return existingGroupFor(g)?.kind ?? (g.isIncome ? 'income' : chosenKind(g.id));
    };
    const groupFor = (actualGroupId: string, make: boolean): { id: string; kind: GroupKind } | null => {
      const known = groupMap.get(actualGroupId);
      if (known) return { id: known, kind: groupKindOf.get(actualGroupId)! };
      const g = actualGroup.get(actualGroupId);
      if (!g) return null;
      const found = existingGroupFor(g);
      let id: string;
      let kind: GroupKind;
      if (found) {
        id = found.id;
        kind = found.kind;
        items.push({ kind: 'group', ourId: id, actualId: g.id, created: false });
      } else if (!make) {
        return null;
      } else {
        kind = g.isIncome ? 'income' : chosenKind(g.id);
        id = makeGroup(g.name.trim() || 'Imported', kind, g.hidden, g.id);
      }
      groupMap.set(g.id, id);
      groupKindOf.set(g.id, kind);
      return { id, kind };
    };

    const usedColours = () => t.select({ c: schema.categories.colour }).from(schema.categories).where(isNull(schema.categories.deletedAt)).all().map((r) => r.c);
    const makeCategory = (groupId: string, name: string, hidden: boolean, countsAsReturn: boolean, actualId: string): string => {
      const id = randomUUID();
      const order = (t.select({ m: sql<number>`COALESCE(MAX(${schema.categories.sortOrder}), -1)` }).from(schema.categories).where(eq(schema.categories.groupId, groupId)).get()?.m ?? -1) + 1;
      t.insert(schema.categories)
        .values({ id, groupId, name, hidden, colour: nextSwatch(usedColours()), countsAsReturn, sortOrder: order, createdAt: nowIso, updatedAt: nowIso })
        .run();
      items.push({ kind: 'category', ourId: id, actualId, created: true });
      counts.categories++;
      return id;
    };
    const liveCategoryIn = (groupId: string, name: string) =>
      t.select().from(schema.categories).where(and(eq(schema.categories.groupId, groupId), isNull(schema.categories.deletedAt))).all()
        .find((c) => normalizeName(c.name) === normalizeName(name));

    const catMap = new Map<string, string>();
    const priorCats = prior.get('category') ?? new Map<string, string>();
    for (const c of budget.categories) {
      await pace();
      if (dropped.has(c.id) || !actualGroup.has(c.groupId)) continue;
      const priorId = priorCats.get(c.id);
      const priorLive = priorId
        ? t.select().from(schema.categories).where(and(eq(schema.categories.id, priorId), isNull(schema.categories.deletedAt))).get()
        : undefined;
      // Reused, not duplicated: the same name in the same-named group, else the one category of
      // that name in a group of the same kind (Actual's Food, Groceries is Miserly's Essentials,
      // Groceries; an income Rent never lands on a spending Rent: F4 RD4).
      const sameGroup = groupFor(c.groupId, false);
      const kind = kindFor(c.groupId);
      const kindOfGroup = new Map(liveGroups().map((g) => [g.id, g.kind]));
      const anywhere = t.select().from(schema.categories).where(isNull(schema.categories.deletedAt)).all()
        .filter((x) => normalizeName(x.name) === normalizeName(c.name) && kindOfGroup.get(x.groupId) === kind);
      const found = priorLive ?? (sameGroup ? liveCategoryIn(sameGroup.id, c.name) : undefined) ?? (anywhere.length === 1 ? anywhere[0] : undefined);
      if (found) {
        catMap.set(c.id, found.id);
        items.push({ kind: 'category', ourId: found.id, actualId: c.id, created: false });
      } else {
        const group = groupFor(c.groupId, true)!;
        const growth = group.kind === 'income' && ['interest', 'dividends', 'dividend'].includes(normalizeName(c.name));
        catMap.set(c.id, makeCategory(group.id, c.name.trim() || 'Imported', c.hidden, growth, c.id));
      }
    }

    // Money put in: the profile's category (EPF's Salary), else Investments, Other. Found, else made.
    const moneyIn = new Map<string, string>();
    const moneyInCategory = (type: string): string => {
      const spec = moduleProfile(type)?.importDeposits ?? { name: 'Other', kind: 'investments' as const };
      const key = `${spec.kind}|${spec.name}`;
      const known = moneyIn.get(key);
      if (known) return known;
      const groups = liveGroups().filter((g) => g.kind === spec.kind).sort((x, y) => x.sortOrder - y.sortOrder);
      let id = groups.map((g) => liveCategoryIn(g.id, spec.name)).find((c) => c !== undefined)?.id;
      if (!id) {
        const groupId = groups[0]?.id ?? makeGroup(spec.kind === 'income' ? 'Income' : 'Investments', spec.kind, false, `money-in:${spec.kind}`);
        id = makeCategory(groupId, spec.name, false, false, `money-in:${key}`);
      }
      moneyIn.set(key, id);
      return id;
    };
    // A transfer whose other half isn't brought over (an account left unticked or closed here, or a
    // half an earlier import brought alone) and has no category of its own: Transfer to Self, in
    // the first group of the kind reports leave out, "Counts as return" off (O24). Found, else made.
    let selfCategory: string | null = null;
    const transferToSelfCategory = (): string => {
      if (selfCategory) return selfCategory;
      const groups = liveGroups().filter((g) => g.kind === 'neutral').sort((x, y) => x.sortOrder - y.sortOrder);
      selfCategory =
        groups.map((g) => liveCategoryIn(g.id, TRANSFER_TO_SELF)).find((c) => c !== undefined)?.id ??
        makeCategory(groups[0]?.id ?? makeGroup('Adjustments', 'neutral', false, 'transfer-to-self:group'), TRANSFER_TO_SELF, false, false, 'transfer-to-self');
      return selfCategory;
    };
    const adjustmentCategory = t
      .select({ id: schema.categories.id })
      .from(schema.categories)
      .where(and(eq(schema.categories.id, BALANCE_ADJUSTMENT_CATEGORY_ID), isNull(schema.categories.deletedAt)))
      .get()?.id ?? null;

    // ── Payees: reused by name (a hidden one shows again, as when typed), else made ──
    const payeeMap = new Map<string, string>();
    const priorPayees = prior.get('payee') ?? new Map<string, string>();
    const payeeFor = (actualId: string, displayName: string): string => {
      const known = payeeMap.get(actualId);
      if (known) return known;
      const priorId = priorPayees.get(actualId);
      const name = displayName.trim();
      const normalized = normalizeName(name);
      const found =
        (priorId ? t.select().from(schema.payees).where(eq(schema.payees.id, priorId)).get() : undefined) ??
        t.select().from(schema.payees).where(eq(schema.payees.nameNormalized, normalized)).get();
      let id: string;
      if (found) {
        id = found.id;
        if (found.hidden) t.update(schema.payees).set({ hidden: false, updatedAt: nowIso }).where(eq(schema.payees.id, id)).run();
        items.push({ kind: 'payee', ourId: id, actualId, created: false });
      } else {
        id = randomUUID();
        t.insert(schema.payees).values({ id, displayName: name, nameNormalized: normalized, createdAt: nowIso, updatedAt: nowIso }).run();
        items.push({ kind: 'payee', ourId: id, actualId, created: true });
        counts.payees++;
      }
      payeeMap.set(actualId, id);
      return id;
    };
    const payeeName = new Map(budget.payees.map((p) => [p.id, p.name]));
    const accountName = new Map(budget.accounts.map((a) => [a.id, a.name]));

    // ── Rows ──
    const incoming = budget.rows.filter((r) => {
      const target = targets.get(r.accountId);
      return target !== undefined && target.open && r !== facts.get(r.accountId)!.opening && !priorRows.has(r.id);
    });
    const ourIdOf = new Map(incoming.map((r) => [r.id, randomUUID()]));
    const rowById = new Map(budget.rows.map((r) => [r.id, r]));
    const nextSeq = new Map<string, number>();
    const seqFor = (accountId: string, date: string): number => {
      const k = `${accountId}|${date}`;
      const n = nextSeq.get(k) ?? nextSequenceOn(t, accountId, date);
      nextSeq.set(k, n + 1);
      return n;
    };
    const links: [string, string][] = [];
    const projections = new Map<string, { accountId: string; payeeId: string; categoryId: string | null; date: string }>();
    const marksOn = new Set<string>();
    const startOf = new Map<string, string | null>();

    progress.set(userId, { done: 0, total: incoming.length });
    for (const r of incoming) {
      if (performance.now() - last >= SLICE_MS) progress.set(userId, { done: counts.transactions, total: incoming.length });
      await pace();
      const target = targets.get(r.accountId)!;
      const id = ourIdOf.get(r.id)!;
      const partner = r.transferId ? rowById.get(r.transferId) : undefined;
      const paired = partner !== undefined && ourIdOf.has(partner.id);
      const partnerType = paired ? targets.get(partner.accountId)!.type : null;
      const opening = facts.get(r.accountId)!.opening;

      let kind: 'ordinary' | 'valuationMark' = 'ordinary';
      let categoryId: string | null = null;
      let payeeId: string | null = null;
      if (paired) {
        const actualCategory = r.categoryId ?? partner.categoryId;
        const mapped = actualCategory ? (catMap.get(actualCategory) ?? null) : null;
        // C3 RD5: only a spending ↔ holding pair takes a category, kept on the spending-side leg.
        if (mapped && transferTakesCategory(target.type, partnerType!) && isSpendingType(target.type)) categoryId = mapped;
        links.push([id, ourIdOf.get(partner.id)!]);
      } else if (r.adjustment) {
        if (!startOf.has(target.id)) {
          startOf.set(target.id, t.select({ d: schema.accounts.openingDate }).from(schema.accounts).where(eq(schema.accounts.id, target.id)).get()?.d ?? null);
        }
        const before = startOf.get(target.id) ?? null;
        const markable = isMarkableType(target.type) && (before === null || r.date >= before);
        if (markable) {
          kind = 'valuationMark';
          marksOn.add(target.id);
        } else categoryId = adjustmentCategory;
      } else {
        categoryId = r.categoryId ? (catMap.get(r.categoryId) ?? null) : null;
        if (categoryId === null && r.transferId) categoryId = transferToSelfCategory();
        else if (categoryId === null && target.deposits === 'moneyIn' && moduleProfile(target.type)?.sectionShape === 'holding' && movesMoneyIn(r, opening)) {
          categoryId = moneyInCategory(target.type);
        }
        if (r.payeeId && payeeName.has(r.payeeId)) payeeId = payeeFor(r.payeeId, payeeName.get(r.payeeId)!);
        // A transfer whose other account isn't brought over: its payee is that account's name.
        else if (r.transferAccountId && accountName.get(r.transferAccountId)) {
          payeeId = payeeFor(`account:${r.transferAccountId}`, accountName.get(r.transferAccountId)!);
        }
      }

      t.insert(schema.transactions)
        .values({
          id,
          accountId: target.id,
          date: r.date,
          sequence: seqFor(target.id, r.date),
          amountPaise: r.amount,
          categoryId,
          payeeId,
          enteredBy: userId,
          kind,
          notes: r.notes,
          createdAt: nowIso,
          updatedAt: nowIso,
        })
        .run();
      items.push({ kind: 'transaction', ourId: id, actualId: r.id, created: true });
      counts.transactions++;
      if (payeeId) {
        const k = `${target.id}|${payeeId}`;
        const p = projections.get(k);
        if (!p || r.date >= p.date) projections.set(k, { accountId: target.id, payeeId, categoryId: categoryId ?? p?.categoryId ?? null, date: r.date });
      }
    }

    progress.set(userId, { done: incoming.length, total: incoming.length });
    // Transfers: link both legs (each exists now).
    for (const [a, b] of links) {
      await pace();
      t.update(schema.transactions).set({ transferPartnerId: b }).where(eq(schema.transactions.id, a)).run();
    }

    // A value update keeps the value it states: its target is the running value after it.
    for (const accountId of marksOn) {
      const acc = t.select({ opening: schema.accounts.openingPaise }).from(schema.accounts).where(eq(schema.accounts.id, accountId)).get()!;
      const ordered = t
        .select({ id: schema.transactions.id, amount: schema.transactions.amountPaise, kind: schema.transactions.kind, target: schema.transactions.markTargetPaise })
        .from(schema.transactions)
        .where(and(eq(schema.transactions.accountId, accountId), isNull(schema.transactions.deletedAt)))
        .orderBy(schema.transactions.date, schema.transactions.sequence)
        .all();
      let running = acc.opening;
      for (const o of ordered) {
        await pace();
        running += o.amount;
        if (o.kind === 'valuationMark' && o.target === null) {
          t.update(schema.transactions).set({ markTargetPaise: running }).where(eq(schema.transactions.id, o.id)).run();
        }
      }
    }
    for (const target of targets.values()) {
      await pace();
      reconcileMarks(t, target.id, nowIso);
    }

    // Payee projections (F3): used on the account, remembered category per payee (the latest row's).
    for (const p of projections.values()) {
      await pace();
      const ap = t.select().from(schema.accountPayee).where(and(eq(schema.accountPayee.accountId, p.accountId), eq(schema.accountPayee.payeeId, p.payeeId))).get();
      if (ap) t.update(schema.accountPayee).set({ lastUsedAt: nowIso, updatedAt: nowIso }).where(and(eq(schema.accountPayee.accountId, p.accountId), eq(schema.accountPayee.payeeId, p.payeeId))).run();
      else t.insert(schema.accountPayee).values({ accountId: p.accountId, payeeId: p.payeeId, lastUsedAt: nowIso }).run();
      const up = t.select().from(schema.userPayee).where(and(eq(schema.userPayee.userId, userId), eq(schema.userPayee.payeeId, p.payeeId))).get();
      if (up) {
        t.update(schema.userPayee)
          .set({ lastUsedAt: nowIso, updatedAt: nowIso, ...(p.categoryId ? { lastCategoryId: p.categoryId } : {}) })
          .where(and(eq(schema.userPayee.userId, userId), eq(schema.userPayee.payeeId, p.payeeId)))
          .run();
      } else {
        t.insert(schema.userPayee).values({ userId, payeeId: p.payeeId, lastCategoryId: p.categoryId, lastUsedAt: nowIso }).run();
      }
    }

    // ── Close what Actual closed, once written: at zero and with nothing after today (F1) ──
    for (const target of targets.values()) {
      if (!target.isNew || !target.actual.closed) continue;
      if (accountBalance(sqlite, target.id) !== 0 || upcomingRowsMessage(database, target.id, todayIso) !== null) continue;
      t.update(schema.accounts).set({ status: 'closed', updatedAt: nowIso }).where(eq(schema.accounts.id, target.id)).run();
      // F1 RD24: an account's EPS closes with it (empty here).
      t.update(schema.accounts).set({ status: 'closed', updatedAt: nowIso }).where(eq(schema.accounts.parentAccountId, target.id)).run();
    }

    // ── The log ──
    t.insert(schema.imports)
      .values({
        id: importId,
        userId,
        source: 'actual',
        fileName,
        budgetId: budget.budgetId,
        budgetName: budget.budgetName,
        ...counts,
        createdAt: nowIso,
        updatedAt: nowIso,
      })
      .run();
    const seen = new Set<string>();
    for (const it of items) {
      await pace();
      const k = `${it.kind}|${it.ourId}`;
      if (seen.has(k)) continue;
      seen.add(k);
      t.insert(schema.importItems).values({ importId, ...it }).run();
    }
    return { importId, ...counts };
  }
}

// ── The log, and Undo ────────────────────────────────────────────────────────

export interface ImportLogEntry {
  readonly id: string;
  readonly createdAt: string;
  readonly fileName: string;
  readonly budgetName: string | null;
  readonly accounts: number;
  readonly transactions: number;
  readonly categories: number;
  readonly payees: number;
  /** Only the latest import not undone can be undone (a later one may have added to its accounts). */
  readonly canUndo: boolean;
}

/** This person's imports not undone, newest first. */
export function listImports(database: Db, userId: string): ImportLogEntry[] {
  const rows = database.db
    .select()
    .from(schema.imports)
    .where(and(eq(schema.imports.userId, userId), isNull(schema.imports.undoneAt)))
    .orderBy(desc(schema.imports.createdAt), desc(schema.imports.id))
    .all();
  return rows.map((r, i) => ({
    id: r.id,
    createdAt: r.createdAt,
    fileName: r.fileName,
    budgetName: r.budgetName,
    accounts: r.accounts,
    transactions: r.transactions,
    categories: r.categories,
    payees: r.payees,
    canUndo: i === 0,
  }));
}

export interface UndoCheck {
  /** Why Undo can't run, or null. */
  readonly refusal: string | null;
  /** Rows typed into the imported accounts since (removed with them). */
  readonly typedSince: number;
}

/** The accounts an import made (and the accounts made with them, an EPF's EPS), still here. */
function importedAccountIds(db: AppDb, importId: string): string[] {
  const ids = db
    .select({ id: schema.importItems.ourId })
    .from(schema.importItems)
    .innerJoin(schema.accounts, eq(schema.accounts.id, schema.importItems.ourId))
    .where(and(eq(schema.importItems.importId, importId), eq(schema.importItems.kind, 'account'), eq(schema.importItems.created, true)))
    .all()
    .map((r) => r.id);
  if (ids.length === 0) return [];
  const children = db
    .select({ id: schema.accounts.id })
    .from(schema.accounts)
    .where(sql`${schema.accounts.parentAccountId} IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`)
    .all()
    .map((r) => r.id);
  return [...ids, ...children];
}

export function undoCheck(database: Db, userId: string, importId: string): UndoCheck {
  const { db, sqlite } = database;
  const imp = db.select().from(schema.imports).where(eq(schema.imports.id, importId)).get();
  if (!imp || imp.userId !== userId || imp.undoneAt !== null) return { refusal: 'That import is already undone.', typedSince: 0 };
  const latest = listImports(database, userId)[0];
  if (latest?.id !== importId) return { refusal: 'Undo the later import first.', typedSince: 0 };
  const accounts = importedAccountIds(db, importId);
  for (const id of accounts) {
    const shared = sqlite.prepare('SELECT 1 FROM account_members WHERE account_id = ? AND deleted_at IS NULL LIMIT 1').get(id);
    if (shared) {
      const name = db.select({ name: schema.accounts.name }).from(schema.accounts).where(eq(schema.accounts.id, id)).get()?.name ?? 'An account';
      return { refusal: `${name} was shared after the import. Stop sharing it, then undo.`, typedSince: 0 };
    }
  }
  let typedSince = 0;
  if (accounts.length > 0) {
    const q = sqlite.prepare(
      `SELECT COUNT(*) AS n FROM transactions t
        WHERE t.account_id = ? AND t.deleted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM import_items i WHERE i.import_id = ? AND i.kind = 'transaction' AND i.our_id = t.id)`,
    );
    for (const id of accounts) typedSince += (q.get(id, importId) as { n: number }).n;
  }
  return { refusal: null, typedSince };
}

/**
 * Undo an import: remove its accounts with every row in them (rows typed since included; the
 * dialog said how many), the rows it added to accounts already here, and the groups, categories
 * and payees it made that nothing else uses. A transfer from an account it didn't make, into one it
 * did, stays as a plain row. F1: the one removal of accounts. Refused per `undoCheck`.
 */
export function undoImport(database: Db, userId: string, importId: string): void {
  const check = undoCheck(database, userId, importId);
  if (check.refusal) throw new ImportRefusedError(check.refusal);
  const { db, sqlite } = database;
  const nowIso = new Date().toISOString();
  db.transaction((tx) => {
    const t = tx as unknown as AppDb;
    const accounts = importedAccountIds(t, importId);
    sqlite.exec('CREATE TEMP TABLE IF NOT EXISTS undo_accounts (id TEXT PRIMARY KEY); CREATE TEMP TABLE IF NOT EXISTS undo_rows (id TEXT PRIMARY KEY); DELETE FROM undo_accounts; DELETE FROM undo_rows;');
    const addAccount = sqlite.prepare('INSERT OR IGNORE INTO undo_accounts (id) VALUES (?)');
    for (const id of accounts) addAccount.run(id);
    sqlite.prepare('INSERT OR IGNORE INTO undo_rows (id) SELECT id FROM transactions WHERE account_id IN (SELECT id FROM undo_accounts)').run();
    sqlite.prepare("INSERT OR IGNORE INTO undo_rows (id) SELECT our_id FROM import_items WHERE import_id = ? AND kind = 'transaction'").run(importId);

    // Accounts outside whose rows lose a partner or a row: their marks re-derive afterwards.
    const touched = (sqlite
      .prepare(
        `SELECT DISTINCT account_id AS id FROM transactions
          WHERE account_id NOT IN (SELECT id FROM undo_accounts)
            AND (id IN (SELECT id FROM undo_rows) OR transfer_partner_id IN (SELECT id FROM undo_rows))`,
      )
      .all() as { id: string }[]).map((r) => r.id);

    // An EPS the import filled but didn't make ("EPS of", F4 RD9) was empty before: its opening goes.
    sqlite
      .prepare(
        `UPDATE accounts SET opening_paise = 0, opening_date = NULL, updated_at = ?
          WHERE id IN (SELECT our_id FROM import_items WHERE import_id = ? AND kind = 'account' AND created = 0)`,
      )
      .run(nowIso, importId);
    sqlite.exec(`
      UPDATE transactions SET transfer_partner_id = NULL WHERE transfer_partner_id IN (SELECT id FROM undo_rows);
      DELETE FROM transactions WHERE id IN (SELECT id FROM undo_rows);
      DELETE FROM account_payee WHERE account_id IN (SELECT id FROM undo_accounts);
      DELETE FROM account_members WHERE account_id IN (SELECT id FROM undo_accounts);
      DELETE FROM account_shares WHERE account_id IN (SELECT id FROM undo_accounts);
      DELETE FROM account_holder_periods WHERE account_id IN (SELECT id FROM undo_accounts);
      DELETE FROM accounts WHERE id IN (SELECT id FROM undo_accounts) AND parent_account_id IS NOT NULL;
      DELETE FROM accounts WHERE id IN (SELECT id FROM undo_accounts);
    `);
    sqlite.prepare(
      `UPDATE user_payee SET last_category_id = NULL
        WHERE last_category_id IN (SELECT our_id FROM import_items WHERE import_id = ? AND kind = 'category' AND created = 1)
          AND last_category_id NOT IN (SELECT category_id FROM transactions WHERE category_id IS NOT NULL)`,
    ).run(importId);
    sqlite.prepare(
      `DELETE FROM categories
        WHERE id IN (SELECT our_id FROM import_items WHERE import_id = ? AND kind = 'category' AND created = 1)
          AND id NOT IN (SELECT category_id FROM transactions WHERE category_id IS NOT NULL)
          AND id NOT IN (SELECT last_category_id FROM user_payee WHERE last_category_id IS NOT NULL)`,
    ).run(importId);
    sqlite.prepare(
      `DELETE FROM category_groups
        WHERE id IN (SELECT our_id FROM import_items WHERE import_id = ? AND kind = 'group' AND created = 1)
          AND id NOT IN (SELECT group_id FROM categories)`,
    ).run(importId);
    const madePayees = `SELECT our_id FROM import_items WHERE import_id = ? AND kind = 'payee' AND created = 1
                          AND our_id NOT IN (SELECT payee_id FROM transactions WHERE payee_id IS NOT NULL)`;
    sqlite.prepare(`DELETE FROM account_payee WHERE payee_id IN (${madePayees})`).run(importId);
    sqlite.prepare(`DELETE FROM user_payee WHERE payee_id IN (${madePayees})`).run(importId);
    sqlite.prepare(`DELETE FROM payees WHERE id IN (${madePayees})`).run(importId);
    sqlite.exec('DELETE FROM undo_accounts; DELETE FROM undo_rows;');

    for (const id of touched) reconcileMarks(t, id, nowIso);
    t.update(schema.imports).set({ undoneAt: nowIso, updatedAt: nowIso }).where(eq(schema.imports.id, importId)).run();
  });
}
