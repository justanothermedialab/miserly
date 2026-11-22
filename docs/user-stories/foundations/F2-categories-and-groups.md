# F2 — Categories & groups

> **Epic:** Foundations · **Story:** F2 · **Status:** LOCKED (2026-06-20)
> **MVP scope:** CRUD only, zero intelligence. See the locked plan for context.

---

## Title
As the user, I can define my own **category groups** and **categories**, where each group is
tagged with a **kind** (Income / Spending / Neutral), so that I can classify transactions my way
and the (later) charts know which spending is "spending", which money is "income", and which
movements (e.g. investments) to leave out entirely.

## ELI5
A category is the label I put on a transaction ("Groceries", "Salary", "SIP"). Groups are folders
that hold related categories ("Food" holds Groceries + Restaurants). Each folder also carries a
one-word meaning — is this money coming IN (Income), money being SPENT (Spending), or money just
MOVING that shouldn't count as spending (Neutral, e.g. Investments)? This story is "let me
build and organize my own labels, and tell the app what each folder *means*."

## Business context
Categories are the second Foundations brick (after accounts). They are what turn a raw ledger into
**"where did my money go"** — the user's #1 reason for tracking (per-paisa flow). Three locked
decisions shape this story:

1. **Two-level hierarchy: Group → Category.** This is the universal standard (Actual, YNAB; YNAB's
   "Master Category" is just an old name for Group). Nobody ships a real third level — it's always
   a naming hack, so we won't ([Actual](https://actualbudget.org/docs/budgeting/categories/),
   [YNAB](https://support.ynab.com/en_us/adding-removing-and-customizing-categories-a-guide-HJFO5j909)).

2. **Each group carries a system `kind` ∈ {Income, Spending, Neutral}; categories inherit it.**
   This generalizes Actual's special-cased single income group into a clean, user-controlled tag.
   **Neutral** is our wealth-tracking addition — a group like "Investments" whose outflows are
   *not* spending (money you still own, just moved to an untracked holding). Charts read kind:
   Income → cashflow income; Spending → spending pie; Neutral → excluded from both.

3. **Direction is decoupled from category (carried from Capture decisions) — and the combination
   solves refunds.** A transaction has its own inflow/outflow direction *and* an optional category.
   Kind classifies *for reporting*; direction is *what actually happened*. Charts aggregate
   **signed** amounts within a kind, so:
   - Salary = `inflow + Salary(Income)` → counts as income.
   - Grocery purchase = `outflow + Groceries(Spending)` → counts as spend.
   - **Grocery refund = `inflow + Groceries(Spending)`** → *nets against* grocery spend, not income.
   This is the clean fix for the "refund handling" pitfall flagged in the plan.

**Budgeting stays out.** Firefly's separation is instructive: budgets (spending limits) are a
separate forward-looking concept from categories (organisation); budgets never apply to income or
transfers ([Firefly](https://deepwiki.com/firefly-iii/firefly-iii/2.3-budgets-categories-and-tags)).
We ship **only categories** — no limits, no envelopes.

## User workflow

### Happy path — create / organize
1. User opens **Categories** (a settings/management surface).
2. Creates a **group**, names it (e.g. "Food"), picks its **kind** (Spending).
3. Adds **categories** inside it ("Groceries", "Restaurants").
4. Repeats for an Income group ("Income" → Salary, Interest, Dividends) and any Neutral group
   ("Investments" → SIP, Stocks-buy-untracked).
5. Categories are now available in the transaction entry picker (F-Capture).

### Alt path — reorganize
- Rename a group or category (propagates everywhere it's used — categories are referenced by id).
- Move a category to a different group (its effective **kind follows the new group**).
- Change a group's kind (e.g. flip a group from Spending to Neutral) — recomputes how its
  transactions roll up in charts.

### Alt path — retire without losing history
- **Hide** a group or category: it vanishes from the picker and management list but every past
  transaction keeps its label and history. This is the safe default (Actual's model).

### Recovery path — delete a category that's in use
- Deleting a category that has transactions **forces a reassignment**: the user must pick another
  category (or "Uncategorized") to move those transactions to; then the category is removed. This
  is Actual's delete-is-merge behaviour ([Actual](https://actualbudget.org/docs/budgeting/categories/)).

## Acceptance criteria
- [ ] User can create, rename, and delete **groups**; each group has a required **kind** ∈
      {Income, Spending, Neutral}.
- [ ] User can create, rename, delete, and **move** **categories** between groups.
- [ ] A category's effective kind is **inherited from its group** (no separate per-category kind).
- [ ] Categories and groups can be **hidden** (non-destructive) and unhidden; hidden ones keep all
      transaction history and are excluded from the entry picker.
- [ ] Deleting a category **with transactions** requires reassigning those transactions to another
      category or to Uncategorized before deletion completes.
- [ ] Renaming a group/category updates its display everywhere immediately (referenced by id).
- [ ] Transactions may be **uncategorized** (category is optional — feeds the C5 inbox); an
      uncategorized transaction is valid and persists.
- [ ] **Transfers are never categorized** — they have no category field path (carried from Capture).
      *(Amended 2026-10-16: a bank or card ↔ holding transfer takes a category on its
      bank-side leg; every other transfer stays categoryless. See C3 RD5, R2 RD9, R3 RD7.)*
- [ ] Charts consume kind correctly (spec, verified later): Income→cashflow income, Spending→
      spending pie (signed, so refunds net), Neutral→excluded from spending and income.

## Validation rules
- **Group name / category name:** required, non-empty after trim. Names should be unique within
  their scope (group names unique among active groups; category names unique within a group — same
  name allowed in different groups, e.g. "Other" under several groups). Names of *hidden* items
  don't block reuse.
- **Kind:** required on every group; must be one of the three enum values; categories may not
  override it.
- **Delete guard:** a category with ≥1 transaction cannot be hard-deleted without reassignment; a
  group cannot be deleted while it still contains (non-hidden) categories — empty or reassign first.

## Edge cases
- **Move a category across kinds** (Spending group → Neutral group): all its historical
  transactions' roll-up changes. This is intended (kind is a property of current classification),
  but the user should understand past charts will shift. Surface a gentle note.
- **Change a group's kind** with many transactions underneath: same as above at group scale.
- **"Uncategorized" is not a real category** — it's the absence of one. It must be a valid
  reassignment *target* on delete, and a first-class filter, but it isn't created/edited/hidden.
- **Neutral outflow vs transfer ambiguity:** contributing to a **tracked** holding = a *transfer*
  (no category); buying an **untracked** investment = a *Neutral-kind outflow* (category). F2 must
  make both representable; the entry UX (Capture) guides which is which.
- **Refund larger than spend in a period** → a Spending category can net **negative** in the
  spending pie for that window; charts must handle negative slices sanely (later, but data allows).
- **An "ATM Withdrawal" category** (from the cash decision) is a normal Spending category marking
  cash leaving the bank; nothing special structurally.

## Failure cases
- **Deleting a category mid-reassignment fails partway:** must be atomic — either all its
  transactions are reassigned and it's gone, or nothing changes.
- **Deleting/hiding a group orphaning its categories:** prevented by the delete guard; hiding a
  group should offer to hide its categories too (or hide them implicitly) so none are left
  visible-but-parentless.
- **Renaming to collide with an existing active sibling:** rejected with a clear message.
- **No Income category exists when the user logs income:** not a failure — direction is explicit
  (inflow), category is optional, so the inflow simply lands Uncategorized in the inbox. We do
  **not** hard-require an income category (unlike Actual's undeletable income group).

## UX considerations
- **Management surface mirrors the benchmark:** collapsible groups, categories nested under them,
  inline add (+ on a group), per-item menu (rename / hide / delete), a "show hidden" toggle
  (Actual's exact pattern — familiar to a switcher).
- **Kind is set at the group level and visually obvious** (a small label/colour per kind) so the
  user sees at a glance which folders are Income vs Spending vs Neutral.
- **Hide is presented before Delete** and described as the safe choice ("keeps history"); Delete
  carries the reassignment prompt.
- **Picker ergonomics matter** because this feeds the make-or-break entry loop: fast type-ahead,
  recently-used first, grouped display. (Detailed entry behaviour lives in Capture; F2 just makes
  the data clean and fast to query.)
- **Starter set on first run** (mechanism here; exact list = Onboarding epic): seed ~10–15
  categories across one Income, a few Spending groups, and an Investments(Neutral) group —
  research says 10–15 is the sweet spot, India-flavoured for our user
  ([Lunch Money](https://lunchmoney.app/blog/how-to-choose-the-right-budget-categories)).

## Operational considerations
- **Kind is the single source of chart classification** — there must be exactly one place that
  maps a transaction → kind (via category → group → kind), so net worth/spending/income never
  disagree (the same anti-drift discipline as F1's balances).
- **Referential integrity:** transactions reference category by id; rename is metadata-only; delete
  requires reassignment; hide is a flag. No transaction ever points at a missing category.
- **Migration/seed:** the first-run seed is data, not code — should be editable/removable by the
  user (it's *their* taxonomy).
- **Greenfield**: all category management works offline in desktop mode (hosted = client↔server, §11).

## Resolved decisions (locked 2026-06-20)
*(carried from plan + F1 conventions; reconfirm any you want to revisit)*
- **Two levels only** (Group → Category); no third level.
- **Kind on the group; categories inherit**; kind is required; no per-category override.
- **Hide = non-destructive default; Delete = reassign-then-remove** (Actual model).
- **Transfers are categoryless**, except a bank or card ↔ holding transfer's bank-side leg (C3 RD5,
  2026-10-16).
- **Category optional at entry** → uncategorized is valid (feeds C5 inbox); no mandatory income
  category.

## Resolved decisions — round 2 (locked 2026-06-20)
1. **Group kind is editable after creation** (LOCKED): flip Income↔Spending↔Neutral freely; charts
   recompute. Surface a gentle note when a group with existing transactions changes kind.
2. **Seed a starter set** (LOCKED): first-run seeds ~10–15 editable categories across one Income, a
   few Spending groups, and an Investments(Neutral) group. The exact India-flavoured *list* is an
   Onboarding-epic decision; the *decision to seed* is locked. Seed is user-editable data.
3. **Optional colour field per category now** (LOCKED): cheap, and the spending/allocation pie
   charts read better with stable per-category colours. Colour is optional (auto-assigned if blank).
4. **Delete reassignment = prompt, with "Uncategorized" offered** as one target (default behaviour,
   not separately contested).
5. **Single `hidden` flag**, no parallel "archived" state for categories (kept simple, distinct from
   F1's account open/closed which is heavier because balances are involved).
   *Amended 2026-11-06 (after a review of the app):* hidden means the category **or its group**,
   everywhere: out of every picker, refused on every save (a new row, an edit, bulk, a transfer, a
   payee's default category), never suggested in To categorize and never remembered by a payee. A
   row already in it keeps it and still takes other edits. *Why:* a hidden group's categories could
   still be picked, because each check read only the category's own flag.

**Amendments (2026-10-10, after a review of the app's screens):**

6. **Colours from a swatch set, fixed per category** (amends RD3): the picker is
   10 swatches from the categorical palette, none red, green or gold (they mean money out, money in
   and the accent); a new category takes the next unused swatch; the native hex picker goes. A data
   migration moves seeded colours still at their seed value (Rent `#E5484D`, Groceries `#46A758`,
   Gold `#B08C3D`) to swatches; a colour the user picked is never changed.

**Colour re-look (2026-11-05, after a web search on what other apps do):**

7. **No colour to pick** (amends RD3 and RD6). Reports' Spending is the only chart that colours
   categories, and it now colours them by rank in the chart (R2 RD8 amended), so a stored colour
   showed nowhere but the Categories page's dot. The dot and the picker go from the Categories page,
   New category and Edit category; a category still stores a swatch (the column stays, nothing
   reads it), and an edit without a colour field keeps it. *Why:* 10 swatches over 19 categories
   made the biggest categories repeat a colour; Simplifi and YNAB colour by rank and offer no
   per-category chart colour.

8. **A catch-all "Other" in every group** (2026-11-05).
   The starter set ends each group with "Other"
   (Income, Essentials, Lifestyle, Health & Insurance, Cash, Investments); the system Adjustments
   group keeps only Balance adjustment. Migration 0011 adds it once to every live group of an
   existing file that has none, at the end; nothing else changes. A group made later starts empty.
   The picker shows group headings, so the "Other"s are told apart there; a register cell shows the
   name only.
9. **Balance adjustment and its group are locked** (2026-11-06,
   after a review of the app). The system category can't be deleted or moved out
   of its group, and its group can't be deleted or change kind (it stays Not in reports); both can
   be renamed and hidden. Found by the category's fixed id, so a renamed group stays locked.
   *Why:* deleting the category, or hiding it and then deleting its group (the reviewer's hole),
   turned the next close into ₹25,000 of spending waiting in To categorize on an account that
   refuses edits.
10. **A fourth kind, Investments, and a "Counts as return" switch** (2026-11-09, after a
    review of the app; decided as a change to the frozen schema;
    migration 0012). A group's kind is Income, Spending, Investments or Not in reports; Investments
    is out of income and spending like Not in reports, and is what Reports' Net invested reads
    (R3). The seeded Investments group moves to it; the person's own Not-in-reports groups ("Lent
    to Ravi") stay out of Invested. Each category gets a switch, "Counts as return (gain or loss)":
    on a holding, money in under a category with it off is money put in (EPF's Salary), money out
    under one with it on (a dividend sent to the bank) is a payout that leaves Invested alone. On
    for the seeded Interest, Dividends and Balance adjustment, off for the rest; the person can
    change it (a Fees category, say). Uncategorised rows on a holding stay return, so no existing
    figure flips. *Why:* EPF typed the owner's way read ₹7,200 of return and ₹0 invested,
    and any Not-in-reports row would have counted as invested.
11. **Two more starter categories, new files only** (2026-11-09, after a review of the app):
    "Loan interest" and "Tax (TDS)" in Essentials (Spending), before its Other. An EMI's interest
    typed as its own row keeps the loan right and counts as spending (S3 RD9); TDS typed
    beside gross interest makes income read the gross and the tax read as spent. An existing file
    is left as it is (add them in Categories if wanted).
12. **A delete or a kind change stops at rows the member can't see** (2026-11-12,
    after a security read). Categories stay one shared list, but deleting one moved its rows in every
    account, other members' private ones too, and a group's kind changes what everyone's reports
    count. So a delete of a category or a group, and a change of a group's kind, is refused when a
    live row under it sits in an account the member doesn't hold, or on a date they didn't hold it:
    "Other members have rows in this category, so it can't be deleted. You can hide it." (for a
    kind: "…so its kind can't be changed."). The refusal tells the member such rows exist, nothing
    more; the guide says so. Rename, hide, move and colour stay open to every member, and the admin
    gets no extra power. Amends the Circle addendum's "a rename/delete affects everyone's reports".

## Circle addendum (Epic 8 · multi-user)

> Added 2026-06-25 by the [Circle epic](../circle/README.md) writeback (D6). Categories are a **shared
> vocabulary**, not per-user data.

- **One Circle-shared taxonomy.** Groups + categories + their kinds are shared across the whole Circle
  (consistency, especially for shared accounts). There is no per-user category set.
- **Collaboratively editable** ([H3](../circle/H3-roles-and-membership.md)): any member may add/edit the
  taxonomy; a rename/delete affects everyone's reports (accepted in MVP; an admin-curated/locked mode is
  a deferred tightening). The reassignment-on-delete rule above still prevents orphaned transactions.
  Since RD12 a delete or a kind change is refused when rows the member can't see are under it.
- **Per-user memory stays personal.** The deterministic *remember-last-category* helper is **per-user**
  (stored in `user_payee`, see [F3](F3-payees.md) addendum) — your fill-when-blank default never leaks
  your habits to other members, even though the categories themselves are shared.
- **AC delta:** the category taxonomy is instance-wide (Circle-shared); last-category-per-payee memory
  is keyed by `(user, payee)`.

## Dependencies
- **Depends on:** nothing structural beyond the app shell (categories are standalone). Independent
  of F1 — can be built in parallel.
- **Blocks:** **Capture (C1, C2, C5)** — the entry loop needs categories and the uncategorized
  inbox; and **all spending/income/allocation charts** downstream.
- **Related:** F3 (Payees) — the "remember last category per payee" default writes a category id,
  so payees reference categories defined here.
- **Excludes:** budgets/limits/envelopes (permanently out); rules engine for auto-categorization
  (v2 / intelligence layer); tags (not in MVP — categories only).

---

### Research sources
- Actual Budget — Categories (groups, hide vs delete, delete-requires-reassignment = merge): https://actualbudget.org/docs/budgeting/categories/
- YNAB — Adding/removing/customizing categories; Category Group = old "Master Category"; two-level hierarchy, third level is a naming hack: https://support.ynab.com/en_us/adding-removing-and-customizing-categories-a-guide-HJFO5j909
- Firefly III — Budgets vs Categories vs Tags; categories organise, budgets set limits, neither applies to transfers; income not budgeted: https://deepwiki.com/firefly-iii/firefly-iii/2.3-budgets-categories-and-tags ; https://docs.firefly-iii.org/explanation/financial-concepts/budgets/
- Lunch Money / general best practice — starter category sets, 10–15 categories is the sweet spot, seed income/transfer/expense defaults: https://lunchmoney.app/blog/how-to-choose-the-right-budget-categories
