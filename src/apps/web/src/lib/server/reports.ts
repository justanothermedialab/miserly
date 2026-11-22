/**
 * reports.ts — the M10 Reports service (R2 spending + R3 cashflow), derived.
 * ============================================================================
 * The expense-tracking payoff. Two product-defining charts over ONE shared date
 * range (R1): spending-by-category (R2) and income-vs-expense/cashflow (R3).
 * Everything here is a DERIVED query over the ledger — no stored aggregates, no
 * report tables (R2/R3 failure case: a stored total that drifts). Re-categorize
 * a transaction and the next read reflects it.
 *
 * THE SPINE — ONE shared inclusion predicate (sequencing.md M10 watch-out:
 * "R2 and R3 must share ONE spending-inclusion predicate so their totals
 * reconcile by construction"). A live transaction is a REPORTING FLOW iff:
 *   - its account is in the viewer's VISIBLE set (P0 privacy — via
 *     `accountsVisibleTo`; an unseen account never enters any total), ANY type: income and
 *     spending are decided by the CATEGORY, not the account, so a Salary row on EPF or Interest typed inside an FD
 *     counts. An UNCATEGORISED row counts as spending only on a SPENDING-class account (bank /
 *     card); on a holding it's a value movement, never income or expense (`UNCAT`), AND
 *   - NOT an uncategorised transfer (`FLOW`): transfers are your-own-money moves (C3),
 *     except one between a spending account and a holding that was given a category on its
 *     spending-side leg (a SIP, a loan prepayment), which then counts by that category's kind
 *     like any row (item 2.5, 2026-10-16). The holding's leg is never in a report (holdings
 *     aren't reporting accounts), so a transfer counts once. AND
 *   - `kind = 'ordinary'`   (a valuation mark is never a cash flow, S3) AND
 *   - `deleted_at IS NULL`.
 * The row is then classified by its category-group KIND:
 *   - EXPENSE  ← group kind 'spending' OR uncategorized (category IS NULL).
 *               Net magnitude = −Σ amount_paise (an outflow is negative → adds
 *               to spend; a refund is positive → subtracts → NET within category).
 *   - INCOME   ← group kind 'income'. Net = +Σ amount_paise (a reversal subtracts).
 *   - EXCLUDED ← group kind 'neutral' or 'investments' (the "Balance adjustment" close
 *               row, SIPs) — never in spending or income. A row of the 'investments' kind on a
 *               bank or card, transfer or plain alike, is R3's INVESTED figure instead (money
 *               moved from cash into investments, −Σ amount: a redemption back subtracts; C2 A,
 *               2026-11-09); a 'neutral' row stays out of every figure.
 * Because R2's expense total and R3's expense total run the SAME predicate over
 * the SAME window, they reconcile BY CONSTRUCTION (R2/R3 hard invariant).
 *
 * SPENDING-class is read GENERICALLY from module metadata
 * (`accountClass === 'spending'` over `allModules()`) — never an `if
 * type==='bank'`; a new spending module would join automatically.
 *
 * MULTI-CURRENCY (MC1): amounts are summed per (bucket, native currency) in SQL,
 * then each currency's net is converted to base once via the engine `toBase`
 * boundary and accumulated. A currency with NO rate is EXCLUDED from the total
 * and returned in `rateNeededCurrencies` — never folded at a silent 1:1.
 *
 * AS-OF-TODAY: the query upper bound is clamped to today (min(range.to, today)),
 * so a live/custom range never pulls future-dated rows into a report even if the
 * caller passed a `to` past today (defense in depth atop period.ts's clamp).
 * ============================================================================
 */
import { and, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { Money, toBase, allModules, today, formatDate, parseDate, compareDates } from '@miserly/core';
import { appClock } from './clock';
import type { PlainDate, RateTable } from '@miserly/core';
import * as schema from './db/schema';
import type { Db } from './db/client';
import { accountsReadableBy, sharesFor, heldRowSql, heldRowCondition, viewerStretches, SINCE_START, SHARE_PERIOD_SQL } from './visibility';
import { visibleSharedNames } from './account-names';
import { sectionedName } from '../transfer-targets';
import { loadRateTable } from './rates';
import { baseCurrency } from './settings';

type AppDb = Db['db'];

/** Synthetic group/category key for uncategorized spending (its own R2 slice). */
export const UNCATEGORIZED_KEY = '__uncategorized__';
/** Synthetic payee key for spending rows with no payee (one "No payee" bar, R2 RD13). */
export const NO_PAYEE_KEY = '__no_payee__';

/** An inclusive reporting window (ISO 'YYYY-MM-DD'), as R1 resolves it. */
export interface DateRange {
  readonly from: string;
  readonly to: string;
}

/** The shared row filter (see THE SPINE): any row but an uncategorised transfer. */
const FLOW = '(t.transfer_partner_id IS NULL OR t.category_id IS NOT NULL)';

/**
 * C5 C (H2 RD9): a row counts for the viewer only when it is dated inside the days they held its
 * account (the owner, every day; a member from the day they joined, and up to the day they left).
 * Their share of it is weighted as before; this keeps the rows of other dates out of drill lists.
 */
const HELD = heldRowSql('t', '@viewer');

/**
 * An uncategorised row that counts as spending: only on a SPENDING-class account (bank, card). On
 * a holding an uncategorised row moves value, not money spent. The types are
 * registry keys read from module metadata, never typed in by a person.
 */
function uncategorisedSpend(): string {
  const types = [...spendingTypes()];
  if (!types.every((t) => /^\w+$/u.test(t))) throw new Error('reports: unexpected module type key');
  return `(t.category_id IS NULL AND acc.type IN (${types.map((t) => `'${t}'`).join(',')}))`;
}

/** The row is on a HOLDING (not a spending-class account), read from module metadata. */
function notSpendingAccount(): string {
  const types = [...spendingTypes()];
  if (!types.every((t) => /^\w+$/u.test(t))) throw new Error('reports: unexpected module type key');
  return `acc.type NOT IN (${types.map((t) => `'${t}'`).join(',')})`;
}

/**
 * Joint accounts at the viewer's share (R2 RD10, R3 RD8, architecture §12). Every flow
 * query also groups by account, day and category and returns the row's share period, and the sum
 * is weighted by `sharesFor(...).partIn` before it's converted and added. One grain for every
 * report, so R3's expense still equals R2's spending, the category × month table and the month
 * to date figure to the paisa, and the holders' parts of each group add to it exactly.
 */
const SHARE_COLUMNS = `t.account_id AS accountId, ${SHARE_PERIOD_SQL} AS sharePeriod`;
const SHARE_GRAIN = 't.account_id, t.date, t.category_id';

interface ShareCols {
  accountId: string;
  sharePeriod: string | null;
}

// ── spending-class type set (generic metadata read, not per-type branching) ──

let spendingTypesCache: Set<string> | null = null;
function spendingTypes(): Set<string> {
  if (spendingTypesCache === null) {
    spendingTypesCache = new Set(
      allModules().filter((m) => m.metadata.accountClass === 'spending').map((m) => m.type),
    );
  }
  return spendingTypesCache;
}

// ── shared account resolution + query scaffolding ────────────────────────────

interface ReportAccount {
  readonly id: string;
  readonly currency: string;
}

/**
 * The viewer's visible accounts (open AND closed — R2 counts spending from an account that was
 * open during the period even if later closed): every type, since the category decides income
 * and spending; `spendingOnly` keeps bank and card (the "All time" start).
 * Joint accounts count at the viewer's share (the queries weight them); there is no shared-only
 * view (R2 RD10). Visibility-gated (P0).
 */
async function reportingAccounts(db: AppDb, userId: string, spendingOnly = false): Promise<ReportAccount[]> {
  // C5 C: a member who has left keeps the figures of the dates they held (read-only).
  const visibleIds = await accountsReadableBy(db, userId);
  if (visibleIds.length === 0) return [];
  const rows = db
    .select({ id: schema.accounts.id, type: schema.accounts.type, currency: schema.accounts.currency })
    .from(schema.accounts)
    .where(and(inArray(schema.accounts.id, visibleIds), isNull(schema.accounts.deletedAt)))
    .all();
  const spending = spendingTypes();
  const accounts = spendingOnly ? rows.filter((r) => spending.has(r.type)) : rows;
  return accounts.map((a) => ({ id: a.id, currency: a.currency }));
}

/** Build `@p0,@p1,…` placeholders + a params object for an IN (...) list. */
function inList(ids: readonly string[], prefix: string): { sql: string; params: Record<string, string> } {
  const params: Record<string, string> = {};
  const names = ids.map((id, i) => {
    const name = `${prefix}${i}`;
    params[name] = id;
    return `@${name}`;
  });
  return { sql: names.join(','), params };
}

/** Effective inclusive upper bound: never past today (as-of-today guard). */
function clampTo(range: DateRange, todayIso: string): string {
  return range.to < todayIso ? range.to : todayIso;
}

/** Add `net` (native paise of `currency`) to `base`; on a missing rate flag it. Returns the running base. */
function addConverted(base: Money, netNativePaise: number, currency: string, rates: RateTable, rateNeeded: Set<string>): Money {
  const converted = toBase(Money.fromPaise(netNativePaise, currency), rates);
  if (converted === null) {
    if (currency !== rates.base) rateNeeded.add(currency);
    return base;
  }
  return base.add(converted);
}

// ── R2: spending by category ─────────────────────────────────────────────────

export interface SpendingCategory {
  /** Live category id, or `UNCATEGORIZED_KEY` for the uncategorized slice. */
  readonly categoryId: string;
  readonly name: string;
  readonly colour: string | null;
  /** NET spend in base (outflows − refunds); can be negative (refunds > spend). */
  readonly netPaise: number;
}

export interface SpendingGroup {
  /** Live group id, or `UNCATEGORIZED_KEY` for the synthetic uncategorized group. */
  readonly groupId: string;
  readonly name: string;
  readonly netPaise: number;
  readonly categories: SpendingCategory[];
}

export interface SpendingReport {
  readonly baseCurrency: string;
  /** Σ of all group nets — reconciles with R3's total expense for the same window. */
  readonly totalPaise: number;
  /** Groups largest-net first; each group's categories largest-net first. */
  readonly groups: SpendingGroup[];
  readonly rateNeededCurrencies: string[];
}

interface SpendRow extends ShareCols {
  categoryId: string | null;
  categoryName: string | null;
  categoryColour: string | null;
  groupId: string | null;
  groupName: string | null;
  currency: string;
  sumPaise: number;
}

/**
 * R2 spending-by-category over the R1 window, viewer-scoped. Groups → categories,
 * net within category (refunds subtract), uncategorized as its own group/slice,
 * base via `toBase`. Sorted largest-net first (net-negative categories sort
 * last but are shown honestly — the UI excludes them from the donut geometry).
 */
export async function spendingByCategory(
  database: Db,
  userId: string,
  range: DateRange,
): Promise<SpendingReport> {
  const { db, sqlite } = database;
  const rates = loadRateTable(db);
  const todayIso = formatDate(today(appClock()));
  const to = clampTo(range, todayIso);

  const accounts = await reportingAccounts(db, userId);
  const empty: SpendingReport = { baseCurrency: baseCurrency(db), totalPaise: 0, groups: [], rateNeededCurrencies: [] };
  if (accounts.length === 0 || range.from > to) return empty;

  const ids = inList(accounts.map((a) => a.id), 'a');
  const rows = sqlite
    .prepare(
      `SELECT
         t.category_id  AS categoryId,
         cat.name       AS categoryName,
         cat.colour     AS categoryColour,
         g.id           AS groupId,
         g.name         AS groupName,
         acc.currency   AS currency,
         ${SHARE_COLUMNS},
         SUM(t.amount_paise) AS sumPaise
       FROM transactions t
       JOIN accounts acc           ON acc.id = t.account_id
       LEFT JOIN categories cat     ON cat.id = t.category_id
       LEFT JOIN category_groups g  ON g.id   = cat.group_id
       WHERE t.account_id IN (${ids.sql})
         AND t.deleted_at IS NULL
         AND ${FLOW}
         AND ${HELD}
         AND t.kind = 'ordinary'
         AND t.date >= @from AND t.date <= @to
         AND (g.kind = 'spending' OR ${uncategorisedSpend()})
       GROUP BY ${SHARE_GRAIN}, acc.currency`,
    )
    .all({ viewer: userId, ...ids.params, from: range.from, to }) as SpendRow[];
  const shares = await sharesFor(db, userId, accounts.map((a) => a.id));

  const rateNeeded = new Set<string>();
  // categoryKey → accumulator (net base + metadata + owning group).
  const cats = new Map<string, { name: string; colour: string | null; groupId: string; groupName: string; base: Money }>();
  for (const r of rows) {
    const key = r.categoryId ?? UNCATEGORIZED_KEY;
    const existing = cats.get(key);
    const acc = existing ?? {
      name: r.categoryName ?? 'Uncategorized',
      colour: r.categoryColour,
      groupId: r.groupId ?? UNCATEGORIZED_KEY,
      groupName: r.groupName ?? 'Uncategorized',
      base: Money.zero(rates.base),
    };
    // Net SPEND is the negation of the signed sum (outflow<0 → positive spend), at the viewer's share.
    acc.base = addConverted(acc.base, -shares.partIn(r.accountId, r.sumPaise, r.sharePeriod), r.currency, rates, rateNeeded);
    cats.set(key, acc);
  }

  // Fold categories into their groups.
  const groups = new Map<string, { name: string; net: number; categories: SpendingCategory[] }>();
  for (const [categoryId, c] of cats) {
    const g = groups.get(c.groupId) ?? { name: c.groupName, net: 0, categories: [] };
    g.net += c.base.paise;
    g.categories.push({ categoryId, name: c.name, colour: c.colour, netPaise: c.base.paise });
    groups.set(c.groupId, g);
  }

  const groupList: SpendingGroup[] = [...groups.entries()]
    .map(([groupId, g]) => ({
      groupId,
      name: g.name,
      netPaise: g.net,
      categories: g.categories.sort((x, y) => y.netPaise - x.netPaise),
    }))
    .sort((x, y) => y.netPaise - x.netPaise);

  const totalPaise = groupList.reduce((sum, g) => sum + g.netPaise, 0);
  return { baseCurrency: baseCurrency(db), totalPaise, groups: groupList, rateNeededCurrencies: [...rateNeeded].sort() };
}

// ── R3: income vs expense & cashflow ─────────────────────────────────────────

export interface MonthBin {
  /** 'YYYY-MM'. */
  readonly month: string;
  readonly incomePaise: number;
  readonly expensePaise: number;
  /** income − expense (can be negative — a deficit month, shown honestly). */
  readonly netPaise: number;
  /** Net invested: money moved from a bank or card into investments, rows of the Investments
   *  kind, transfers and plain rows alike (item 2.5; C2 A): part of what was saved, never spending.
   *  A redemption subtracts. Plus money put straight into a holding by a plain row whose category
   *  isn't return (C3). */
  readonly investedPaise: number;
}

export interface CashflowReport {
  readonly baseCurrency: string;
  /** One contiguous bin per calendar month in the (clamped) window, chronological. */
  readonly bins: MonthBin[];
  readonly totalIncomePaise: number;
  /** Reconciles with R2's `totalPaise` for the same window (shared predicate). */
  readonly totalExpensePaise: number;
  readonly netPaise: number;
  readonly totalInvestedPaise: number;
  readonly rateNeededCurrencies: string[];
}

interface CashRow extends ShareCols {
  ym: string;
  currency: string;
  kind: 'income' | 'spending' | null;
  sumPaise: number;
}

/** Every 'YYYY-MM' from `from`'s month through `to`'s month, inclusive, chronological. */
function monthKeys(from: string, to: string): string[] {
  const end = parseDate(to).with({ day: 1 });
  let cursor: PlainDate = parseDate(from).with({ day: 1 });
  const keys: string[] = [];
  while (compareDates(cursor, end) <= 0) {
    keys.push(formatDate(cursor).slice(0, 7));
    cursor = cursor.add({ months: 1 });
  }
  return keys;
}

/**
 * R3 income-vs-expense binned by month + net cashflow, viewer-scoped. Shares R2's
 * expense predicate (so `totalExpensePaise === spendingByCategory().totalPaise`
 * for the same window) and adds the symmetric income predicate. Empty months are
 * present as zero bins so the trend is contiguous.
 */
export async function incomeVsExpense(
  database: Db,
  userId: string,
  range: DateRange,
): Promise<CashflowReport> {
  const { db, sqlite } = database;
  const rates = loadRateTable(db);
  const todayIso = formatDate(today(appClock()));
  const to = clampTo(range, todayIso);

  const accounts = await reportingAccounts(db, userId);
  const empty: CashflowReport = {
    baseCurrency: baseCurrency(db),
    bins: [],
    totalIncomePaise: 0,
    totalExpensePaise: 0,
    netPaise: 0,
    totalInvestedPaise: 0,
    rateNeededCurrencies: [],
  };
  if (accounts.length === 0 || range.from > to) return empty;

  const ids = inList(accounts.map((a) => a.id), 'a');
  const rows = sqlite
    .prepare(
      `SELECT
         substr(t.date, 1, 7) AS ym,
         acc.currency         AS currency,
         g.kind               AS kind,
         ${SHARE_COLUMNS},
         SUM(t.amount_paise)  AS sumPaise
       FROM transactions t
       JOIN accounts acc           ON acc.id = t.account_id
       LEFT JOIN categories cat     ON cat.id = t.category_id
       LEFT JOIN category_groups g  ON g.id   = cat.group_id
       WHERE t.account_id IN (${ids.sql})
         AND t.deleted_at IS NULL
         AND ${FLOW}
         AND ${HELD}
         AND t.kind = 'ordinary'
         AND t.date >= @from AND t.date <= @to
         AND (g.kind IN ('spending','income') OR ${uncategorisedSpend()})
       GROUP BY ${SHARE_GRAIN}, acc.currency`,
    )
    .all({ viewer: userId, ...ids.params, from: range.from, to }) as CashRow[];
  const shares = await sharesFor(db, userId, accounts.map((a) => a.id));

  const rateNeeded = new Set<string>();
  // month → { income base, expense base } accumulators.
  const income = new Map<string, Money>();
  const expense = new Map<string, Money>();
  for (const r of rows) {
    const part = shares.partIn(r.accountId, r.sumPaise, r.sharePeriod);
    if (r.kind === 'income') {
      // Income NET = +Σ (inflow>0 adds; a reversal<0 subtracts).
      income.set(r.ym, addConverted(income.get(r.ym) ?? Money.zero(rates.base), part, r.currency, rates, rateNeeded));
    } else {
      // Expense (spending kind OR uncategorized) NET = −Σ (outflow<0 → +spend).
      expense.set(r.ym, addConverted(expense.get(r.ym) ?? Money.zero(rates.base), -part, r.currency, rates, rateNeeded));
    }
  }

  // INVESTED, net of money taken back (the summed column is already "into investments" signed):
  //  - C2 A: a row on a BANK or CARD whose category is of the Investments
  //    kind, a transfer or a plain row alike (an SIP typed as a plain bank row counts, money gone
  //    to a place the app doesn't track): −amount, an outflow adds, a redemption back subtracts.
  //    The person's own Not-in-reports groups ("Lent to Ravi") stay out;
  //  - C3: a plain row on a HOLDING whose category isn't return (EPF's Salary
  //    typed inside the EPF): +amount, the money put in, as the holding's Invested counts it.
  // A transfer's category sits on its bank leg only, so nothing is counted twice.
  const investedRows = sqlite
    .prepare(
      `SELECT
         substr(t.date, 1, 7) AS ym,
         acc.currency         AS currency,
         ${SHARE_COLUMNS},
         SUM(CASE WHEN ${notSpendingAccount()} THEN t.amount_paise ELSE -t.amount_paise END) AS sumPaise
       FROM transactions t
       JOIN accounts acc          ON acc.id = t.account_id
       JOIN categories cat        ON cat.id = t.category_id
       JOIN category_groups g     ON g.id   = cat.group_id
       WHERE t.account_id IN (${ids.sql})
         AND t.deleted_at IS NULL
         AND t.kind = 'ordinary'
         AND t.date >= @from AND t.date <= @to
         AND ${HELD}
         AND (
           (NOT ${notSpendingAccount()} AND g.kind = 'investments')
           OR (t.transfer_partner_id IS NULL AND ${notSpendingAccount()} AND cat.counts_as_return = 0)
         )
       GROUP BY ${SHARE_GRAIN}, acc.currency`,
    )
    .all({ viewer: userId, ...ids.params, from: range.from, to }) as ({ ym: string; currency: string; sumPaise: number } & ShareCols)[];
  const invested = new Map<string, Money>();
  for (const r of investedRows) {
    const part = shares.partIn(r.accountId, r.sumPaise, r.sharePeriod);
    invested.set(r.ym, addConverted(invested.get(r.ym) ?? Money.zero(rates.base), part, r.currency, rates, rateNeeded));
  }

  const bins: MonthBin[] = monthKeys(range.from, to).map((month) => {
    const inc = income.get(month)?.paise ?? 0;
    const exp = expense.get(month)?.paise ?? 0;
    return { month, incomePaise: inc, expensePaise: exp, netPaise: inc - exp, investedPaise: invested.get(month)?.paise ?? 0 };
  });

  const totalIncomePaise = bins.reduce((s, b) => s + b.incomePaise, 0);
  const totalExpensePaise = bins.reduce((s, b) => s + b.expensePaise, 0);
  return {
    baseCurrency: baseCurrency(db),
    bins,
    totalIncomePaise,
    totalExpensePaise,
    netPaise: totalIncomePaise - totalExpensePaise,
    totalInvestedPaise: bins.reduce((s, b) => s + b.investedPaise, 0),
    rateNeededCurrencies: [...rateNeeded].sort(),
  };
}

// ── R2 drill leaf: the transactions behind a category slice ───────────────────

export interface ReportTransaction {
  readonly id: string;
  readonly accountId: string;
  readonly accountName: string;
  readonly date: string;
  /** Native paise of the row's own account currency (never converted — the leaf is literal). */
  readonly amountPaise: number;
  readonly currency: string;
  readonly payeeName: string | null;
  readonly categoryName: string | null;
  /** The viewer's share of a joint account on the row's date (basis points); null when sole. The
   *  amount stays in full (the record); the slice it came from counts it at this share (R2 RD10). */
  readonly shareBp: number | null;
}

interface DrillRow {
  id: string;
  accountId: string;
  accountName: string;
  accountType: string;
  date: string;
  amountPaise: number;
  currency: string;
  payeeName: string | null;
  categoryName: string | null;
}

/**
 * R2 drill leaf: the read-only transactions that make up one category's slice for
 * the window (group → category → transactions), newest first, each linking to its
 * register (D4). `categoryId === UNCATEGORIZED_KEY` (or null) drills the
 * uncategorized slice. Viewer-scoped + spending-class + same predicate as the
 * aggregate, so the leaf rows always sum to the slice they came from.
 */
export async function categoryTransactions(
  database: Db,
  userId: string,
  range: DateRange,
  categoryId: string | null,
): Promise<ReportTransaction[]> {
  const uncategorized = categoryId === null || categoryId === UNCATEGORIZED_KEY;
  return drillRows(
    database,
    userId,
    range,
    uncategorized ? uncategorisedSpend() : 't.category_id = @cat',
    uncategorized ? {} : { cat: categoryId },
  );
}

/**
 * R3 drill leaf: the transactions behind one month's Income or Spending figure (R3 RD10), on
 * `incomeVsExpense`'s predicate, so the rows sum to the figure they came from (at the share).
 */
export async function flowTransactions(
  database: Db,
  userId: string,
  range: DateRange,
  flow: 'income' | 'spending',
): Promise<ReportTransaction[]> {
  return drillRows(
    database,
    userId,
    range,
    flow === 'income' ? "g.kind = 'income'" : `(g.kind = 'spending' OR ${uncategorisedSpend()})`,
    {},
  );
}

/**
 * R2 RD13 drill leaf: the spending rows behind one payee's bar (`NO_PAYEE_KEY` for the rows with
 * none), on the same predicate, so they sum to the bar they came from (at the share).
 */
export async function payeeTransactions(
  database: Db,
  userId: string,
  range: DateRange,
  payeeId: string,
): Promise<ReportTransaction[]> {
  const spend = `(g.kind = 'spending' OR ${uncategorisedSpend()})`;
  return payeeId === NO_PAYEE_KEY
    ? drillRows(database, userId, range, `${spend} AND t.payee_id IS NULL`, {})
    : drillRows(database, userId, range, `${spend} AND t.payee_id = @payee`, { payee: payeeId });
}

/** The drill leaves' one query: the reports' predicate plus `clause`, newest first. */
async function drillRows(
  database: Db,
  userId: string,
  range: DateRange,
  clause: string,
  params: Record<string, string>,
): Promise<ReportTransaction[]> {
  const { db, sqlite } = database;
  const todayIso = formatDate(today(appClock()));
  const to = clampTo(range, todayIso);

  const accounts = await reportingAccounts(db, userId);
  if (accounts.length === 0 || range.from > to) return [];

  const ids = inList(accounts.map((a) => a.id), 'a');
  const rows = sqlite
    .prepare(
      `SELECT
         t.id           AS id,
         t.account_id   AS accountId,
         acc.name       AS accountName,
         acc.type       AS accountType,
         t.date         AS date,
         t.amount_paise AS amountPaise,
         acc.currency   AS currency,
         p.display_name AS payeeName,
         cat.name       AS categoryName
       FROM transactions t
       JOIN accounts acc            ON acc.id = t.account_id
       LEFT JOIN payees p           ON p.id   = t.payee_id
       LEFT JOIN categories cat     ON cat.id = t.category_id
       LEFT JOIN category_groups g  ON g.id   = cat.group_id
       WHERE t.account_id IN (${ids.sql})
         AND t.deleted_at IS NULL
         AND ${FLOW}
         AND ${HELD}
         AND t.kind = 'ordinary'
         AND t.date >= @from AND t.date <= @to
         AND ${clause}
       ORDER BY t.date DESC, t.sequence DESC`,
    )
    .all({ viewer: userId, ...ids.params, ...params, from: range.from, to }) as DrillRow[];
  const shares = await sharesFor(db, userId, accounts.map((a) => a.id));
  // "HDFC (Bank accounts)" when the viewer sees another HDFC.
  const sameName = await visibleSharedNames(database, userId);
  return rows.map(({ accountType, ...r }) => ({
    ...r,
    accountName: sectionedName({ name: r.accountName, type: accountType }, sameName),
    shareBp: shares.isShared(r.accountId, r.date) ? shares.shareBpOn(r.accountId, r.date) : null,
  }));
}

// ── earliest activity (for the R1 "All time" preset) ─────────────────────────

/**
 * The earliest date the viewer's reports have anything to count: a bank or card account's
 * opening_date or first row, or a categorised row on ANY account (the category decides,
 * R3 RD11, so a Salary row typed on EPF before the first bank row is income "All time" must
 * reach). Feeds period.ts's `all` preset so "All time" starts at real data, not an arbitrary
 * floor. Null when nothing yet.
 */
export async function earliestActivityDate(database: Db, userId: string): Promise<string | null> {
  const { db } = database;
  const all = await reportingAccounts(db, userId);
  if (all.length === 0) return null;
  const ids = (await reportingAccounts(db, userId, true)).map((a) => a.id);

  // C5 C: an account held from a date starts there for the viewer, not at its opening.
  const stretches = viewerStretches(db, userId, ids);
  const fromStart = ids.filter((id) => stretches.get(id)?.[0]?.from === SINCE_START);
  const joinedMin = ids
    .map((id) => stretches.get(id)?.[0]?.from)
    .filter((d): d is string => d !== undefined && d !== SINCE_START)
    .reduce<string | null>((m, d) => (m === null || d < m ? d : m), null);
  const openingMin =
    fromStart.length === 0
      ? undefined
      : db
          .select({ min: sql<string | null>`MIN(${schema.accounts.openingDate})` })
          .from(schema.accounts)
          .where(inArray(schema.accounts.id, fromStart))
          .get();
  const txMin =
    ids.length === 0
      ? undefined
      : db
          .select({ min: sql<string | null>`MIN(${schema.transactions.date})` })
          .from(schema.transactions)
          .where(and(inArray(schema.transactions.accountId, ids), isNull(schema.transactions.deletedAt), heldRowCondition(userId)))
          .get();
  const categorisedMin = db
    .select({ min: sql<string | null>`MIN(${schema.transactions.date})` })
    .from(schema.transactions)
    .where(
      and(
        inArray(schema.transactions.accountId, all.map((a) => a.id)),
        isNull(schema.transactions.deletedAt),
        isNotNull(schema.transactions.categoryId),
        heldRowCondition(userId),
      ),
    )
    .get();

  const candidates = [openingMin?.min, joinedMin, txMin?.min, categorisedMin?.min].filter((d): d is string => d != null);
  if (candidates.length === 0) return null;
  return candidates.reduce((a, b) => (a < b ? a : b));
}

// ── Session 4: spending by day (dashboard month-to-date) and by category by month (R2 RD5) ──

interface DayRow {
  date: string;
  currency: string;
  sumPaise: number;
}

/**
 * NET spending per calendar day over the window, in base, viewer-scoped: the R2 expense
 * predicate grouped by date (so a day's figure reconciles with R2 and R3 for the same window).
 */
async function spendingByDay(
  database: Db,
  userId: string,
  range: DateRange,
  rateNeeded: Set<string>,
): Promise<Map<string, number>> {
  const { db, sqlite } = database;
  const rates = loadRateTable(db);
  const to = clampTo(range, formatDate(today(appClock())));
  const accounts = await reportingAccounts(db, userId);
  const out = new Map<string, number>();
  if (accounts.length === 0 || range.from > to) return out;
  const ids = inList(accounts.map((a) => a.id), 'a');
  const rows = sqlite
    .prepare(
      `SELECT t.date AS date, acc.currency AS currency, ${SHARE_COLUMNS}, SUM(t.amount_paise) AS sumPaise
       FROM transactions t
       JOIN accounts acc           ON acc.id = t.account_id
       LEFT JOIN categories cat     ON cat.id = t.category_id
       LEFT JOIN category_groups g  ON g.id   = cat.group_id
       WHERE t.account_id IN (${ids.sql})
         AND t.deleted_at IS NULL
         AND ${FLOW}
         AND ${HELD}
         AND t.kind = 'ordinary'
         AND t.date >= @from AND t.date <= @to
         AND (g.kind = 'spending' OR ${uncategorisedSpend()})
       GROUP BY ${SHARE_GRAIN}, acc.currency`,
    )
    .all({ viewer: userId, ...ids.params, from: range.from, to }) as (DayRow & ShareCols)[];
  const shares = await sharesFor(db, userId, accounts.map((a) => a.id));
  for (const r of rows) {
    const base = addConverted(Money.zero(rates.base), -shares.partIn(r.accountId, r.sumPaise, r.sharePeriod), r.currency, rates, rateNeeded);
    out.set(r.date, (out.get(r.date) ?? 0) + base.paise);
  }
  return out;
}

export interface MonthToDateSpending {
  readonly baseCurrency: string;
  /** This month, 'YYYY-MM', and today's day of the month. */
  readonly month: string;
  readonly day: number;
  /** Cumulative spend by day of this month, days 1…today. */
  readonly thisMonth: number[];
  /** Last month, 'YYYY-MM', and its cumulative spend for every day of it. */
  readonly lastMonth: string;
  readonly lastMonthCumulative: number[];
  /** Last month's cumulative spend by the same day (its last day when shorter). */
  readonly lastMonthByThisDay: number;
  /**
   * S6: the average month over the three before this one, as cumulative spend for every day of
   * this month (a shorter month counts its total from its last day on). Only months with spending
   * count, so months before the ledger began don't pull the average down; null under two such
   * months (one would only repeat last month).
   */
  readonly average: {
    /** First and last month averaged, 'YYYY-MM'. */
    readonly from: string;
    readonly to: string;
    readonly cumulative: number[];
    readonly byThisDay: number;
  } | null;
  readonly rateNeededCurrencies: string[];
}

/**
 * Dashboard "Spending this month" (D1 RD5, Q10 chart 5): cumulative spending by day this month
 * against last month and against the average of the three months before it (S6),
 * viewer-scoped, on the R2/R3 predicate.
 */
export async function monthToDateSpending(
  database: Db,
  userId: string,
): Promise<MonthToDateSpending> {
  const t = today(appClock());
  const first = t.with({ day: 1 });
  const prevFirst = first.subtract({ months: 1 });
  const prevLast = first.subtract({ days: 1 });
  const avgFirst = first.subtract({ months: 3 });
  const rateNeeded = new Set<string>();
  const byDay = await spendingByDay(
    database,
    userId,
    { from: formatDate(avgFirst), to: formatDate(t) },
    rateNeeded,
  );
  const cumulative = (start: PlainDate, days: number): number[] => {
    const out: number[] = [];
    let s = 0;
    for (let d = 0; d < days; d++) {
      s += byDay.get(formatDate(start.add({ days: d }))) ?? 0;
      out.push(s);
    }
    return out;
  };
  const thisMonth = cumulative(first, t.day);
  const lastMonthCumulative = cumulative(prevFirst, prevLast.day);

  const months = [3, 2, 1]
    .map((k) => first.subtract({ months: k }))
    .map((start) => ({ start, c: cumulative(start, start.daysInMonth) }))
    .filter((mo) => mo.c.some((v) => v !== 0));
  let average: MonthToDateSpending['average'] = null;
  if (months.length >= 2) {
    const avg = Array.from({ length: first.daysInMonth }, (_, d) =>
      // Whole rupees: an average's paise would be false precision.
      Math.round(months.reduce((sum, mo) => sum + mo.c[Math.min(d, mo.c.length - 1)]!, 0) / months.length / 100) * 100,
    );
    average = {
      from: formatDate(months[0]!.start).slice(0, 7),
      to: formatDate(months[months.length - 1]!.start).slice(0, 7),
      cumulative: avg,
      byThisDay: avg[t.day - 1] ?? 0,
    };
  }
  return {
    baseCurrency: baseCurrency(database.db),
    month: formatDate(first).slice(0, 7),
    day: t.day,
    thisMonth,
    lastMonth: formatDate(prevFirst).slice(0, 7),
    lastMonthCumulative,
    lastMonthByThisDay: lastMonthCumulative[Math.min(t.day, prevLast.day) - 1] ?? 0,
    average,
    rateNeededCurrencies: [...rateNeeded].sort(),
  };
}

export interface CategoryMonthRow {
  /** Live category id, or `UNCATEGORIZED_KEY`. */
  readonly categoryId: string;
  readonly name: string;
  readonly colour: string | null;
  readonly groupId: string;
  readonly groupName: string;
  /** NET spend per month, aligned with `months`. */
  readonly byMonth: number[];
  readonly totalPaise: number;
}

export interface SpendingByMonthReport {
  readonly baseCurrency: string;
  /** 'YYYY-MM', chronological, every month of the (clamped) window. */
  readonly months: string[];
  /** Categories largest total first. */
  readonly categories: CategoryMonthRow[];
  readonly monthTotals: number[];
  readonly totalPaise: number;
  readonly rateNeededCurrencies: string[];
}

interface CatMonthRow extends SpendRow {
  ym: string;
}

/**
 * R2 RD5: spending by category by month (the stacked bars and the category × month table),
 * viewer-scoped, on the R2 predicate; its total equals `spendingByCategory` for the window.
 */
export async function spendingByCategoryByMonth(
  database: Db,
  userId: string,
  range: DateRange,
): Promise<SpendingByMonthReport> {
  const { db, sqlite } = database;
  const rates = loadRateTable(db);
  const to = clampTo(range, formatDate(today(appClock())));
  const accounts = await reportingAccounts(db, userId);
  const months = range.from > to ? [] : monthKeys(range.from, to);
  const empty: SpendingByMonthReport = {
    baseCurrency: baseCurrency(db),
    months,
    categories: [],
    monthTotals: months.map(() => 0),
    totalPaise: 0,
    rateNeededCurrencies: [],
  };
  if (accounts.length === 0 || range.from > to) return empty;
  const ids = inList(accounts.map((a) => a.id), 'a');
  const rows = sqlite
    .prepare(
      `SELECT
         substr(t.date, 1, 7) AS ym,
         t.category_id  AS categoryId,
         cat.name       AS categoryName,
         cat.colour     AS categoryColour,
         g.id           AS groupId,
         g.name         AS groupName,
         acc.currency   AS currency,
         ${SHARE_COLUMNS},
         SUM(t.amount_paise) AS sumPaise
       FROM transactions t
       JOIN accounts acc           ON acc.id = t.account_id
       LEFT JOIN categories cat     ON cat.id = t.category_id
       LEFT JOIN category_groups g  ON g.id   = cat.group_id
       WHERE t.account_id IN (${ids.sql})
         AND t.deleted_at IS NULL
         AND ${FLOW}
         AND ${HELD}
         AND t.kind = 'ordinary'
         AND t.date >= @from AND t.date <= @to
         AND (g.kind = 'spending' OR ${uncategorisedSpend()})
       GROUP BY ${SHARE_GRAIN}, acc.currency`,
    )
    .all({ viewer: userId, ...ids.params, from: range.from, to }) as (CatMonthRow & ShareCols)[];
  const shares = await sharesFor(db, userId, accounts.map((a) => a.id));

  const rateNeeded = new Set<string>();
  const idx = new Map(months.map((m, i) => [m, i]));
  const cats = new Map<
    string,
    { name: string; colour: string | null; groupId: string; groupName: string; byMonth: number[] }
  >();
  for (const r of rows) {
    const key = r.categoryId ?? UNCATEGORIZED_KEY;
    const c = cats.get(key) ?? {
      name: r.categoryName ?? 'Uncategorized',
      colour: r.categoryColour,
      groupId: r.groupId ?? UNCATEGORIZED_KEY,
      groupName: r.groupName ?? 'Uncategorized',
      byMonth: months.map(() => 0),
    };
    const i = idx.get(r.ym);
    if (i !== undefined) {
      const part = shares.partIn(r.accountId, r.sumPaise, r.sharePeriod);
      c.byMonth[i] = (c.byMonth[i] ?? 0) + addConverted(Money.zero(rates.base), -part, r.currency, rates, rateNeeded).paise;
    }
    cats.set(key, c);
  }
  const categories: CategoryMonthRow[] = [...cats.entries()]
    .map(([categoryId, c]) => ({ categoryId, ...c, totalPaise: c.byMonth.reduce((s, v) => s + v, 0) }))
    .sort((a, b) => b.totalPaise - a.totalPaise);
  const monthTotals = months.map((_, i) => categories.reduce((s, c) => s + (c.byMonth[i] ?? 0), 0));
  return {
    baseCurrency: baseCurrency(db),
    months,
    categories,
    monthTotals,
    totalPaise: monthTotals.reduce((s, v) => s + v, 0),
    rateNeededCurrencies: [...rateNeeded].sort(),
  };
}

// ── R2 RD13: spending by payee by month ──────────────────────────────────────

export interface PayeeMonthRow {
  /** Payee id, or `NO_PAYEE_KEY` for the rows with no payee. */
  readonly payeeId: string;
  readonly name: string;
  /** NET spend per month, aligned with `months`. */
  readonly byMonth: number[];
  readonly totalPaise: number;
}

export interface SpendingByPayeeReport {
  readonly baseCurrency: string;
  /** 'YYYY-MM', chronological, every month of the (clamped) window. */
  readonly months: string[];
  /** Payees largest total first. */
  readonly payees: PayeeMonthRow[];
  readonly monthTotals: number[];
  readonly totalPaise: number;
  readonly rateNeededCurrencies: string[];
}

interface PayeeGrainRow extends ShareCols {
  date: string;
  categoryId: string | null;
  payeeId: string | null;
  payeeName: string | null;
  currency: string;
  sumPaise: number;
}

/**
 * R2 RD13: the Spending report by payee, on R2's own predicate. Every month and the total equal
 * `spendingByCategoryByMonth`'s to the paisa: the rows are read at R2's grain (account, day,
 * category) split by payee, the grain's whole is converted and shared exactly as the category
 * report does it, and the payees in it divide that figure, any rounding remainder going to the
 * largest part. Viewer-scoped (P0).
 */
export async function spendingByPayeeByMonth(
  database: Db,
  userId: string,
  range: DateRange,
): Promise<SpendingByPayeeReport> {
  const { db, sqlite } = database;
  const rates = loadRateTable(db);
  const to = clampTo(range, formatDate(today(appClock())));
  const accounts = await reportingAccounts(db, userId);
  const months = range.from > to ? [] : monthKeys(range.from, to);
  const empty: SpendingByPayeeReport = {
    baseCurrency: baseCurrency(db),
    months,
    payees: [],
    monthTotals: months.map(() => 0),
    totalPaise: 0,
    rateNeededCurrencies: [],
  };
  if (accounts.length === 0 || range.from > to) return empty;
  const ids = inList(accounts.map((a) => a.id), 'a');
  const rows = sqlite
    .prepare(
      `SELECT
         t.date         AS date,
         t.category_id  AS categoryId,
         t.payee_id     AS payeeId,
         p.display_name AS payeeName,
         acc.currency   AS currency,
         ${SHARE_COLUMNS},
         SUM(t.amount_paise) AS sumPaise
       FROM transactions t
       JOIN accounts acc           ON acc.id = t.account_id
       LEFT JOIN payees p           ON p.id   = t.payee_id
       LEFT JOIN categories cat     ON cat.id = t.category_id
       LEFT JOIN category_groups g  ON g.id   = cat.group_id
       WHERE t.account_id IN (${ids.sql})
         AND t.deleted_at IS NULL
         AND ${FLOW}
         AND ${HELD}
         AND t.kind = 'ordinary'
         AND t.date >= @from AND t.date <= @to
         AND (g.kind = 'spending' OR ${uncategorisedSpend()})
       GROUP BY ${SHARE_GRAIN}, acc.currency, t.payee_id`,
    )
    .all({ viewer: userId, ...ids.params, from: range.from, to }) as PayeeGrainRow[];
  const shares = await sharesFor(db, userId, accounts.map((a) => a.id));

  const rateNeeded = new Set<string>();
  const inBase = (r: PayeeGrainRow, sumPaise: number): number =>
    addConverted(Money.zero(rates.base), -shares.partIn(r.accountId, sumPaise, r.sharePeriod), r.currency, rates, rateNeeded).paise;

  const grains = new Map<string, PayeeGrainRow[]>();
  for (const r of rows) {
    const key = `${r.accountId}\u0000${r.date}\u0000${r.categoryId ?? ''}\u0000${r.currency}`;
    const parts = grains.get(key);
    if (parts) parts.push(r);
    else grains.set(key, [r]);
  }

  const idx = new Map(months.map((m, i) => [m, i]));
  const payees = new Map<string, { name: string; byMonth: number[] }>();
  for (const parts of grains.values()) {
    const first = parts[0]!;
    const i = idx.get(first.date.slice(0, 7));
    if (i === undefined) continue;
    const whole = inBase(first, parts.reduce((s, p) => s + p.sumPaise, 0));
    const values = parts.map((p) => inBase(p, p.sumPaise));
    let largest = 0;
    values.forEach((v, k) => {
      if (Math.abs(v) > Math.abs(values[largest]!)) largest = k;
    });
    values[largest] = values[largest]! + whole - values.reduce((s, v) => s + v, 0);
    parts.forEach((p, k) => {
      const key = p.payeeId ?? NO_PAYEE_KEY;
      const entry = payees.get(key) ?? { name: p.payeeName ?? 'No payee', byMonth: months.map(() => 0) };
      entry.byMonth[i] = (entry.byMonth[i] ?? 0) + values[k]!;
      payees.set(key, entry);
    });
  }
  const list: PayeeMonthRow[] = [...payees.entries()]
    .map(([payeeId, p]) => ({ payeeId, ...p, totalPaise: p.byMonth.reduce((s, v) => s + v, 0) }))
    .sort((a, b) => b.totalPaise - a.totalPaise);
  const monthTotals = months.map((_, i) => list.reduce((s, p) => s + (p.byMonth[i] ?? 0), 0));
  return {
    baseCurrency: baseCurrency(db),
    months,
    payees: list,
    monthTotals,
    totalPaise: monthTotals.reduce((s, v) => s + v, 0),
    rateNeededCurrencies: [...rateNeeded].sort(),
  };
}
