/**
 * seed.ts — the starter category taxonomy, born with the Circle (F2).
 * ============================================================================
 * A brand-new instance ships with a sensible, EDITABLE category taxonomy so the
 * first transaction has something to land on (F2). This is USER data, not
 * config: once seeded, the user renames / recolours / hides / deletes freely and
 * the seed never runs again.
 *
 * Every group but the system Adjustments one ends with a catch-all "Other" (F2;
 * migration 0011 adds it to existing files).
 *
 * IDEMPOTENT: if ANY `category_groups` row already exists (live or tombstoned),
 * seeding is a no-op — a re-run (double setup submit, a manual re-invoke) never
 * duplicates or "resurrects" the taxonomy over the user's edits. Called from the
 * first-run setup action right after the admin is created.
 * ============================================================================
 */
import { randomUUID } from 'node:crypto';
import * as schema from './db/schema';
import type { Db } from './db/client';
import type { Kind } from './categories';

type AppDb = Db['db'];

/**
 * Fixed id of the seeded "Balance adjustment" category (Neutral kind), stamped
 * on system balancing entries (F1 force-close; audit decision 2026-07-12):
 * categorized → never in the C5 inbox; Neutral → excluded from R2/R3 spending
 * and income. The id is FIXED (not random) so `closeAccount` can reference it
 * rename-proof; if the user deletes the category, balancing entries degrade to
 * uncategorized (Actual Budget's closeAccount similarly categorizes the
 * closing adjustment).
 */
export const BALANCE_ADJUSTMENT_CATEGORY_ID = 'sys-balance-adjustment';

interface SeedCategory {
  readonly name: string;
  readonly colour?: string;
  /** Fixed id for system-referenced categories; random UUID when omitted. */
  readonly id?: string;
  /** "Counts as return (gain or loss)" (C3 A): growth, not money put in. */
  readonly countsAsReturn?: boolean;
}
interface SeedGroup {
  readonly name: string;
  readonly kind: Kind;
  readonly categories: readonly SeedCategory[];
}

/** The approved starter taxonomy (F2). Colours are swatches from $lib/swatches (F2 RD6): the ten
 * spending categories take ten different ones. */
const STARTER: readonly SeedGroup[] = [
  {
    name: 'Income',
    kind: 'income',
    categories: [{ name: 'Salary' }, { name: 'Interest', countsAsReturn: true }, { name: 'Dividends', countsAsReturn: true }, { name: 'Other' }],
  },
  {
    name: 'Essentials',
    kind: 'spending',
    categories: [
      { name: 'Rent', colour: '#0f8fa8' },
      { name: 'Utilities', colour: '#4a3aa7' },
      { name: 'Groceries', colour: '#e87ba4' },
      { name: 'Transport', colour: '#4aa3df' },
      // C11: a loan EMI's interest typed as its own row keeps the loan right and
      // counts as spending; TDS typed beside gross interest reads right (tax paid, not lost).
      { name: 'Loan interest' },
      { name: 'Tax (TDS)' },
      { name: 'Other' },
    ],
  },
  {
    name: 'Lifestyle',
    kind: 'spending',
    categories: [
      { name: 'Eating out', colour: '#eb6834' },
      { name: 'Shopping', colour: '#c2389a' },
      { name: 'Travel', colour: '#2a78d6' },
      { name: 'Other' },
    ],
  },
  {
    name: 'Health & Insurance',
    kind: 'spending',
    categories: [
      { name: 'Medical', colour: '#a0612c' },
      { name: 'Insurance', colour: '#8e4ec6' },
      { name: 'Other' },
    ],
  },
  {
    name: 'Cash',
    kind: 'spending',
    categories: [{ name: 'ATM withdrawal', colour: '#5c6bc0' }, { name: 'Other' }],
  },
  {
    // Investments kind (C2 A): Not in reports; R3's Invested reads it, transfers and plain rows.
    name: 'Investments',
    kind: 'investments',
    categories: [
      { name: 'SIP', colour: '#5c6bc0' },
      { name: 'Stocks', colour: '#2a78d6' },
      { name: 'Gold', colour: '#a0612c' },
      { name: 'Other' },
    ],
  },
  {
    // Neutral: balancing entries are not spending or income (F1 force-close).
    name: 'Adjustments',
    kind: 'neutral',
    categories: [
      { name: 'Balance adjustment', colour: '#5c6bc0', id: BALANCE_ADJUSTMENT_CATEGORY_ID, countsAsReturn: true },
    ],
  },
];

/**
 * Seed the starter taxonomy — IDEMPOTENT (no-op if any category group exists).
 * Groups get sort_order 0..n; categories get sort_order 0..m within their group.
 */
export async function seedStarterCategories(db: AppDb): Promise<void> {
  const existing = db.select({ id: schema.categoryGroups.id }).from(schema.categoryGroups).get();
  if (existing) return;

  db.transaction((tx) => {
    STARTER.forEach((group, groupIndex) => {
      const groupId = randomUUID();
      tx.insert(schema.categoryGroups)
        .values({ id: groupId, name: group.name, kind: group.kind, sortOrder: groupIndex })
        .run();
      group.categories.forEach((category, categoryIndex) => {
        tx.insert(schema.categories)
          .values({
            id: category.id ?? randomUUID(),
            groupId,
            name: category.name,
            sortOrder: categoryIndex,
            colour: category.colour ?? null,
            countsAsReturn: category.countsAsReturn ?? false,
          })
          .run();
      });
    });
  });
}
