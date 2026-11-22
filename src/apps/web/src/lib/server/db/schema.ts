/**
 * schema.ts — the persistence schema. THE SECOND FROZEN INTERFACE.
 * ============================================================================
 * Freeze order: the aggregation contract first (frozen at M2), THEN this
 * schema, then services, then API. This schema is baked **Circle-ready now**
 * (baked at M3, so multi-user at M11 needed no late, invasive migration once
 * accounts/transactions held data). Changing the frozen spine below (the
 * accounts / transactions columns and the owner_id → account_members → entered_by Circle graph) is a
 * DELIBERATE act expressed as a forward-only migration, never a casual edit.
 *
 * Non-negotiable model rules encoded here (docs/product/architecture.md):
 *   - Money = INTEGER paise (`*_paise`). NEVER REAL — floats drift.
 *   - Dates = TEXT 'YYYY-MM-DD' (civil dates) + a SEPARATE INTEGER `sequence`.
 *     Ordering is ALWAYS (date, sequence), never insert id / rowid — this is
 *     the fix for an earlier prototype's `id<=up_to_id` and Actual #3928 same-date bugs.
 *     The composite index (account_id, date, sequence) is the physical enabler
 *     of the running-balance window function (see balances.ts).
 *   - Balance is DERIVED (opening_paise + Σ ordered amounts), never stored.
 *   - A valuation mark is a transaction (`kind = 'valuationMark'`), NOT a table.
 *   - Sync-readiness is cheap insurance only: UUID (TEXT) PKs, per-row
 *     created_at/updated_at, and a soft-delete `deleted_at` tombstone on every
 *     financial row. NO sync/tombstone BEHAVIOUR is built at M3 — schema only.
 *
 * Scope discipline (M3): tables are DEFINED here; only accounts + transactions
 * get query code (balances.ts). users/sessions/account_members exist as tables
 * only — NO auth/visibility behaviour (M4). kind/transfer_partner_id are inert
 * columns — NO transfer/valuation-mark posting behaviour (M6). The `rates`
 * table and any FX columns carry NO rate math (M9).
 *
 * AMENDED at M4 (H1 auth) — ADDITIVE, forward-only (migration 0001). The frozen
 * financial spine (accounts / transactions / the Circle graph) is UNTOUCHED.
 * The auth-only additions are `users.username|role|must_change_password` and
 * `sessions.last_used_at` (idle-expiry marker). Each is ADD COLUMN-compatible
 * (NOT NULL + default, so the ALTER runs inside the transactional migration
 * runner without a table rebuild — a rebuild would need `PRAGMA foreign_keys`,
 * which is a no-op inside a transaction). `username` is stored already-normalized
 * (trimmed + lowercased) by the auth service, so its unique index gives
 * case-insensitive uniqueness for free; its `DEFAULT ''` is an inert migration
 * artifact — the service ALWAYS supplies a real username, '' is never a login.
 *
 * AMENDED at M5 (Foundations F1/F2/F3) — ADDITIVE, forward-only (migration 0002).
 * M3 baked the category/payee/projection tables as SKELETONS (PK + audit only);
 * M5 adds the feature columns their LOCKED ACs need. All are additive (nullable,
 * or NOT NULL + default) so each is a plain ADD COLUMN — no table rebuild (a
 * rebuild would need `PRAGMA foreign_keys`, a no-op inside the transactional
 * runner). The frozen ordering/balance spine is UNTOUCHED. The added columns:
 *   - `accounts.opening_date` (nullable) — as-of date of the opening balance
 *     (F1 "dated opening"). NULL when opened at 0 (F1 RD5). Display/history
 *     metadata ONLY (the "Starting balance" row's date; D3's start for this
 *     account) — NOT part of the (date, sequence) ordering key; balance math
 *     still seeds `opening_paise`.
 *   - `category_groups.hidden`, `categories.hidden`, `payees.hidden` (bool,
 *     default false) — the non-destructive HIDE flag, distinct from the
 *     `deleted_at` tombstone (F2/F3: hide keeps history + is reversible; delete
 *     reassigns then removes).
 *   - `categories.colour` (nullable) — optional per-category colour for the
 *     spending/allocation pies (F2 RD3); auto-assigned when blank.
 *   - `user_payee.last_category_id` (nullable → categories) — the deterministic
 *     "remember last category per payee" default (F3 RD1, fill-when-blank).
 *   - `account_payee.last_used_at`, `user_payee.last_used_at` (nullable) —
 *     recency for "recently-used first" autocomplete ranking (F3 addendum).
 *
 * AMENDED at M6 (Capture C1–C5) — ADDITIVE, forward-only (migration 0003).
 * One column: `transactions.notes` (nullable free text — C1/C2 optional notes,
 * C4 bulk set-notes). Display data only: it never participates in ordering or
 * balance math, so the frozen spine is UNTOUCHED. This is exactly the M6
 * migration forecast in sequencing.md's post-M5-audit amendment. M6 also brings
 * `transfer_partner_id` to life (C3 two-linked-row transfers) — behaviour only,
 * no schema change; `kind = 'valuationMark'` stays inert until M8.
 *
 * AMENDED at M8 (Instrument sections S1/S2/S3/S5) — ADDITIVE, forward-only
 * (migration 0004). `kind = 'valuationMark'` comes to life (S3) and the 9 new
 * holding modules land (S5). Two nullable columns, both plain ADD COLUMN (no
 * table rebuild), the frozen ordering/balance spine UNTOUCHED — exactly the M8
 * forecast in sequencing.md's post-M5-audit amendment:
 *   - `transactions.mark_target_paise` (nullable) — the ASSERTED target value a
 *     valuation-mark row was posted to reach (S3 RD4). The row's `amount_paise`
 *     is still the derived gap that drives the balance; this stores the intent
 *     so the register can read "Valuation update → ₹X" and so the mark can
 *     RE-DERIVE its gap when a prior row changes (S3 RD1 reconcile). NULL on
 *     every ordinary/transfer row; set only on `kind = 'valuationMark'` rows.
 *   - `accounts.info_json` (nullable TEXT) — the S5 per-module INFORMATIONAL
 *     fields (FD rate/maturity, credit limit, Gold sub-type, loan secured-vs-
 *     unsecured, MF folio/ticker note, …) as a small JSON object. DISPLAY-ONLY:
 *     it drives NO computation, valuation or alert in MVP (S5) — the field
 *     schema lives in the app module catalogue, validated lightly in the service.
 *
 * AMENDED at M9 (Multi-currency MC1/MC2/MC3) — ADDITIVE, forward-only
 * (migration 0005). Two nullable columns on `transactions`, both plain ADD
 * COLUMN (no table rebuild), the frozen ordering/balance spine UNTOUCHED —
 * exactly the M9 forecast in sequencing.md's post-M5-audit amendment:
 *   - `transactions.fx_rate_scaled` / `fx_scale` — the FROZEN per-transaction
 *     LINKAGE rate of a cross-currency transfer (MC2), destination-per-1-source,
 *     stored as a scaled integer to avoid float drift. Set on BOTH legs of a
 *     cross-currency transfer only. REFERENCE/DISPLAY ONLY: each leg keeps its
 *     own native `amount_paise` as the balance source of truth, so the linkage
 *     rate drives NO balance math (it is the frozen fact of what rate the user
 *     transacted at, distinct from MC1's standing aggregation rate in `rates`).
 * The MC1 aggregation rates use the pre-existing `rates` table (finalised at M9;
 * one current row per (currency, base), no schema change — see rates.ts).
 *
 * AMENDED at M11 (Circle surfacing + Settings SET1) — ADDITIVE, forward-only
 * (migration 0006). TWO new TABLES, the frozen ordering/balance spine + Circle
 * graph UNTOUCHED — the "SET1 prefs + Circle display name" migration forecast in
 * sequencing.md's post-M5-audit amendment. Chosen typed-over-EAV (the whole
 * schema is typed; the pref set is small + read every page load):
 *   - `user_preferences` — per-user, one row per user, DISPLAY-ONLY (SET1): the
 *     number system (indian|western), long/compact default, foreign-grouping mode
 *     and theme. Touches NO stored amount/rate/derived value — switching a pref is
 *     pure render, no data migration (SET1 "display-only" AC). Absent row ⇒ the
 *     service defaults (locale-derived number system).
 *   - `instance_settings` — a tiny key→value store for the 1–2 instance-wide
 *     singletons (H1 Circle display name; a reserved base-currency slot, MC1 =
 *     INR fixed in MVP). NOT a `circle` entity (H1 RD5: the Circle IS the
 *     instance) — just named settings. KV is apt here: rare, unpredictable-count,
 *     free-text singletons where column typing earns nothing.
 *
 * AMENDED 2026-11-09 (the fund rules; an approved change to the frozen schema)
 * — ADDITIVE, forward-only (migration 0012). One plain ADD COLUMN and a fourth enum value, the
 * ordering/balance spine UNTOUCHED:
 *   - `categories.counts_as_return` (bool, default off): "Counts as return (gain or loss)" (C3 A).
 *     On for the seeded Interest, Dividends and Balance adjustment.
 *   - `category_groups.kind` gains `investments` (C2 A): Not in reports, read by R3's Invested.
 *     The seeded Investments group moves to it.
 *
 * AMENDED 2026-11-10 (an approved change to the frozen schema) — ADDITIVE,
 * forward-only (migration 0014): `accounts.parent_account_id` (nullable), the account this one
 * belongs to (an EPF's EPS, S5 RD16). The ordering/balance spine UNTOUCHED.
 *
 * AMENDED 2026-11-10 (approved) — ADDITIVE, forward-only (migration 0015): the
 * import log, `imports` and `import_items` (F4, Actual Budget's export). Not the spine: two new
 * tables, no existing column changes.
 * ============================================================================
 */
import { sql } from 'drizzle-orm';
import {
  sqliteTable,
  text,
  integer,
  index,
  uniqueIndex,
  primaryKey,
  foreignKey,
  check,
} from 'drizzle-orm/sqlite-core';

/**
 * The sync-readiness audit columns, minted fresh per table (drizzle column
 * builders are stateful, so this MUST be a function, not a shared object).
 * `deleted_at` is the soft-delete tombstone — NULL means live. Timestamps are
 * TEXT ISO-8601 (SQLite CURRENT_TIMESTAMP); they are wall-clock audit data, not
 * the civil `date`/`sequence` ordering key, and carry no behaviour at M3.
 */
const audit = () => ({
  createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text('updated_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  deletedAt: text('deleted_at'),
});

/**
 * Audit columns WITHOUT the soft-delete tombstone — for pure config tables
 * (M11 settings) that are upsert-only and never tombstoned (no sync/audit intent
 * on a display preference, so `deleted_at` would only be dead weight).
 */
const auditNoDelete = () => ({
  createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text('updated_at').notNull().default(sql`CURRENT_TIMESTAMP`),
});

// ── Circle identity (tables only at M3; auth behaviour is M4) ───────────────

/**
 * A member of the Circle. Auth columns (M4, H1):
 *   - `username`   — the login handle, stored already trimmed + lowercased by the
 *                    auth service; the unique index below therefore enforces
 *                    case-insensitive uniqueness. `DEFAULT ''` is an inert ADD
 *                    COLUMN artifact (see header) — never a valid login.
 *   - `role`       — 'admin' | 'member'; exactly one admin in MVP (H1). Membership
 *                    management (last-admin protection) is H3/M11 — column only here.
 *   - `must_change_password` — forces the set-new-password screen before any app
 *                    route (temp-password / admin-reset flow, H1).
 *   - `password_hash` — Argon2id hash (H1); nullable only for the ADD-COLUMN-free
 *                    inherited definition, always populated by the service.
 */
export const users = sqliteTable(
  'users',
  {
    id: text('id').primaryKey(),
    username: text('username').notNull().default(''),
    displayName: text('display_name').notNull(),
    passwordHash: text('password_hash'),
    role: text('role', { enum: ['admin', 'member'] })
      .notNull()
      .default('member'),
    mustChangePassword: integer('must_change_password', { mode: 'boolean' })
      .notNull()
      .default(false),
    /** The day (YYYY-MM-DD) the admin last reset this password, until the member dismisses
     *  the notice that says so (S4, H3 RD; migration 0016). Null: nothing to tell. */
    passwordResetAt: text('password_reset_at'),
    ...audit(),
  },
  (t) => [uniqueIndex('uq_users_username').on(t.username)],
);

/**
 * Server-side session (D8: owned session auth, SQLite sessions). M4 (H1):
 *   - `id` stores the **SHA-256 of the opaque token**, NOT the raw token. The
 *     cookie carries the raw high-entropy token; the server hashes it to look up
 *     the row, so a DB read alone can't impersonate. (Convention in session.ts —
 *     the column shape is unchanged, hence no migration for it.)
 *   - `expires_at` is the ABSOLUTE expiry; `last_used_at` is touched on each use
 *     and drives IDLE expiry. Both are checked fail-closed at the boundary.
 * Sessions are created fresh on login (id never reused → anti-fixation).
 */
export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    expiresAt: text('expires_at').notNull(),
    lastUsedAt: text('last_used_at').notNull().default(sql`CURRENT_TIMESTAMP`),
    ...audit(),
  },
  (t) => [index('idx_sessions_user').on(t.userId)],
);

// ── Accounts + the Circle sharing graph (FROZEN SPINE) ──────────────────────

/**
 * An account. `owner_id` (private-by-default owner) + `account_members` are the
 * Circle graph, baked now so it never has to be retrofitted onto a populated
 * table. `type` is the module registry key ('bank', 'creditCard', … — the
 * aggregation contract reads modules by this, never branches on it). `status`
 * ∈ open|closed. `opening_paise` is the ledger's starting balance; everything
 * else is derived from ordered transactions. `opening_date` (M5, nullable) is
 * the as-of date of that opening balance — display/history metadata, NOT part
 * of the (date, sequence) ordering key; NULL when there is no opening balance.
 */
export const accounts = sqliteTable(
  'accounts',
  {
    id: text('id').primaryKey(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => users.id),
    name: text('name').notNull(),
    type: text('type').notNull(),
    currency: text('currency').notNull(),
    status: text('status', { enum: ['open', 'closed'] })
      .notNull()
      .default('open'),
    openingPaise: integer('opening_paise').notNull().default(0),
    openingDate: text('opening_date'),
    // M8: per-module INFORMATIONAL fields (S5) as a small JSON object. Display-
    // only — never computed on. NULL until the module profile captures any.
    infoJson: text('info_json'),
    // Migration 0014 (2026-11-10): the account this one belongs to. An
    // EPF's EPS points at its EPF; it is never listed on its own and follows its EPF (S5 RD16).
    parentAccountId: text('parent_account_id'),
    ...audit(),
  },
  (t) => [index('idx_accounts_owner').on(t.ownerId), index('idx_accounts_parent').on(t.parentAccountId)],
);

/**
 * Per-account sharing (Epic 8): an added member gets full access, no view-only
 * tier. One row per (account, member). Table only at M3 — the visibility
 * service `accountsVisibleTo` is M4.
 */
export const accountMembers = sqliteTable(
  'account_members',
  {
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    ...audit(),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.userId] })],
);

/**
 * Each holder's share of a shared account, dated (migration 0010; H2 RD8). One row per
 * holder per change, in basis points (10,000 = 100 %), applying from `effective_from` (a civil
 * date) until the account's next change. No rows = equal (1/n), so accounts shared before 0010 need
 * no backfill. A change writes every holder's row for its date and they sum to 10,000 (checked in
 * the service; the CHECK only bounds each row, the schema's first, approved by the owner
 * 2026-10-27). A mistaken change is deleted outright, so no `deleted_at`.
 */
export const accountShares = sqliteTable(
  'account_shares',
  {
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    effectiveFrom: text('effective_from').notNull(),
    shareBp: integer('share_bp').notNull(),
    ...auditNoDelete(),
  },
  (t) => [
    primaryKey({ columns: [t.accountId, t.effectiveFrom, t.userId] }),
    check('chk_account_shares_bp', sql`${t.shareBp} BETWEEN 0 AND 10000`),
  ],
);

/**
 * The dates each member held a shared account (migration 0013; H2 RD9, C5 C).
 * One row per stretch: from `from_date` (the day they were added) up to but not including
 * `to_date` (the day they were removed; NULL while they hold it). A re-share starts a new row, so
 * an earlier stretch is kept. The owner holds the account for its whole life and has no row; a live
 * `account_members` grant from before 0013 with no open row counts as held from the start.
 */
export const accountHolderPeriods = sqliteTable(
  'account_holder_periods',
  {
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    fromDate: text('from_date').notNull(),
    toDate: text('to_date'),
    ...auditNoDelete(),
  },
  (t) => [
    primaryKey({ columns: [t.accountId, t.userId, t.fromDate] }),
    index('idx_holder_periods_user').on(t.userId),
    check('chk_holder_period_dates', sql`${t.toDate} IS NULL OR ${t.toDate} > ${t.fromDate}`),
  ],
);

// ── Categories (kind lives on the group) ────────────────────────────────────

/**
 * A category group. `kind` ∈ income|spending|neutral|investments drives spending-analytics
 * inclusion (R2/R3) — defined now, no behaviour at M3. `investments` (migration 0012) is Not in reports like `neutral`, and is what R3's Invested reads.
 */
export const categoryGroups = sqliteTable('category_groups', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  kind: text('kind', { enum: ['income', 'spending', 'neutral', 'investments'] }).notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
  // M5: non-destructive hide (F2). Distinct from the `deleted_at` tombstone.
  hidden: integer('hidden', { mode: 'boolean' }).notNull().default(false),
  ...audit(),
});

export const categories = sqliteTable(
  'categories',
  {
    id: text('id').primaryKey(),
    groupId: text('group_id')
      .notNull()
      .references(() => categoryGroups.id),
    name: text('name').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    // M5: non-destructive hide (F2); optional colour for the pies (F2 RD3).
    hidden: integer('hidden', { mode: 'boolean' }).notNull().default(false),
    colour: text('colour'),
    // Migration 0012 (C3 A): "Counts as return (gain or loss)". On a holding, a
    // row under a category with it off is money put in or taken out; with it on, growth.
    countsAsReturn: integer('counts_as_return', { mode: 'boolean' }).notNull().default(false),
    ...audit(),
  },
  (t) => [index('idx_categories_group').on(t.groupId)],
);

// ── Payees (canonical registry + projections) ───────────────────────────────

/**
 * The canonical payee registry. `name_normalized` is UNIQUE — the single
 * source of payee identity (F3). Table only at M3.
 */
export const payees = sqliteTable(
  'payees',
  {
    id: text('id').primaryKey(),
    displayName: text('display_name').notNull(),
    nameNormalized: text('name_normalized').notNull(),
    // M5: non-destructive hide (F3) — excluded from autocomplete, history kept.
    hidden: integer('hidden', { mode: 'boolean' }).notNull().default(false),
    ...audit(),
  },
  (t) => [uniqueIndex('uq_payees_name_normalized').on(t.nameNormalized)],
);

/** Shared projection: which payees have been used on which accounts. */
export const accountPayee = sqliteTable(
  'account_payee',
  {
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id),
    payeeId: text('payee_id')
      .notNull()
      .references(() => payees.id),
    // M5: recency for "recently-used first" autocomplete (F3 addendum).
    lastUsedAt: text('last_used_at'),
    ...audit(),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.payeeId] })],
);

/** Per-user payee data: remembered category (F3 RD1) + per-user recency. */
export const userPayee = sqliteTable(
  'user_payee',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    payeeId: text('payee_id')
      .notNull()
      .references(() => payees.id),
    // M5: deterministic "remember last category per payee" (F3 RD1,
    // fill-when-blank). Nullable → cleared when its category is deleted.
    lastCategoryId: text('last_category_id').references(() => categories.id),
    lastUsedAt: text('last_used_at'),
    ...audit(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.payeeId] })],
);

// ── Transactions (FROZEN SPINE — the single source of truth) ────────────────

/**
 * The single source of truth. Every account's balance = opening_paise + Σ of
 * its ordered transactions; nothing else stores a value.
 *
 * Ordering columns: `date` (TEXT 'YYYY-MM-DD') + `sequence` (INTEGER, the
 * within-date monotonic tiebreaker). The (account_id, date, sequence) index
 * below is what the running-balance window function partitions/orders on.
 *
 * Circle authorship: `entered_by` stamps who recorded the row (nullable at M3 —
 * no auth yet). Double-entry: `transfer_partner_id` self-references the linked
 * row (two-row transfers, M6 — inert column here). `kind` = 'valuationMark'
 * marks the manual "now worth ₹X" adjustment row (posting is M6/M8; inert here).
 * `category_id` / `payee_id` are nullable references (populated from M5/M6).
 */
export const transactions = sqliteTable(
  'transactions',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id),
    date: text('date').notNull(),
    sequence: integer('sequence').notNull(),
    amountPaise: integer('amount_paise').notNull(),
    categoryId: text('category_id').references(() => categories.id),
    payeeId: text('payee_id').references(() => payees.id),
    transferPartnerId: text('transfer_partner_id'),
    enteredBy: text('entered_by').references(() => users.id),
    kind: text('kind', { enum: ['ordinary', 'valuationMark'] })
      .notNull()
      .default('ordinary'),
    // M6: optional free-text notes (C1/C2 entry, C4 bulk set-notes). Display
    // data only — never part of ordering or balance math.
    notes: text('notes'),
    // M8: the asserted target value of a valuation-mark row (S3 RD4). NULL on
    // ordinary/transfer rows; on a `kind='valuationMark'` row it records the
    // "now worth ₹X" intent while `amount_paise` stays the derived gap that
    // drives the balance — so the mark re-derives its gap under S3 RD1 reconcile.
    markTargetPaise: integer('mark_target_paise'),
    // M9: the FROZEN linkage rate of a CROSS-CURRENCY transfer (MC2), as a scaled
    // integer `fx_rate_scaled / 10^fx_scale` destination-per-1-source. Set on BOTH
    // legs of a cross-currency transfer; NULL on every same-currency/ordinary/mark
    // row. Reference/display only — each leg's own native `amount_paise` remains
    // the balance source of truth, so this NEVER participates in balance math.
    fxRateScaled: integer('fx_rate_scaled'),
    fxScale: integer('fx_scale'),
    ...audit(),
  },
  (t) => [
    // The physical enabler of the (date, sequence) running-balance window fn.
    index('idx_tx_account_date_seq').on(t.accountId, t.date, t.sequence),
    // Self-referential FK for the double-entry transfer link (M6 behaviour).
    foreignKey({
      columns: [t.transferPartnerId],
      foreignColumns: [t.id],
      name: 'fk_tx_transfer_partner',
    }),
  ],
);

// ── FX rates (PROVISIONAL — finalised at M9; NO rate math at M3) ─────────────

/**
 * PROVISIONAL. The aggregation rate per currency (the linkage rate is frozen on
 * the transfer row, not here — contracts.md §B). FX is M9; this table carries
 * NO behaviour at M3 and its exact numeric representation is an M9 decision —
 * it is defined here only so the table exists. To avoid float drift a rate is
 * stored as a scaled integer: rate = `rate_scaled` / 10^`scale`.
 */
export const rates = sqliteTable(
  'rates',
  {
    id: text('id').primaryKey(),
    currency: text('currency').notNull(),
    baseCurrency: text('base_currency').notNull(),
    rateScaled: integer('rate_scaled').notNull(),
    scale: integer('scale').notNull(),
    asOf: text('as_of').notNull(),
    ...audit(),
  },
  (t) => [uniqueIndex('uq_rates_currency_asof').on(t.currency, t.baseCurrency, t.asOf)],
);

// ── Settings (M11 · SET1 + H1 Circle name) — DISPLAY-ONLY, no financial spine ─

/**
 * Per-user DISPLAY preferences (SET1). One row per user; absent ⇒ service
 * defaults. `number_system` ∈ indian|western (the lakh/crore vs K/M/B grouping);
 * `compact` is the user's long/compact default for glanceable surfaces ONLY (the
 * ledger-exactness guard keeps registers/balances long-form regardless);
 * `foreign_grouping` ∈ preference|native-locale (group a foreign amount by the
 * user's own system, or by each currency's native locale); `theme` ∈
 * system|light|dark. NONE of these touch a stored amount, rate or derived value.
 */
export const userPreferences = sqliteTable('user_preferences', {
  userId: text('user_id')
    .primaryKey()
    .references(() => users.id),
  numberSystem: text('number_system', { enum: ['indian', 'western'] })
    .notNull()
    .default('indian'),
  compact: integer('compact', { mode: 'boolean' }).notNull().default(false),
  foreignGrouping: text('foreign_grouping', { enum: ['preference', 'native-locale'] })
    .notNull()
    .default('preference'),
  theme: text('theme', { enum: ['system', 'light', 'dark', 'black'] })
    .notNull()
    .default('system'),
  // SET1 accent colour (migration 0009): display-only, like the theme. Plain text
  // in SQL; the retired trial values (teal, indigo, plum) are mapped on read (`normalizeAccent`).
  accent: text('accent', { enum: ['ink', 'gold', 'windows', 'blue', 'purple', 'teal', 'indigo', 'plum', 'coral', 'lime'] })
    .notNull()
    .default('ink'),
  ...auditNoDelete(),
});

/**
 * Instance-wide singletons (H1 Circle display name; reserved base-currency slot).
 * A named key→value store, NOT a `circle` entity (the Circle is the instance).
 */
export const instanceSettings = sqliteTable('instance_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  ...auditNoDelete(),
});

// ── The import log (migration 0015; F4) ───────────────────────

/**
 * One import of another app's export (Actual Budget's zip, F4): who ran it, the file, Actual's
 * budget id and the counts it added. `undone_at` is set once Undo import removed what it added.
 */
export const imports = sqliteTable(
  'imports',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    source: text('source').notNull(),
    fileName: text('file_name').notNull(),
    budgetId: text('budget_id'),
    budgetName: text('budget_name'),
    accounts: integer('accounts').notNull().default(0),
    transactions: integer('transactions').notNull().default(0),
    categories: integer('categories').notNull().default(0),
    payees: integer('payees').notNull().default(0),
    undoneAt: text('undone_at'),
    ...auditNoDelete(),
  },
  (t) => [index('idx_imports_user').on(t.userId)],
);

/**
 * What an import made or added, with the source's own id: a re-import skips an `actual_id` already
 * here; Undo removes what its import added. `created` is false for a group, category or payee the
 * import found already here and reused (Undo leaves those).
 */
export const importItems = sqliteTable(
  'import_items',
  {
    importId: text('import_id')
      .notNull()
      .references(() => imports.id),
    kind: text('kind', { enum: ['account', 'transaction', 'group', 'category', 'payee'] }).notNull(),
    ourId: text('our_id').notNull(),
    actualId: text('actual_id').notNull(),
    created: integer('created', { mode: 'boolean' }).notNull().default(true),
  },
  (t) => [
    primaryKey({ columns: [t.importId, t.kind, t.ourId] }),
    index('idx_import_items_actual').on(t.kind, t.actualId),
  ],
);
