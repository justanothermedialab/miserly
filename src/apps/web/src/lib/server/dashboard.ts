/**
 * dashboard.ts — the ONE shared aggregation service behind D1–D4.
 * ============================================================================
 * Architecture §11 "one aggregation service": the net-worth hero (D1),
 * allocation (D2), net-worth-over-time (D3), and recent-activity / account
 * summary (D4) all read from here, so they can never disagree with each other
 * or with the registers. Every figure is DERIVED from `opening_paise + Σtx`
 * (via the engine's contract folds) — nothing is stored or cached (D1 failure
 * case: a stored net worth that drifts is a P0). Values at dates (net worth,
 * the history, the sidebar's balances) read the Σ as one grouped SQL sum per
 * figure (`ledger-cuts.ts`); cost basis, flows and returns read the rows.
 *
 * THREE invariants this file owns:
 *
 *  1. PRIVACY (P0). Every read funnels through `accountsVisibleTo` and filters
 *     IN SQL — an account a viewer can't see never enters any aggregate, and
 *     the transfer-counterpart name join is itself visibility-gated so a
 *     cross-member transfer can't leak the other account's name/existence.
 *     Admin gets no bypass (there is no role clause anywhere here).
 *
 *  2. THE D1/D3 INCLUSION ASYMMETRY. D1/D2/D4 are as-of-today and OPEN-only.
 *     D3 history counts CLOSED accounts for the periods they were open (a
 *     force-closed account carries a zeroing adjustment, so its balance is its
 *     real value before close and 0 after — the history falls out of the
 *     ledger), and honors F1 RD10 dated opening: an account contributes 0 to
 *     any month before its `opening_date`. That RD10 gate lives HERE (the DB
 *     knows `opening_date`; the frozen `AccountView` does not) as the
 *     `existsAsOf` predicate handed to `netWorthSeries`.
 *
 *  3. NO TYPE-BRANCHING. Buckets/sides come from module metadata via the
 *     engine folds — never an `if (type === 'FD')`.
 *
 * Multi-currency (M9 / MC1): base is the setup choice (rupees by default); a foreign account folds into every
 * aggregate through the engine's single `toBase` boundary, fed by the global
 * `RateTable` (rates.ts). A foreign currency with no rate is EXCLUDED from the
 * total and its code returned in `rateNeededCurrencies` — the "rate needed" flag
 * the UI surfaces — NEVER folded at a silent 1:1 (the Firefly defect). MVP
 * applies the single current rate across all of history (D3).
 * ============================================================================
 */
import { and, inArray, isNull } from 'drizzle-orm';
import {
  Money,
  netWorthSeries,
  monthEndPoints,
  valuationOf,
  holdingReturn,
  getModule,
  toBase,
  today,
  formatDate,
  parseDate,
  compareDates,
  annualReturn,
  holdingFlows,
  lastValueDate,
  closedEndDate,
  holdingEarned,
  valueInvestedSeries,
} from '@miserly/core';
import { appClock } from './clock';
import type { AccountView, HoldingFlows, PlainDate, RateTable } from '@miserly/core';
import * as schema from './db/schema';
import type { Db } from './db/client';
import { rowToAccountView, parseStoredDate, type TransactionRow } from './db/mappers';
import {
  accountsVisibleTo,
  accountsReadableBy,
  accountsHeldBefore,
  isAccountVisibleTo,
  sharesFor,
  heldRowSql,
  viewerStretches,
  SINCE_START,
  type ViewerShares,
} from './visibility';
import { loadRateTable } from './rates';
import { ledgerCuts, cutViews, todayCuts } from './ledger-cuts';
import { listedNoteSql } from './listed-notes';
import { baseCurrency } from './settings';
import { MODULE_PROFILES, moduleProfile, paidOutRate, sectionTypeOf } from '../modules';
import { transferTakesCategory } from './transactions';
import { accountLabel, sectionedName, sharedNames } from '../transfer-targets';

type AppDb = Db['db'];
type AccountRow = typeof schema.accounts.$inferSelect;
type TxRow = TransactionRow;

// ── shared loaders ──────────────────────────────────────────────────────────

/** The viewer's visible account rows (live), open+closed, filtered IN SQL. */
function fetchAccountRows(db: AppDb, ids: readonly string[]): AccountRow[] {
  if (ids.length === 0) return [];
  return db
    .select()
    .from(schema.accounts)
    .where(and(isNull(schema.accounts.deletedAt), inArray(schema.accounts.id, ids)))
    .all();
}

/**
 * The "counts as return" flag each row carries into the engine (C3 A): the row's
 * own category's switch, or on a transfer leg with none of its own, its partner's (a transfer's
 * category sits on its spending-side leg, so a holding's leg reads the bank leg's). A value update
 * and an uncategorised row carry none (the engine's old rule). Categories are instance-wide data,
 * so reading the partner's category reveals nothing about the partner's account.
 */
export function returnFlags(db: AppDb, rows: readonly Pick<TxRow, 'id' | 'kind' | 'categoryId' | 'transferPartnerId'>[]): Map<string, boolean> {
  const flags = new Map<string, boolean>();
  const partnerIds = rows.filter((r) => r.kind !== 'valuationMark' && r.categoryId === null && r.transferPartnerId !== null).map((r) => r.transferPartnerId!);
  const partnerCategory = new Map<string, string>();
  for (let i = 0; i < partnerIds.length; i += 500) {
    for (const p of db
      .select({ id: schema.transactions.id, categoryId: schema.transactions.categoryId })
      .from(schema.transactions)
      .where(inArray(schema.transactions.id, partnerIds.slice(i, i + 500)))
      .all()) {
      if (p.categoryId !== null) partnerCategory.set(p.id, p.categoryId);
    }
  }
  const categoryIds = new Set<string>();
  for (const r of rows) if (r.categoryId !== null) categoryIds.add(r.categoryId);
  for (const c of partnerCategory.values()) categoryIds.add(c);
  if (categoryIds.size === 0) return flags;
  const switchOf = new Map(
    db
      .select({ id: schema.categories.id, on: schema.categories.countsAsReturn })
      .from(schema.categories)
      .where(inArray(schema.categories.id, [...categoryIds]))
      .all()
      .map((c) => [c.id, c.on]),
  );
  for (const r of rows) {
    if (r.kind === 'valuationMark') continue;
    const categoryId = r.categoryId ?? (r.transferPartnerId !== null ? partnerCategory.get(r.transferPartnerId) : undefined);
    const on = categoryId !== undefined ? switchOf.get(categoryId) : undefined;
    if (on !== undefined) flags.set(r.id, on);
  }
  return flags;
}

/** The columns the engine reads (`TransactionRow`): never `notes`, which can be large and which no
 *  figure needs (every page copied every note twice). */
const ENGINE_COLUMNS = {
  id: schema.transactions.id,
  accountId: schema.transactions.accountId,
  date: schema.transactions.date,
  sequence: schema.transactions.sequence,
  amountPaise: schema.transactions.amountPaise,
  categoryId: schema.transactions.categoryId,
  payeeId: schema.transactions.payeeId,
  transferPartnerId: schema.transactions.transferPartnerId,
  enteredBy: schema.transactions.enteredBy,
  kind: schema.transactions.kind,
};

/** Live transaction rows for the given accounts, grouped by account id, each with its return flag. */
function fetchTxByAccount(db: AppDb, ids: readonly string[]): Map<string, TxRow[]> {
  const byAccount = new Map<string, TxRow[]>();
  if (ids.length === 0) return byAccount;
  const rows: TxRow[] = db
    .select(ENGINE_COLUMNS)
    .from(schema.transactions)
    .where(and(inArray(schema.transactions.accountId, ids), isNull(schema.transactions.deletedAt)))
    .all();
  const flags = returnFlags(db, rows);
  for (const r of rows) {
    const list = byAccount.get(r.accountId) ?? [];
    const flag = flags.get(r.id);
    list.push(flag === undefined ? r : { ...r, countsAsReturn: flag });
    byAccount.set(r.accountId, list);
  }
  return byAccount;
}

/** Build engine `AccountView`s for the given account rows (+ their tx rows). */
function toViews(rows: readonly AccountRow[], txByAccount: Map<string, TxRow[]>): AccountView[] {
  return rows.map((a) => rowToAccountView(a, txByAccount.get(a.id) ?? []));
}

/** The subset of `ids` that are SHARED (have ≥1 live member row) — the common pot. */
function sharedAccountIds(db: AppDb, ids: readonly string[]): Set<string> {
  if (ids.length === 0) return new Set();
  const rows = db
    .selectDistinct({ accountId: schema.accountMembers.accountId })
    .from(schema.accountMembers)
    .where(
      and(
        inArray(schema.accountMembers.accountId, ids),
        isNull(schema.accountMembers.deletedAt),
      ),
    )
    .all();
  return new Set(rows.map((r) => r.accountId));
}

// ── D1 + D2: net-worth hero and allocation ──────────────────────────────────

export interface AllocationSlice {
  /** Module type ('bank', …) for by-class; the Liquidity band for by-liquidity. */
  readonly key: string;
  readonly amountPaise: number;
}

export interface NetWorthFigures {
  readonly netWorthPaise: number;
  /** Gross assets (Σ Asset-side currentValue). */
  readonly assetsPaise: number;
  /** Gross liabilities, natural-negative (Σ Liability-side currentValue). */
  readonly liabilitiesPaise: number;
  /**
   * Foreign currencies EXCLUDED from these figures because they have no rate
   * (MC1). Non-empty ⇒ the total is incomplete and the UI shows "rate needed"
   * with a one-tap set-rate link — never a silent 1:1.
   */
  readonly rateNeededCurrencies: string[];
}

/** Net-worth figures + asset allocation over the viewer's open accounts, at the viewer's share. */
export interface ScopedFigures extends NetWorthFigures {
  /** Asset allocation by module class, descending by amount (assets only). */
  readonly byClass: AllocationSlice[];
  /** Asset allocation by liquidity band, descending by amount. */
  readonly byLiquidity: AllocationSlice[];
  /** The Liquid band's total assets (for the neutral "X% liquid" summary, computed in the UI). */
  readonly liquidAssetsPaise: number;
}

export interface DashboardSummary extends ScopedFigures {
  readonly baseCurrency: string;
  /** False → show the no-accounts empty state instead of a misleading ₹0 (D1 AC). */
  readonly hasOpenAccounts: boolean;
  /**
   * D1 RD12's line under the headline: the shared accounts the viewer holds, net, in full and at
   * the viewer's share (both in base, today). Null when the viewer holds no shared account.
   */
  readonly sharedLine: {
    readonly fullPaise: number;
    readonly sharePaise: number;
    /** The breakdown the line opens: each shared account the viewer holds, in base, today. */
    readonly accounts: readonly SharedLineAccount[];
  } | null;
}

export interface SharedLineAccount {
  readonly id: string;
  readonly name: string;
  readonly side: 'Asset' | 'Liability';
  readonly fullPaise: number;
  readonly sharePaise: number;
  readonly shareBp: number;
}

/**
 * D1 + D2 at the viewer's share (architecture §12): each open account's contract value
 * (`valuationOf`), converted to base through `toBase`, times the viewer's share today, then summed
 * by side, class and liquidity. The same folds as the engine's `netWorth` / `allocationBy*`, with
 * the weight applied per account before the sum (the contract and the modules never see it); so
 * `Σ byClass === Σ byLiquidity === assetsPaise` and `netWorth === assets + liabilities` still hold.
 */
function weightedFiguresOf(
  views: readonly AccountView[],
  asOf: PlainDate,
  rates: RateTable,
  shares: ViewerShares,
): ScopedFigures & { sharedLine: { fullPaise: number; sharePaise: number; accounts: Omit<SharedLineAccount, 'name'>[] } | null } {
  const date = formatDate(asOf);
  const missing = new Set<string>();
  let assets = 0;
  let liabilities = 0;
  let sharedFull = 0;
  let sharedPart = 0;
  const sharedAccounts: Omit<SharedLineAccount, 'name'>[] = [];
  const byClass = new Map<string, number>();
  const byLiquidity = new Map<string, number>();
  for (const v of views) {
    if (v.status !== 'open') continue;
    // The contract's value and the module's metadata (no cost basis: nothing here shows one, and
    // `cutViews` carry sums good for values only).
    const module = getModule(v.type);
    const val = { currentValue: module.currentValue(v, asOf), side: module.metadata.side, liquidity: module.metadata.liquidity, currency: v.currency };
    const converted = toBase(val.currentValue, rates);
    if (converted === null) {
      missing.add(val.currency);
      continue;
    }
    const part = shares.partOn(v.id, converted.paise, date);
    if (shares.isShared(v.id, date)) {
      sharedFull += converted.paise;
      sharedPart += part;
      sharedAccounts.push({ id: v.id, side: val.side, fullPaise: converted.paise, sharePaise: part, shareBp: shares.shareBpOn(v.id, date) });
    }
    if (val.side === 'Asset') {
      assets += part;
      byClass.set(v.type, (byClass.get(v.type) ?? 0) + part);
      byLiquidity.set(val.liquidity, (byLiquidity.get(val.liquidity) ?? 0) + part);
    } else {
      liabilities += part;
    }
  }
  const slices = (m: Map<string, number>): AllocationSlice[] =>
    [...m.entries()].map(([key, amountPaise]) => ({ key, amountPaise })).sort((a, b) => b.amountPaise - a.amountPaise);
  return {
    netWorthPaise: assets + liabilities,
    assetsPaise: assets,
    liabilitiesPaise: liabilities,
    rateNeededCurrencies: [...missing].sort(),
    byClass: slices(byClass),
    byLiquidity: slices(byLiquidity),
    liquidAssetsPaise: byLiquidity.get('Liquid') ?? 0,
    sharedLine: sharedAccounts.length > 0 ? { fullPaise: sharedFull, sharePaise: sharedPart, accounts: sharedAccounts } : null,
  };
}

interface SeriesPoint {
  readonly date: PlainDate;
  readonly netWorth: number;
  readonly assets: number;
  readonly liabilities: number;
}

/**
 * A net-worth series at the viewer's share: the engine's `netWorthSeries` for each account alone,
 * each point weighted by the viewer's share in force on that date (dated shares, D3 RD8), then
 * summed. An account is one side, so its other side is 0 at every point.
 */
function weightedSeries(
  points: readonly PlainDate[],
  views: readonly AccountView[],
  rates: RateTable,
  existsAsOf: (account: AccountView, asOf: PlainDate) => boolean,
  shares: ViewerShares,
): { points: SeriesPoint[]; rateNeeded: Set<string> } {
  const rateNeeded = new Set<string>();
  const assets = points.map(() => 0);
  const liabilities = points.map(() => 0);
  const dates = points.map((p) => formatDate(p));
  for (const v of views) {
    const one = netWorthSeries(points, [v], rates, existsAsOf);
    for (const c of one.rateNeeded) rateNeeded.add(c);
    one.result.forEach((p, i) => {
      assets[i]! += shares.partOn(v.id, p.assets.paise, dates[i]!);
      liabilities[i]! += shares.partOn(v.id, p.liabilities.paise, dates[i]!);
    });
  }
  return {
    points: points.map((date, i) => ({ date, netWorth: assets[i]! + liabilities[i]!, assets: assets[i]!, liabilities: liabilities[i]! })),
    rateNeeded,
  };
}

/**
 * D1 hero + D2 allocation, as-of-today, over the viewer's OPEN visible accounts,
 * a joint account at the viewer's share, plus D1 RD12's shared line. Reconciles by
 * construction: `Σ byClass === Σ byLiquidity === assetsPaise` (all fold the same
 * Asset-side `currentValue`), and `netWorth === assets + liabilities`.
 */
export async function dashboardSummary(database: Db, userId: string): Promise<DashboardSummary> {
  const { db, sqlite } = database;
  const asOf = today(appClock());
  const rates = loadRateTable(db);

  const visibleIds = await accountsVisibleTo(db, userId);
  const visibleRows = fetchAccountRows(db, visibleIds);
  const openRows = visibleRows.filter((a) => a.status === 'open');
  // N-11: the line's rule (F1 RD10), an account counts from its start date. A start after today
  // can't be typed any more (C6), but a file may already hold one; it counts once it starts.
  const todayIso = formatDate(asOf);
  const rows = openRows.filter((a) => a.openingDate === null || a.openingDate <= todayIso);
  const openIds = rows.map((a) => a.id);
  // Today's balances in one grouped sum, valued through each module.
  // (Over every visible account at the shared "today" cuts, so the request sums once.)
  const cuts = todayCuts(asOf);
  const views = cutViews(rows, cuts.map(parseDate), ledgerCuts(sqlite, visibleIds, cuts));

  const shares = await sharesFor(db, userId, openIds);
  const { sharedLine, ...figures } = weightedFiguresOf(views, asOf, rates, shares);
  const sameName = sharedNames(visibleRows); // "HDFC (Mutual funds)" beside another HDFC
  const nameOf = new Map(rows.map((a) => [a.id, sectionedName(a, sameName)]));

  return {
    baseCurrency: baseCurrency(db),
    ...figures,
    sharedLine: sharedLine && {
      ...sharedLine,
      accounts: sharedLine.accounts
        .map((a) => ({ ...a, name: nameOf.get(a.id) ?? '' }))
        .sort((x, y) => Math.abs(y.fullPaise) - Math.abs(x.fullPaise)),
    },
    hasOpenAccounts: openRows.length > 0,
  };
}

// ── D3: net worth over time ──────────────────────────────────────────────────

export type Timeframe = '1M' | '3M' | '6M' | 'YTD' | '1Y' | 'ALL';

export interface HistoryPoint {
  readonly date: string;
  readonly netWorthPaise: number;
  readonly assetsPaise: number;
  readonly liabilitiesPaise: number;
}

export interface NetWorthHistory {
  readonly baseCurrency: string;
  readonly timeframe: Timeframe;
  readonly points: HistoryPoint[];
  /** Absolute + ratio change from the last month-end to today (D3 → D1 hero chip). Null if < 2 points. */
  readonly changeSinceLastMonth: { readonly absPaise: number; readonly pct: number | null } | null;
  /** Foreign currencies with no rate, excluded from the series (MC1 "rate needed"). */
  readonly rateNeededCurrencies: string[];
}

/** The earliest date any account "started": its opening_date, else its first tx, else today.
 *  Never after `fallback` (today): with every start in the future the line is one point today,
 *  where it threw before (N-10). */
function earliestStart(
  rows: readonly AccountRow[],
  /** Each account's first live row date (`ledgerCuts`). */
  firstRow: ReadonlyMap<string, string>,
  fallback: PlainDate,
  /** C5 C: the day the viewer joined each account they hold from a date (it starts there for them). */
  joinedOn?: ReadonlyMap<string, string>,
): PlainDate {
  let earliest: PlainDate | null = null;
  for (const a of rows) {
    const firstIso = firstRow.get(a.id);
    let start: PlainDate | null = a.openingDate ? parseStoredDate(a.openingDate) : firstIso !== undefined ? parseStoredDate(firstIso) : null;
    const joined = joinedOn?.get(a.id);
    if (joined !== undefined && (start === null || compareDates(parseDate(joined), start) > 0)) start = parseDate(joined);
    if (start !== null && (earliest === null || compareDates(start, earliest) < 0)) earliest = start;
  }
  return earliest !== null && compareDates(earliest, fallback) < 0 ? earliest : fallback;
}

/** The first day the viewer held each account they hold from a date (C5 C); none for the rest. */
function joinedDates(db: AppDb, userId: string, ids: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const [id, s] of viewerStretches(db, userId, ids)) {
    const first = s[0]?.from;
    if (first !== undefined && first !== SINCE_START) out.set(id, first);
  }
  return out;
}

/** Window start for a timeframe. ALL spans from the ledger's earliest account start. */
function windowStart(timeframe: Timeframe, todayDate: PlainDate, earliest: PlainDate): PlainDate {
  switch (timeframe) {
    case '1M':
      return todayDate.subtract({ months: 1 });
    case '3M':
      return todayDate.subtract({ months: 3 });
    case '6M':
      return todayDate.subtract({ months: 6 });
    case 'YTD':
      return todayDate.with({ month: 1, day: 1 });
    case '1Y':
      return todayDate.subtract({ years: 1 });
    case 'ALL':
      return earliest;
  }
}

/**
 * D3 net-worth-over-time: monthly month-end points (final point = today, so the
 * latest equals the D1 hero) over the viewer's visible accounts INCLUDING
 * closed ones (they count for the periods they were open — the one place D3
 * diverges from D1/D2). Dated opening (F1 RD10) is honored via `existsAsOf`:
 * an account with an `opening_date` contributes 0 to any point before it.
 */
export async function netWorthHistory(
  database: Db,
  userId: string,
  timeframe: Timeframe = '1Y',
): Promise<NetWorthHistory> {
  const { db, sqlite } = database;
  const todayDate = today(appClock());
  const rates = loadRateTable(db);

  // C5 C: a member who has left keeps their share of the dates they held (read-only; 0 after).
  const visibleIds = await accountsReadableBy(db, userId);
  const rows = fetchAccountRows(db, visibleIds); // open AND closed — the D3 asymmetry
  if (rows.length === 0) {
    return { baseCurrency: baseCurrency(db), timeframe, points: [], changeSinceLastMonth: null, rateNeededCurrencies: [] };
  }
  const ids = rows.map((a) => a.id);

  // RD10 gate: an account exists at `asOf` iff it opened on/before it. A null
  // opening_date (opened at ₹0) has no dated genesis, so it "always exists" and
  // simply contributes 0 until its first transaction — no opening to leak early.
  const openingDateById = new Map(rows.map((a) => [a.id, a.openingDate]));
  const existsAsOf = (account: AccountView, asOf: PlainDate): boolean => {
    const od = openingDateById.get(account.id) ?? null;
    return od === null || compareDates(parseStoredDate(od), asOf) <= 0;
  };

  // Never start before the ledger does: a window reaching back past the first account's start
  // would draw months of ₹0 and then a cliff that never happened (session 4; the mock starts
  // at the data).
  const earliest = earliestStart(rows, ledgerCuts(sqlite, visibleIds, todayCuts(todayDate)).first, todayDate, joinedDates(db, userId, ids));
  const start = windowStart(timeframe, todayDate, earliest);
  const from = compareDates(start, earliest) < 0 ? earliest : start;
  const points = monthEndPoints(from, todayDate);
  // A window reaching back to the start begins ON the ledger's first day, not its month end, so the
  // first weeks show (as the holdings chart).
  if (compareDates(from, earliest) === 0 && compareDates(points[0]!, earliest) !== 0) points.unshift(earliest);
  // Each account's balance at the points in one grouped sum, valued through its module.
  const views = cutViews(rows, points, ledgerCuts(sqlite, visibleIds, points.map((p) => formatDate(p))));
  // At the viewer's share on each month-end (D3 RD8).
  const seriesAgg = weightedSeries(points, views, rates, existsAsOf, await sharesFor(db, userId, ids));
  const series = seriesAgg.points;

  const historyPoints: HistoryPoint[] = series.map((p) => ({
    date: formatDate(p.date),
    netWorthPaise: p.netWorth,
    assetsPaise: p.assets,
    liabilitiesPaise: p.liabilities,
  }));

  // Change since last month = today − the previous month-end (the second-to-last
  // point; monthEndPoints appends today after the last historical month-end).
  let changeSinceLastMonth: NetWorthHistory['changeSinceLastMonth'] = null;
  if (series.length >= 2) {
    const last = series[series.length - 1]!;
    const prev = series[series.length - 2]!;
    const absPaise = last.netWorth - prev.netWorth;
    const base = Math.abs(prev.netWorth);
    changeSinceLastMonth = { absPaise, pct: base === 0 ? null : absPaise / base };
  }

  return {
    baseCurrency: baseCurrency(db),
    timeframe,
    points: historyPoints,
    changeSinceLastMonth,
    rateNeededCurrencies: [...seriesAgg.rateNeeded].sort(),
  };
}

// ── D3 RD6 / RD7: net worth by class over time (the Reports "Net worth" tab) ──

export interface ClassSeries {
  /** Module type ('bank', 'loan', …). */
  readonly type: string;
  readonly side: 'Asset' | 'Liability';
  /** The class's value at each point (liabilities natural-negative), aligned with `dates`. */
  readonly values: number[];
}

export interface NetWorthByClass {
  readonly baseCurrency: string;
  /** Month-end points through the window's end (the last one today when the window reaches it). */
  readonly dates: string[];
  /** Classes in catalogue order (the sidebar's), only those with a non-zero value somewhere. */
  readonly classes: ClassSeries[];
  /** Net worth at each point: the sum of the classes. */
  readonly netWorth: number[];
  readonly rateNeededCurrencies: string[];
}

/**
 * Net worth by class at each month end of the window (D3 RD6, the recap table with its Change
 * row, RD7), over the viewer's visible accounts including closed ones (as D3), honouring dated
 * openings, optionally shared accounts only. Each class's series is the engine's own
 * `netWorthSeries` over that class's accounts, so the classes sum to D3's net worth by
 * construction; no per-type branching (the type is a grouping key only).
 */
export async function netWorthByClass(
  database: Db,
  userId: string,
  range: { readonly from: string; readonly to: string },
): Promise<NetWorthByClass> {
  const { db, sqlite } = database;
  const todayDate = today(appClock());
  const rates = loadRateTable(db);
  const visibleIds = await accountsReadableBy(db, userId);
  const rows = fetchAccountRows(db, visibleIds);
  const empty: NetWorthByClass = { baseCurrency: baseCurrency(db), dates: [], classes: [], netWorth: [], rateNeededCurrencies: [] };
  if (rows.length === 0) return empty;

  const openingDateById = new Map(rows.map((a) => [a.id, a.openingDate]));
  const existsAsOf = (account: AccountView, asOf: PlainDate): boolean => {
    const od = openingDateById.get(account.id) ?? null;
    return od === null || compareDates(parseStoredDate(od), asOf) <= 0;
  };

  const end = compareDates(parseDate(range.to), todayDate) < 0 ? parseDate(range.to) : todayDate;
  // Never before the ledger (no months of ₹0 and a false cliff; as netWorthHistory).
  const ids = rows.map((a) => a.id);
  const ledgerStart = earliestStart(rows, ledgerCuts(sqlite, visibleIds, todayCuts(todayDate)).first, todayDate, joinedDates(db, userId, ids));
  const asked = parseDate(range.from);
  const start = compareDates(asked, ledgerStart) < 0 ? ledgerStart : asked;
  if (compareDates(start, end) > 0) return empty;
  const points = monthEndPoints(start, end);
  // Each account's balance at the points in one grouped sum, valued through its module.
  const views = cutViews(rows, points, ledgerCuts(sqlite, visibleIds, points.map((p) => formatDate(p))));

  const rateNeeded = new Set<string>();
  const shares = await sharesFor(db, userId, rows.map((a) => a.id));
  const byType = new Map<string, AccountView[]>();
  for (const v of views) byType.set(v.type, [...(byType.get(v.type) ?? []), v]);
  const order = new Map(MODULE_PROFILES.map((m, i) => [m.type, i]));
  const classes: ClassSeries[] = [];
  for (const [type, list] of [...byType.entries()].sort(
    ([a], [b]) => (order.get(a) ?? 99) - (order.get(b) ?? 99),
  )) {
    // At the viewer's share on each date (D3 RD8).
    const series = weightedSeries(points, list, rates, existsAsOf, shares);
    for (const c of series.rateNeeded) rateNeeded.add(c);
    const values = series.points.map((p) => p.netWorth);
    if (values.every((v) => v === 0)) continue;
    classes.push({ type, side: getModule(type).metadata.side, values });
  }
  const dates = points.map((p) => formatDate(p));
  const netWorthValues = dates.map((_, i) => classes.reduce((s, c) => s + (c.values[i] ?? 0), 0));
  return {
    baseCurrency: baseCurrency(db),
    dates,
    classes,
    netWorth: netWorthValues,
    rateNeededCurrencies: [...rateNeeded].sort(),
  };
}

// ── D4: account summary (grouped by module) ──────────────────────────────────

export interface AccountSummaryRow {
  readonly id: string;
  readonly name: string;
  /** Its own type (an EPS row sits in its EPF's section, S5 RD16). */
  readonly type: string;
  /** The account it belongs to (an EPF's EPS: listed right after it, indented). */
  readonly parentId: string | null;
  /** NATIVE balance (opening + Σtx as-of-today) in the account's own currency: the record, in full. */
  readonly balancePaise: number;
  /** The viewer's part of `balancePaise` today (H2 RD8 amended 2026-10-30): what the sidebar,
   *  section pages and All accounts show, so rows add to their subtotal and to net worth. */
  readonly sharePaise: number;
  /** The viewer's share in basis points when the account has other holders; null when sole. */
  readonly shareBp: number | null;
  readonly currency: string;
}

export interface AccountSummaryGroup {
  readonly type: string;
  /** Group subtotal at the viewer's share, converted to BASE, excluding any unrated members.
   *  Each account is converted in full, then weighted, exactly as D1's net worth, so the sidebar's
   *  groups add to its net worth. */
  readonly subtotalPaise: number;
  /** True when a member's foreign currency has no rate, so the subtotal is partial. */
  readonly rateNeeded: boolean;
  readonly accounts: AccountSummaryRow[];
}

/**
 * D4 account summary: the viewer's OPEN visible accounts grouped by module type.
 * Each row's balance is NATIVE (the crown-jewel `accountBalance` — the same
 * derived figure D1 sums); the group SUBTOTAL is converted to base via the one
 * `toBase` boundary so a group mixing currencies (e.g. a USD and an INR stocks
 * account) reconciles to the hero rather than summing paise across currencies.
 * A member with no rate is excluded from the subtotal and flags `rateNeeded`.
 */
export async function accountSummary(database: Db, userId: string): Promise<AccountSummaryGroup[]> {
  const { db, sqlite } = database;
  const todayIso = formatDate(today(appClock()));
  const rates = loadRateTable(db);

  const visibleIds = await accountsVisibleTo(db, userId);
  const rows = fetchAccountRows(db, visibleIds).filter((a) => a.status === 'open');
  const shares = await sharesFor(db, userId, rows.map((a) => a.id));
  // Every balance in one grouped sum: it was one query per account, 100 to 200 a page.
  const sumsToday = ledgerCuts(sqlite, visibleIds, todayCuts(parseDate(todayIso))).sums;

  // Grouped by section: an EPF's EPS joins its EPF's (S5 RD16).
  const groups = new Map<string, AccountSummaryRow[]>();
  for (const a of rows) {
    const section = sectionTypeOf(a.type);
    const list = groups.get(section) ?? [];
    // opening + the rows dated on or before today, as `accountBalance` reads it.
    const s = sumsToday.get(a.id);
    const balancePaise = a.openingPaise + (s ? s[0]! + s[1]! : 0);
    list.push({
      id: a.id,
      name: a.name,
      type: a.type,
      parentId: a.parentAccountId ?? null,
      balancePaise,
      sharePaise: shares.partOn(a.id, balancePaise, todayIso),
      shareBp: shares.isShared(a.id) ? shares.shareBpOn(a.id, todayIso) : null,
      currency: a.currency,
    });
    groups.set(section, list);
  }

  return [...groups.entries()].map(([type, accounts]) => {
    // By name, a child right after its parent (an orphan, its parent unseen, sorts by its own name).
    const byId = new Map(accounts.map((r) => [r.id, r]));
    const lead = (r: AccountSummaryRow): AccountSummaryRow => (r.parentId ? byId.get(r.parentId) : undefined) ?? r;
    const order = (x: AccountSummaryRow, y: AccountSummaryRow): number =>
      lead(x).name.localeCompare(lead(y).name) || (lead(x) === x ? 0 : 1) - (lead(y) === y ? 0 : 1) || x.name.localeCompare(y.name);
    let subtotal = 0;
    let rateNeeded = false;
    for (const r of accounts) {
      const converted = toBase(Money.fromPaise(r.balancePaise, r.currency), rates);
      if (converted === null) rateNeeded = true;
      else subtotal += shares.partOn(r.id, converted.paise, todayIso);
    }
    return {
      type,
      accounts: accounts.sort(order),
      subtotalPaise: subtotal,
      rateNeeded,
    };
  });
}

// ── D4: recent activity (cross-account feed) ─────────────────────────────────

export interface ActivityRow {
  readonly id: string;
  readonly accountId: string;
  readonly accountName: string;
  readonly date: string;
  readonly amountPaise: number;
  /** This row's OWN native currency (M9b/MC3 — the feed's amount is native, never converted). */
  readonly currency: string;
  /** How the row reads in the feed. A transfer is collapsed to a single entry. */
  readonly entryType: 'ordinary' | 'transfer' | 'valuationMark';
  readonly categoryName: string | null;
  readonly payeeName: string | null;
  /** For a transfer: source → destination (derived from the leg's sign). Null names when the counterpart isn't visible. */
  readonly transferFromName: string | null;
  readonly transferToName: string | null;
  /** For a transfer: the other leg and its account (null when the viewer can't see it). */
  readonly transferPartnerId: string | null;
  readonly counterpartAccountId: string | null;
  /** The other side is in a closed account: the row reads "(closed)" and doesn't change. */
  readonly counterpartClosed: boolean;
  /** For a value update: its asserted value (signed as the account's side). */
  readonly markTargetPaise: number | null;
  /** For a CROSS-CURRENCY transfer (MC2): the counterpart leg's own currency +
   *  amount, so the feed can show "both native legs clearly" (MC3 AC). Null for
   *  an ordinary row or a same-currency transfer. */
  readonly counterpartCurrency: string | null;
  readonly counterpartAmountPaise: number | null;
  /** True when this row's account is shared — the UI then surfaces `enteredByName` (H3 audit). */
  readonly isSharedAccount: boolean;
  readonly enteredByName: string | null;
  /** The row's free-text notes (All transactions shows them as Memo). */
  readonly notes: string | null;
  /** All transactions edits in place (ACTUAL-PARITY #5): the category id and the version stamp
   *  the edit's optimistic-concurrency check needs. A transfer's is its spending-side leg's. */
  readonly categoryId: string | null;
  /** The row's category can be set (an ordinary row, or a transfer between a spending account and
   *  a holding whose other side the viewer can see). */
  readonly takesCategory: boolean;
  readonly updatedAt: string;
}

interface FeedRow {
  id: string;
  accountId: string;
  accountName: string;
  date: string;
  sequence: number;
  amountPaise: number;
  currency: string;
  kind: 'ordinary' | 'valuationMark';
  categoryName: string | null;
  payeeName: string | null;
  transferPartnerId: string | null;
  counterpartAccountName: string | null;
  counterpartAccountId: string | null;
  counterpartOwnerId: string | null;
  counterpartOwnerName: string | null;
  counterpartStatus: string | null;
  accountOwnerId: string;
  accountOwnerName: string | null;
  counterpartCurrency: string | null;
  counterpartAmountPaise: number | null;
  markTargetPaise: number | null;
  enteredByName: string | null;
  notes: string | null;
  categoryId: string | null;
  updatedAt: string;
  accountType: string;
  counterpartAccountType: string | null;
  partnerCategoryId: string | null;
  partnerCategoryName: string | null;
}

/** Build `@v0,@v1,…` named placeholders + a params object for an IN (...) list. */
function inList(ids: readonly string[], prefix: string): { sql: string; params: Record<string, string> } {
  const params: Record<string, string> = {};
  const names = ids.map((id, i) => {
    const name = `${prefix}${i}`;
    params[name] = id;
    return `@${name}`;
  });
  return { sql: names.join(','), params };
}

/** Where a page of the feed ends: the last row's place in `(date, sequence, id)`, newest first.
 *  The id breaks ties between accounts (`sequence` counts within one account's day). */
export interface ActivityCursor {
  readonly date: string;
  readonly sequence: number;
  readonly id: string;
}

/** A cursor as the page carries it (`date|sequence|id`), and back; null when unreadable. */
export function cursorText(c: ActivityCursor): string {
  return `${c.date}|${c.sequence}|${c.id}`;
}
export function parseCursor(text: string | null | undefined): ActivityCursor | null {
  const m = /^(\d{4}-\d{2}-\d{2})\|(-?\d{1,15})\|([\w-]{1,64})$/u.exec(text ?? '');
  return m ? { date: m[1]!, sequence: Number(m[2]), id: m[3]! } : null;
}

/**
 * D4 recent activity: the most recent transactions across the viewer's OPEN
 * visible accounts, newest first by (date, sequence). Transfers are collapsed to
 * ONE "Transfer A → B" entry (never both legs — a double-counted transfer is a
 * defect). The counterpart-name join is visibility-gated, so a cross-member
 * transfer never leaks the other account's name to a non-holder. Read-only: rows
 * carry ids the UI links to the register (no mutation here).
 */
export async function recentActivity(
  database: Db,
  userId: string,
  n = 15,
  /** All transactions' search (D4 RD6): payee, category, account (either side of a transfer) or notes. */
  q?: string,
  /** `notes: false` for a feed that never shows them (the dashboard's Recent activity): each
   *  row's `notes` is then null and no note is read. */
  opts: {
    readonly notes?: boolean;
    /** Only these rows (and a transfer's other half, so it collapses as the list does): what a save
     *  answers with, so All transactions patches its rows in place. */
    readonly ids?: readonly string[];
  } = {},
): Promise<ActivityRow[]> {
  return (await activityPage(database, userId, { limit: n, q, ...opts })).rows;
}

/**
 * One page of the feed (All transactions loads by pages as the person scrolls): up to `limit`
 * rows after `after` (newest first), and where the page ended when more follow. Each transfer is
 * one row, placed at its leg that sorts first, so its two legs never land on two pages.
 */
export async function activityPage(
  database: Db,
  userId: string,
  opts: {
    readonly limit: number;
    readonly q?: string;
    readonly after?: ActivityCursor | null;
    readonly notes?: boolean;
    readonly ids?: readonly string[];
  },
): Promise<{ rows: ActivityRow[]; next: ActivityCursor | null }> {
  const { db, sqlite } = database;
  const n = opts.limit;

  const visibleIds = await accountsVisibleTo(db, userId);
  const visibleRows = fetchAccountRows(db, visibleIds);
  const openIds = visibleRows.filter((a) => a.status === 'open').map((a) => a.id);
  if (openIds.length === 0) return { rows: [], next: null };
  // A transfer's other side is named whenever the viewer can see it, open or closed (C8: a closed
  // one reads "HDFC (closed)"; it read as a hidden account before), or held it on the row's date
  // (C5 C).
  const allVisibleIds = [...visibleRows.map((a) => a.id), ...(await accountsHeldBefore(db, userId))];

  const shared = sharedAccountIds(db, openIds);

  const term = opts.q?.trim();
  // LIKE with `!` as the escape character, so a typed % or _ matches itself.
  const search = term ? `%${term.replace(/[!%_]/g, (c) => '!' + c)}%` : null;
  // An amount matches as typed with or without grouping or ₹ ("1200", "1,200", "₹1,200.50"), as the
  // register's search does.
  const digits = term?.replace(/[,\s₹$€£]/gu, '') ?? '';
  const amountSearch = /^\d+(\.\d{0,2})?$/u.test(digits) ? `%${digits}%` : null;
  const feedIn = inList(openIds, 'a');
  const only = opts.ids ? inList(opts.ids, 'i') : null;
  // Counterpart names are gated to the SAME visible set (privacy): an
  // out-of-scope counterpart resolves to NULL, shown as a bare "Transfer".
  const cpIn = inList(allVisibleIds, 'c');
  // The other leg is in this feed too (open, visible, held on its date: `cpa` is gated so): the
  // transfer is shown once, at the leg that sorts first. Never NULL: `NOT` of a NULL drops the row.
  const partnerInFeed = `(cpa.id IS NOT NULL AND pt.deleted_at IS NULL AND cpa.id IN (${feedIn.sql}))`;

  const select = (where: string, limit: number, params: Record<string, unknown>): (FeedRow & { partnerInFeed: number })[] =>
    sqlite
      .prepare(
        `SELECT
         t.id                  AS id,
         t.account_id          AS accountId,
         acc.name              AS accountName,
         t.date                AS date,
         t.sequence            AS sequence,
         t.amount_paise        AS amountPaise,
         acc.currency          AS currency,
         t.kind                AS kind,
         cat.name              AS categoryName,
         p.display_name        AS payeeName,
         t.transfer_partner_id AS transferPartnerId,
         cpa.name              AS counterpartAccountName,
         cpa.id                AS counterpartAccountId,
         cpa.owner_id          AS counterpartOwnerId,
         cpo.display_name      AS counterpartOwnerName,
         cpa.status            AS counterpartStatus,
         acc.owner_id          AS accountOwnerId,
         ao.display_name       AS accountOwnerName,
         cpa.currency          AS counterpartCurrency,
         pt.amount_paise       AS counterpartAmountPaise,
         t.mark_target_paise   AS markTargetPaise,
         u.display_name        AS enteredByName,
         ${opts.notes === false ? 'NULL' : listedNoteSql('t.notes')} AS notes,
         t.category_id         AS categoryId,
         t.updated_at          AS updatedAt,
         acc.type              AS accountType,
         cpa.type              AS counterpartAccountType,
         CASE WHEN cpa.id IS NOT NULL THEN pt.category_id END AS partnerCategoryId,
         CASE WHEN cpa.id IS NOT NULL THEN pcat.name END      AS partnerCategoryName,
         CASE WHEN ${partnerInFeed} THEN 1 ELSE 0 END         AS partnerInFeed
       FROM transactions t
       JOIN accounts acc         ON acc.id = t.account_id
       LEFT JOIN categories cat  ON cat.id = t.category_id
       LEFT JOIN payees p        ON p.id   = t.payee_id
       LEFT JOIN transactions pt ON pt.id  = t.transfer_partner_id
       LEFT JOIN accounts cpa    ON cpa.id = pt.account_id AND cpa.id IN (${cpIn.sql}) AND ${heldRowSql('pt', '@viewer')}
       LEFT JOIN categories pcat ON pcat.id = pt.category_id
       LEFT JOIN users u         ON u.id   = t.entered_by
       LEFT JOIN users ao        ON ao.id  = acc.owner_id
       LEFT JOIN users cpo       ON cpo.id = cpa.owner_id
       WHERE t.account_id IN (${feedIn.sql})
         AND t.deleted_at IS NULL
         AND ${heldRowSql('t', '@viewer')}
         ${where}
       ORDER BY t.date DESC, t.sequence DESC, t.id DESC
       LIMIT @limit`,
      )
      .all({ viewer: userId, ...feedIn.params, ...cpIn.params, limit, ...params }) as (FeedRow & { partnerInFeed: number })[];

  // A transfer matches by either leg's memo (each leg keeps its own).
  const searchSql = search
    ? `AND (p.display_name LIKE @q ESCAPE '!' OR cat.name LIKE @q ESCAPE '!' OR (cpa.id IS NOT NULL AND pcat.name LIKE @q ESCAPE '!') OR acc.name LIKE @q ESCAPE '!'
              OR cpa.name LIKE @q ESCAPE '!' OR t.notes LIKE @q ESCAPE '!' OR (cpa.id IS NOT NULL AND pt.notes LIKE @q ESCAPE '!')${amountSearch ? ` OR printf('%.2f', abs(t.amount_paise) / 100.0) LIKE @qa` : ''})`
    : '';
  const after = opts.after ?? null;
  // One row more than asked says whether another page follows.
  const feed = select(
    `${only ? `AND (t.id IN (${only.sql}) OR t.transfer_partner_id IN (${only.sql}))` : ''}
         AND NOT (${partnerInFeed} AND (pt.date, pt.sequence, pt.id) > (t.date, t.sequence, t.id))
         ${after ? 'AND (t.date, t.sequence, t.id) < (@ad, @as, @ai)' : ''}
         ${searchSql}`,
    n + 1,
    { ...(only?.params ?? {}), ...(after ? { ad: after.date, as: after.sequence, ai: after.id } : {}), ...(search ? { q: search } : {}), ...(amountSearch ? { qa: amountSearch } : {}) },
  );
  const more = feed.length > n;
  if (more) feed.length = n;
  // A transfer reads from the side the money leaves: when the shown leg is the one it arrives in,
  // the other leg's row (in this feed, never on this page) is read by its id.
  const wanted = feed.filter((f) => f.transferPartnerId !== null && f.amountPaise > 0 && f.partnerInFeed === 1).map((f) => f.transferPartnerId!);
  const want = inList(wanted, 'w');
  const partners = wanted.length > 0 ? select(`AND t.id IN (${want.sql})`, wanted.length, want.params) : [];
  const byId = new Map(partners.map((f) => [f.id, f]));
  // C8: names as lists show them, "HDFC (Bob's)", "HDFC (closed)", "HDFC (Mutual funds)".
  const sameName = sharedNames(visibleRows);
  for (const f of [...feed, ...partners]) {
    f.accountName = accountLabel({ name: f.accountName, type: f.accountType, ownerId: f.accountOwnerId, status: 'open' }, f.accountOwnerName, userId, sameName);
    if (f.counterpartAccountName !== null) {
      f.counterpartAccountName = accountLabel(
        { name: f.counterpartAccountName, type: f.counterpartAccountType ?? '', ownerId: f.counterpartOwnerId ?? userId, status: f.counterpartStatus ?? 'open' },
        f.counterpartOwnerName,
        userId,
        sameName,
      );
    }
  }

  const out: ActivityRow[] = [];
  for (const f of feed) {
    if (f.transferPartnerId !== null) {
      // One side for every transfer: the one the money leaves, when both are here (it showed
      // whichever leg came first: "UTI from HDFC Salary" beside "HDFC Salary to Parag Parikh").
      const partner = byId.get(f.transferPartnerId);
      const r = f.amountPaise > 0 && partner ? partner : f;
      // Direction from the leg's sign: outflow (<0) = this account is the source.
      const outflow = r.amountPaise < 0;
      out.push({
        id: r.id,
        accountId: r.accountId,
        accountName: r.accountName,
        date: r.date,
        amountPaise: r.amountPaise,
        currency: r.currency,
        entryType: 'transfer',
        // A transfer's category sits on its spending-side leg (item 2.5): shown from either leg.
        categoryName: r.categoryName ?? r.partnerCategoryName,
        payeeName: null,
        transferFromName: outflow ? r.accountName : r.counterpartAccountName,
        transferToName: outflow ? r.counterpartAccountName : r.accountName,
        // Only for a leg in an account the viewer can see (P0).
        transferPartnerId: r.counterpartAccountId ? r.transferPartnerId : null,
        counterpartAccountId: r.counterpartAccountId,
        counterpartClosed: r.counterpartStatus === 'closed',
        markTargetPaise: null,
        // Only meaningful when the counterpart is VISIBLE (its currency is gated
        // to the viewer's set via the `cpa` join → null when not visible, so
        // this also gates the leg AMOUNT below — P0: never leak a non-holder's
        // leg) AND a DIFFERENT currency (MC2). A same-currency transfer's other
        // leg is just the negation, nothing new to show (MC3: don't clutter).
        counterpartCurrency:
          r.counterpartCurrency !== null && r.counterpartCurrency !== r.currency
            ? r.counterpartCurrency
            : null,
        counterpartAmountPaise:
          r.counterpartCurrency !== null && r.counterpartCurrency !== r.currency
            ? r.counterpartAmountPaise
            : null,
        isSharedAccount: shared.has(r.accountId),
        enteredByName: r.enteredByName,
        notes: r.notes,
        categoryId: r.categoryId ?? r.partnerCategoryId,
        takesCategory: r.counterpartAccountType !== null && transferTakesCategory(r.accountType, r.counterpartAccountType),
        updatedAt: r.updatedAt,
      });
    } else {
      const r = f;
      out.push({
        id: r.id,
        accountId: r.accountId,
        accountName: r.accountName,
        date: r.date,
        amountPaise: r.amountPaise,
        currency: r.currency,
        entryType: r.kind === 'valuationMark' ? 'valuationMark' : 'ordinary',
        categoryName: r.categoryName,
        payeeName: r.payeeName,
        transferFromName: null,
        transferToName: null,
        transferPartnerId: null,
        counterpartAccountId: null,
        counterpartClosed: false,
        markTargetPaise: r.markTargetPaise,
        counterpartCurrency: null,
        counterpartAmountPaise: null,
        isSharedAccount: shared.has(r.accountId),
        enteredByName: r.enteredByName,
        notes: r.notes,
        categoryId: r.categoryId,
        takesCategory: r.kind === 'ordinary',
        updatedAt: r.updatedAt,
      });
    }
  }
  const last = feed[feed.length - 1];
  return { rows: out, next: more && last ? { date: last.date, sequence: last.sequence, id: last.id } : null };
}

// ── S2: per-holding value / cost basis / return ──────────────────────────────

export interface HoldingMetrics {
  readonly accountId: string;
  readonly currency: string;
  /** opening + Σtx as-of-today — the same derived value D1 sums (no drift). */
  readonly currentValuePaise: number;
  /** What was put into what is still held (S2 RD3: a withdrawal takes out its share of value). */
  readonly costBasisPaise: number;
  /** currentValue − costBasis (honest sign). */
  readonly returnPaise: number;
  /** return ÷ costBasis, or null when cost basis is 0 (show "—%"). */
  readonly returnPct: number | null;
  readonly side: 'Asset' | 'Liability';
  readonly markable: boolean;
  /** True for holding-class modules (show the value/invested/return header). */
  readonly isHolding: boolean;
  /** Return per year since tracking began (S2 RD6, I2), or null ("—": under a year, no value update
   *  since it began, a liability, or no rate solves the flows). */
  readonly annualReturn: number | null;
  /** The day tracking began (ISO), the start of `annualReturn`'s window. */
  readonly trackedSince: string | null;
  /** The day its value was last known (rule 3): the last value update or growth typed
   *  inside it, else the day tracking began. Null with no start at all. */
  readonly lastUpdated: string | null;
  /** C7: `lastUpdated` is older than the profile's `staleAfterMonths` (3 for funds, stocks and gold,
   *  13 for the rest); "Last updated" then reads amber. Never on a closed account. */
  readonly stale: boolean;
  /** C1 A: the stated yearly rate of a holding whose details say its interest is paid out (the
   *  holding never sees the interest; it's typed at the bank), shown "7.1% a year, paid out" in
   *  place of the measured return. Null otherwise. */
  readonly paidOutRate: number | null;
  /** Rule 4 (N-15): what a CLOSED asset holding earned, money out minus money in (its
   *  return and Invested are 0 once the money left). Null while open, and for a liability. */
  readonly earnedPaise: number | null;
  /** A markable liability (a loan) reads above zero: payments alone passed what was owed
   *  (each EMI counts in full; its interest arrives only with an Update value or its own row). The
   *  register and the Loans section ask for the lender's figure. Never computed (data hard line). */
  readonly passedZero: boolean;
  /** An asset holding reads below zero (more was taken out than its recorded value), so the
   *  register asks for a value update dated before the withdrawal. */
  readonly overdrawn: boolean;
}


/**
 * The S2 holding metrics for one account, via the SAME aggregation contract D1
 * reads (`valuationOf` + `holdingReturn`) — so the holding header can never
 * disagree with the dashboard or the register. Visibility-gated: returns null
 * for a non-visible or missing account (the route already 404s via
 * `registerView`; this is defense in depth). Works for any module — a spending
 * account reports `isHolding: false`, cost basis == value, return 0.
 */
export async function holdingMetrics(
  database: Db,
  userId: string,
  accountId: string,
): Promise<HoldingMetrics | null> {
  const { db } = database;
  if (!(await isAccountVisibleTo(db, userId, accountId))) return null;

  const rows = fetchAccountRows(db, [accountId]);
  const account = rows[0];
  if (!account) return null;

  const txByAccount = fetchTxByAccount(db, [accountId]);
  const view = toViews(rows, txByAccount)[0]!;
  const asOf = today(appClock());
  const valuation = valuationOf(view, asOf);
  const ret = holdingReturn(valuation);
  const meta = getModule(account.type).metadata;
  // H2 RD11, S2 RD15: a member who holds the account
  // from a date is measured from that day, as their register starts there.
  const from = joinedAfterStart(db, userId, account, view);
  const basis = from === null ? valuation.costBasis.paise : basisFrom(view, from, asOf);
  const returnPaise = valuation.currentValue.paise - basis;

  return {
    accountId,
    currency: account.currency,
    currentValuePaise: valuation.currentValue.paise,
    costBasisPaise: basis,
    returnPaise: from === null ? ret.amount.paise : returnPaise,
    returnPct: from === null ? ret.pct : basis === 0 ? null : returnPaise / basis,
    side: valuation.side,
    markable: meta.markable,
    isHolding: meta.accountClass === 'holding',
    ...ownAnnualReturn(account, view, asOf, from),
    ...lastUpdatedOf(account, view, asOf),
    paidOutRate: paidOutRate(account.type, account.infoJson),
    earnedPaise: account.status === 'closed' && meta.accountClass === 'holding' ? holdingEarned(view, asOf) : null,
    overdrawn: meta.accountClass === 'holding' && valuation.side === 'Asset' && valuation.currentValue.paise < 0,
    passedZero: account.status === 'open' && meta.markable && valuation.side === 'Liability' && valuation.currentValue.paise > 0,
  };
}

// ── I1 + I2: holdings over time and return per year ──

/** The day an account's tracking began: its opening date, else its first transaction's, else null. */
function trackedSinceOf(account: AccountRow, view: AccountView): PlainDate | null {
  if (account.openingDate) return parseStoredDate(account.openingDate);
  let first: PlainDate | null = null;
  for (const t of view.transactions) if (first === null || compareDates(t.date, first) < 0) first = t.date;
  return first;
}

/** Earlier than any row, the open end for "the last value date ever". */
const BEFORE_ANY = parseDate('0001-01-01');

/**
 * Rule 3 and C7: when the holding's value was last known, and whether that is
 * older than its profile's `staleAfterMonths` (a profile field, never a type check).
 */
function lastUpdatedOf(account: AccountRow, view: AccountView, asOf: PlainDate): { lastUpdated: string | null; stale: boolean } {
  const last = lastValueDate(view, BEFORE_ANY, asOf) ?? trackedSinceOf(account, view);
  if (last === null) return { lastUpdated: null, stale: false };
  const months = moduleProfile(account.type)?.staleAfterMonths;
  // A holding whose interest is paid out keeps its value (C1 A), so it never goes stale.
  const fixed = paidOutRate(account.type, account.infoJson) !== null;
  const stale = account.status === 'open' && !fixed && months !== undefined && compareDates(last.add({ months }), asOf) < 0;
  return { lastUpdated: formatDate(last), stale };
}

/**
 * The day the viewer joined the account, when they hold it from a date after its tracking began
 * (not its owner, not a grant from before migration 0013); null otherwise. Such a member's holding
 * figures start that day (H2 RD11, S2 RD15).
 */
function joinedAfterStart(db: AppDb, userId: string, account: AccountRow, view: AccountView): PlainDate | null {
  const joined = joinedDates(db, userId, [account.id]).get(account.id);
  const tracked = trackedSinceOf(account, view);
  if (joined === undefined || tracked === null) return null;
  const day = parseDate(joined);
  return compareDates(day, tracked) > 0 ? day : null;
}

/**
 * Money put in, counted from `from` (H2 RD11): the holding's value at the end of the day before,
 * which stands for everything put in until then, plus what was put in (less taken out) since. The
 * contract's own figures at two dates, no type check.
 */
function basisFrom(view: AccountView, from: PlainDate, asOf: PlainDate): number {
  const before = valuationOf(view, from.subtract({ days: 1 }));
  return valuationOf(view, asOf).costBasis.paise - before.costBasis.paise + before.currentValue.paise;
}

/** S2 RD6 for one holding, in full (the register's figures): from tracking's start to the last row
 *  that told its value (a value update or growth typed inside it; rule 3). For a member who
 *  joined later (`from`), from the end of the day before they joined, at the value then. */
function ownAnnualReturn(
  account: AccountRow,
  view: AccountView,
  asOf: PlainDate,
  from: PlainDate | null = null,
): { annualReturn: number | null; trackedSince: string | null } {
  const tracked = trackedSinceOf(account, view);
  if (tracked === null) return { annualReturn: null, trackedSince: null };
  const since = from === null ? tracked : from.subtract({ days: 1 });
  // A closed holding (rule 4): the same end, unless a write-off came after it or it never had a value.
  const end = account.status === 'closed' ? closedEndDate(view, since, asOf) : lastValueDate(view, since, asOf);
  const flows = end && holdingFlows(view, since, end);
  return { annualReturn: flows ? annualReturn([flows]) : null, trackedSince: formatDate(from ?? tracked) };
}

/** The viewer's open visible accounts of one section (module type), with their views and shares. */
async function sectionAccounts(database: Db, userId: string, type: string) {
  const { db } = database;
  const rows = fetchAccountRows(db, await accountsVisibleTo(db, userId)).filter(
    (a) => a.status === 'open' && sectionTypeOf(a.type) === type,
  );
  const views = toViews(rows, fetchTxByAccount(db, rows.map((a) => a.id)));
  return { rows, views, shares: await sharesFor(db, userId, rows.map((a) => a.id)) };
}

/** A section's return per year and what it leaves out (S2 RD6, RD12). */
export interface SectionAnnualReturn {
  readonly rate: number | null;
  /** Holdings with no value update or growth row since they began: left out, with a note. */
  readonly notValued: number;
  /** C1 A: holdings whose interest is paid out, left out (they show their stated rate). */
  readonly paidOut: number;
}

/**
 * A section's return per year at the viewer's share (S2 RD6): every holding's flows, each weighted
 * by the share on its date, merged by day, each holding ending where its value was last known (the
 * register's rule; rule 3: it ended today before, so seven months since an FD's last
 * interest row counted as earning nothing). A holding never valued since it began is left out and
 * counted in `notValued`. Null rate when the section mixes currencies (only today's rate is kept,
 * so old foreign flows can't be converted honestly).
 */
export async function sectionAnnualReturnDetail(database: Db, userId: string, type: string): Promise<SectionAnnualReturn> {
  const { rows, views, shares } = await sectionAccounts(database, userId, type);
  if (rows.length === 0 || new Set(rows.map((a) => a.currency)).size > 1) return { rate: null, notValued: 0, paidOut: 0 };
  const asOf = today(appClock());
  const all: HoldingFlows[] = [];
  let notValued = 0;
  let paidOut = 0;
  rows.forEach((a, i) => {
    const f = viewerFlows(a, views[i]!, shares, asOf);
    if (f === 'paidOut') paidOut += 1;
    else if (f === 'notValued') notValued += 1;
    else if (f && f !== 'paidInOnly') all.push(f);
  });
  return { rate: annualReturn(all), notValued, paidOut };
}

/**
 * One open holding's flows at the viewer's share, the step its section's rate sums (S2 RD6, RD12,
 * RD14): 'paidOut' for a holding whose interest is paid out (C1 A: it shows its stated rate),
 * 'notValued' with no value row since it began, null with no flow of the viewer's.
 */
function viewerFlows(a: AccountRow, view: AccountView, shares: ViewerShares, asOf: PlainDate): HoldingFlows | 'paidOut' | 'notValued' | 'paidInOnly' | null {
  if (paidOutRate(a.type, a.infoJson) !== null) return 'paidOut';
  // S5 RD16 (E2): an EPS counts at what was paid in; it earns nothing, so it stays out of the rate.
  if (moduleProfile(a.type)?.paidInOnly) return 'paidInOnly';
  const since = trackedSinceOf(a, view);
  if (since === null) return null;
  const end = lastValueDate(view, since, asOf);
  if (end === null) return 'notValued';
  const flows = holdingFlows(view, since, end);
  return flows ? sharedFlows(a, view, flows, shares) : null;
}

/**
 * A shared holding's return per year at the viewer's share, for its row in the section (a
 * check found the row read the holding's own 26.0 % beside the section's 18.9 % for Bob,
 * who joined at a higher value). The same flows as the section's rate (`viewerFlows`), so a
 * one-holding section's row and headline agree. Null for a holding the viewer's share never
 * changed on (its row keeps the register's figure) or with no rate.
 */
export async function sharedAnnualReturns(database: Db, userId: string, ids: readonly string[]): Promise<Map<string, number | null>> {
  const { db } = database;
  const rows = fetchAccountRows(db, ids);
  const shares = await sharesFor(db, userId, rows.map((a) => a.id));
  const changed = rows.filter((a) => shares.changeDates(a.id).length > 0);
  const out = new Map<string, number | null>();
  if (changed.length === 0) return out;
  const views = toViews(changed, fetchTxByAccount(db, changed.map((a) => a.id)));
  const asOf = today(appClock());
  changed.forEach((a, i) => {
    const f = viewerFlows(a, views[i]!, shares, asOf);
    out.set(a.id, f && typeof f !== 'string' ? annualReturn([f]) : null);
  });
  return out;
}

/**
 * One holding's flows at the viewer's share (S2 RD6): each flow weighted by the share on its
 * date, and each change of the viewer's share inside the window counted as money moved at the
 * holding's value that day (the value at the end of the day before, as the share applies from its
 * date): a share that falls is money taken out, one that rises money put in. Without it a holding
 * half given to Bob read about 0 % a year for Alice and "—" for Bob. A member who joined after the
 * holding began is measured from their first flow (under a year, "—").
 * Null when the viewer has no flow in it.
 */
function sharedFlows(account: AccountRow, view: AccountView, flows: HoldingFlows, shares: ViewerShares): HoldingFlows | null {
  const module = getModule(account.type);
  const out = flows.flows.map((f) => ({ date: f.date, paise: shares.partOn(account.id, f.paise, formatDate(f.date)) }));
  for (const iso of shares.changeDates(account.id)) {
    const day = parseDate(iso);
    if (compareDates(day, flows.start) <= 0 || compareDates(day, flows.end) > 0) continue;
    const before = day.subtract({ days: 1 });
    const value = module.currentValue(view, before).paise;
    const moved = shares.partOn(account.id, value, formatDate(before)) - shares.partOn(account.id, value, iso);
    if (moved !== 0) out.push({ date: day, paise: moved });
  }
  const kept = out.filter((f) => f.paise !== 0).sort((x, y) => compareDates(x.date, y.date));
  if (kept.length === 0) return null;
  const heldAtStart = shares.shareBpOn(account.id, formatDate(flows.start)) !== 0;
  return { start: heldAtStart ? flows.start : kept[0]!.date, end: flows.end, flows: kept };
}

/** The section's return per year alone (see `sectionAnnualReturnDetail`). */
export async function sectionAnnualReturn(database: Db, userId: string, type: string): Promise<number | null> {
  return (await sectionAnnualReturnDetail(database, userId, type)).rate;
}

export interface ValueInvestedHistory {
  readonly timeframe: Timeframe;
  /** Month ends, the last one today; value and invested in base for a section, native for one account. */
  readonly points: { readonly date: string; readonly valuePaise: number; readonly investedPaise: number }[];
  readonly rateNeededCurrencies: string[];
}

/**
 * Chart I1: value against money put in, at each month end of the window (the Dashboard's ranges).
 * `{ accountId }` is one holding in full and in its own currency (the register's figures);
 * `{ type }` is a section's open holdings at the viewer's share, in base through `toBase` (one
 * current rate across history, as D3). An account adds nothing before its opening date (F1 RD10).
 */
export async function valueInvestedHistory(
  database: Db,
  userId: string,
  scope: { readonly accountId: string } | { readonly type: string },
  timeframe: Timeframe,
): Promise<ValueInvestedHistory | null> {
  const { db } = database;
  const todayDate = today(appClock());
  const single = 'accountId' in scope;
  let rows: AccountRow[];
  let views: AccountView[];
  let part: (id: string, paise: number, date: string) => number;
  if ('accountId' in scope) {
    if (!(await isAccountVisibleTo(db, userId, scope.accountId))) return null;
    rows = fetchAccountRows(db, [scope.accountId]);
    views = toViews(rows, fetchTxByAccount(db, [scope.accountId]));
    part = (_id, paise) => paise;
  } else {
    const s = await sectionAccounts(database, userId, scope.type);
    rows = s.rows;
    views = s.views;
    part = s.shares.partOn;
  }
  const empty: ValueInvestedHistory = { timeframe, points: [], rateNeededCurrencies: [] };
  let earliest: PlainDate | null = null;
  // C5 C: an account held from a date starts there for the viewer (nothing from before they joined).
  const joined = joinedDates(db, userId, rows.map((a) => a.id));
  for (const [i, a] of rows.entries()) {
    let s = trackedSinceOf(a, views[i]!);
    const j = joined.get(a.id);
    if (s !== null && j !== undefined && compareDates(parseDate(j), s) > 0) s = parseDate(j);
    if (s !== null && (earliest === null || compareDates(s, earliest) < 0)) earliest = s;
  }
  if (earliest === null) return empty;
  const start = windowStart(timeframe, todayDate, earliest);
  const fromStart = compareDates(start, earliest) <= 0;
  const points = monthEndPoints(fromStart ? earliest : start, todayDate);
  // A window reaching back to the start begins ON the day tracking began, not its month end, so a
  // value update in the first weeks shows (a fund marked down in its first month read as flat at
  // the new value).
  if (fromStart && compareDates(points[0]!, earliest) !== 0) points.unshift(earliest);
  const dates = points.map((p) => formatDate(p));
  const value = points.map(() => 0);
  const invested = points.map(() => 0);
  const rates = single ? null : loadRateTable(db);
  const rateNeeded = new Set<string>();
  rows.forEach((a, i) => {
    const opened = a.openingDate ? parseStoredDate(a.openingDate) : null;
    // H2 RD11 (S15, L10): for a member who joined after it began, Invested starts at the value on
    // the day they joined (the value then stands for what was put in before), as their header.
    const tracked = trackedSinceOf(a, views[i]!);
    const j = joined.get(a.id);
    const from = j !== undefined && tracked !== null && compareDates(parseDate(j), tracked) > 0 ? parseDate(j) : null;
    const atJoin = from && valuationOf(views[i]!, from.subtract({ days: 1 }));
    const lift = atJoin ? atJoin.currentValue.paise - atJoin.costBasis.paise : 0;
    valueInvestedSeries(views[i]!, points).forEach((p, k) => {
      if (opened && compareDates(opened, p.date) > 0) return;
      let v = p.valuePaise;
      let c = p.investedPaise + (from && compareDates(p.date, from) >= 0 ? lift : 0);
      if (rates) {
        const vb = toBase(Money.fromPaise(v, a.currency), rates);
        const cb = toBase(Money.fromPaise(c, a.currency), rates);
        if (vb === null || cb === null) {
          rateNeeded.add(a.currency);
          return;
        }
        v = vb.paise;
        c = cb.paise;
      }
      value[k]! += part(a.id, v, dates[k]!);
      invested[k]! += part(a.id, c, dates[k]!);
    });
  });
  return {
    timeframe,
    points: dates.map((date, k) => ({ date, valuePaise: value[k]!, investedPaise: invested[k]! })),
    rateNeededCurrencies: [...rateNeeded].sort(),
  };
}

/**
 * Chart N1: each account's balance at the last 12 month ends and today (13 points), at the viewer's
 * share and in its own currency, as the lists beside it show the balance. Month ends before an
 * account began are left out, so a new account's line starts where it does; no line until it spans
 * two month ends (three points), as a few days' line is flat whatever happened.
 */
export async function balanceTrends(database: Db, userId: string, ids: readonly string[]): Promise<Map<string, number[]>> {
  const { db, sqlite } = database;
  const visible = new Set(await accountsVisibleTo(db, userId));
  const rows = fetchAccountRows(db, ids.filter((id) => visible.has(id)));
  const shares = await sharesFor(db, userId, rows.map((a) => a.id));
  const todayDate = today(appClock());
  const points = monthEndPoints(todayDate.subtract({ months: 12 }), todayDate);
  // The balances at the 13 points in one grouped sum, valued through each module.
  const lc = ledgerCuts(sqlite, rows.map((a) => a.id), points.map((p) => formatDate(p)));
  const views = cutViews(rows, points, lc);
  const out = new Map<string, number[]>();
  const joined = joinedDates(db, userId, rows.map((a) => a.id));
  rows.forEach((a, i) => {
    const view = views[i]!;
    // Tracking began on its opening date, else its first row (as `trackedSinceOf`).
    const firstIso = lc.first.get(a.id);
    let since: PlainDate | null = a.openingDate ? parseStoredDate(a.openingDate) : firstIso !== undefined ? parseStoredDate(firstIso) : null;
    if (since === null) return;
    // C5 C: a member's line starts the day they joined.
    const j = joined.get(a.id);
    if (j !== undefined && compareDates(parseDate(j), since) > 0) since = parseDate(j);
    const module = getModule(a.type);
    const line = points
      .filter((p) => compareDates(p, since) >= 0)
      .map((p) => shares.partOn(a.id, module.currentValue(view, p).paise, formatDate(p)));
    if (line.length >= 3) out.set(a.id, line);
  });
  return out;
}
