# F3 — Payees

> **Epic:** Foundations · **Story:** F3 · **Status:** LOCKED (2026-06-20)
> **MVP scope:** CRUD only, zero intelligence. See the locked plan for context.

---

## Title
As the user, I can record **who** a transaction was with as a reusable **payee** entity —
auto-completed as I type, renameable everywhere at once, mergeable when duplicates creep in, and
smart enough to **pre-fill the category I last used** for that payee — so logging is fast and my
"who I pay" list stays clean without a rules engine.

## ELI5
A payee is the other side of a transaction — "Amazon", "Reliance Fresh", "my landlord", "HDFC"
(for that ₹1.71 charge). Instead of retyping "Amazon" every time, I pick it from a list that
remembers it. When I rename it, every old transaction updates too. And because I almost always
file Amazon under "Shopping", the app pre-fills that category for me — but I can always change it.
This story is "make payees real, reusable, tidy, and a little bit helpful."

## Business context
Payees are the third Foundations brick and a direct lever on the **make-or-break entry speed**.
For our manual-only user logging every tiny charge, retyping payees is pure friction; a fast
autocomplete + a sensible category pre-fill is what makes per-paisa logging sustainable.

Three locked decisions shape this story:

1. **Payees are first-class entities** (saved, autocompleted, fetchable, **rename-propagates**) —
   the universal model (Actual, YNAB). Renaming is metadata-only because transactions reference a
   payee by id.

2. **Deterministic "remember last category per payee" — a stored field, not ML.** This mirrors
   YNAB exactly: once a payee has a category, future transactions for it pre-fill that category
   ([YNAB](https://support.ynab.com/en_us/categorizing-transactions-a-guide-HyRl60sks)). The
   **self-writing rules engine** (Actual's behaviour-learning) is explicitly **v2 / intelligence
   layer**, not this story. *(User feedback: this auto-set "can get annoyingly set sometimes" — so
   the pre-fill must be trivially overridable and never block; see Resolved decisions on update policy.)*

3. **Inline transfers reuse the payee field, but accounts are NOT payee rows.** Actual implements
   transfers as shadow "transfer payees" (one per account)
   ([Actual transfers](https://actualbudget.org/docs/transactions/transfers/)). We take the *UX*
   (type an account name in the payee box → make a transfer) but keep the *data* clean: payee
   entities are **external parties only**; the entry picker simply *also* surfaces accounts as
   "Transfer → <account>" choices. No shadow payee rows. (Transfer mechanics live in C3.)

## User workflow

### Happy path — use while logging
1. In the transaction entry row, user types in the **Payee** field.
2. Autocomplete shows matching existing payees (and, separately, "Transfer → <account>" options).
3. User picks an existing payee → if that payee has a remembered category, the **Category field
   pre-fills** with it (still editable).
4. If no match, user types a new name and confirms → a **new payee entity is created** on the fly.

### Happy path — manage
- A **Payees** management surface lists all payees: rename (inline), **merge** selected payees
  into one (consolidate typos/variants — retains the target's name), delete. (Hide removed, RD3.)

### Alt path — rename propagates
- Renaming "Amazon IN" → "Amazon" updates the display on every historical transaction instantly
  (id reference; no data migration).

### Alt path — merge duplicates
- User selects "Amazn", "Amazon.in", "AMAZON" → **Merge into "Amazon"** → all their transactions
  now point at the single payee; the others are removed (Actual's merge model).

### Recovery path — wrong category keeps pre-filling
- User changes the category on a transaction; per the chosen update policy (Resolved decision 1) the payee's
  remembered category updates (or not). User can also clear/edit the remembered category directly
  in the Payees manager.

## Acceptance criteria
- [ ] User can create a payee on the fly from the entry field, and via the Payees manager.
- [ ] Payee autocomplete matches as the user types (prefix/substring — see Validation).
- [ ] Selecting a payee with a remembered category **pre-fills** that category, **editable**, never
      blocking save.
- [ ] Renaming a payee updates its display across all transactions immediately.
- [ ] User can **merge** two or more payees into one; all transactions re-point to the target;
      merged-away payees are removed.
- [ ] ~~User can **hide** a payee (excluded from autocomplete; history preserved) and unhide it.~~ Removed 2026-11-04 (RD3).
- [ ] Payee is **optional** on a transaction (a bare bank charge may have only a description).
- [ ] The entry picker surfaces **"Transfer → <account>"** options distinctly from payees;
      choosing one routes to transfer creation (handled in C3), and does **not** create a payee.
- [ ] A payee's remembered category respects F2: it stores a **category id**; if that category is
      later deleted/reassigned, the payee's remembered category follows or clears (no dangling id).

## Validation rules
- **Name:** required, non-empty after trim; unique among **active** payees (case-insensitive,
  whitespace-trimmed, to prevent near-dupes at creation — autocomplete is the first line of defence
  against the "Morrisons" sprawl Actual's merge tool exists to clean up).
- **Remembered category:** optional; must reference an existing (non-deleted) category; cleared if
  that category is removed without reassignment.
- **Merge target:** must be an existing payee; a payee cannot be merged into itself.
- ~~**Hidden payees** don't block name reuse and don't appear in autocomplete.~~ (No Hide, RD3.)

## Edge cases
- **Same display name as an account** (e.g. a payee literally named like an account): picker must
  still clearly separate the payee match from the "Transfer → <account>" option so the user doesn't
  accidentally create a transfer (or vice-versa).
- **Merging payees with different remembered categories:** the target keeps its own remembered
  category (or prompt) — define in Resolved decisions.
- **Renaming a payee to collide with another active payee:** offer to **merge** instead of erroring
  (this is the natural, helpful resolution — Actual effectively does this).
- **Payee used only by transfers conceptually:** shouldn't exist — transfers don't create payees;
  if legacy/import ever produces one, it's just a normal payee.
- **First-ever use of a payee:** no remembered category yet → category pre-fill is simply empty.
- **Deleting a payee that has transactions:** transactions keep working with payee = none (payee is
  optional) — or require reassignment? See Resolved decisions.

## Failure cases
- **Merge partially applied:** must be atomic — either all transactions re-point and the losers are
  gone, or nothing changes (same discipline as F2 category delete).
- **Pre-fill overwrites a category the user already typed:** the pre-fill must only populate an
  **empty** category field on payee selection — never clobber a value the user already chose in this
  entry. (Critical to avoid the "annoyingly set" frustration.)
- **Dangling remembered-category id** after a category delete: must be prevented (cascade
  clear/reassign) so a payee never pre-fills a non-existent category.
- **Autocomplete returns stale payees:** (no Hide, RD3; a stale payee sinks by recency); a just-renamed
  payee must reflect immediately.

## UX considerations
- **Autocomplete is the heart of payee UX** — fast, keyboard-navigable, top hit selectable with
  Enter; "create new "X"" always offered as the last option so a new payee is one keystroke away.
- **Transfer options visually distinct** in the same dropdown ("↔ Transfer → Savings") so the
  unified field stays fast without confusing a payee with an account.
- **Category pre-fill is gentle:** it fills an empty category field and shows it's a suggestion;
  it never overwrites user input and is always one edit away. Given the user's noted annoyance, err
  toward *unobtrusive*.
- **Payees manager mirrors the categories manager** (consistent management UX): list, rename
  inline, multi-select → merge / delete (no Hide or show-hidden toggle, RD3).
- **No rules UI in MVP** — the only "automation" is the single remembered-category pre-fill. The
  rules engine is deliberately absent (v2).

## Operational considerations
- **One place computes the pre-fill** (payee → remembered category id), kept consistent with F2's
  category model; referential integrity enforced on category delete.
- **Merge and rename are id-level operations** — O(1) metadata for rename; merge re-points
  transaction foreign keys in one transaction (atomic).
- **Payee is optional** on transactions → schema and queries must handle null payee throughout
  (autocomplete, reports, register display).
- **Greenfield**: payee CRUD, autocomplete, merge all work offline in desktop mode (hosted = client↔server).

## Resolved decisions (locked 2026-06-20)
1. **Remembered-category update policy = (b) fill-when-blank** (LOCKED): the payee's remembered
   category is set the **first** time a transaction gives that payee a category, and is **never
   auto-changed** afterwards. The user can edit/clear it manually in the Payees manager. This is the
   direct antidote to the "annoyingly set" friction. Per-transaction pre-fill is always overridable
   and only ever fills an **empty** category field.
2. **Merge tool is IN for MVP** (LOCKED): simple multi-select → merge into a target; cheap,
   high-value for cleaning up typos; matches Actual.
3. **Deleting a payee with transactions → set those transactions' payee to none** (LOCKED), since
   payee is optional. ~~**Hide** remains the encouraged default over delete.~~ **Amended
   2026-11-04: there is no Hide.** Actual has none (its Payees page: Rename, Delete,
   Merge, Favorite, Rules), no competitor was cited for it, and as built it was one shared flag,
   so one member hiding a payee hid it from every member. A payee no longer used sinks in the
   recency-ranked suggestions; Merge and Delete clean up the rest. The stored `payees.hidden` flag
   is ignored (frozen schema, no migration), so anything hidden before shows again. What Hide was
   meant to give, another member's payees not showing until used, is the Circle rule below:
   payees on a member's private accounts never reach another member; a joint account's payees show
   to both holders, who see all its transactions.
4. **Unified picker now** (LOCKED): the entry picker surfaces real payees + "Transfer → <account>"
   options; the inline-transfer path is exposed from F3 (mechanics in C3).
5. **Merging payees with differing remembered categories → keep the target's silently** (default);
   user can edit after.
6. **Payee is always optional** on a transaction (LOCKED): a bare bank charge may carry only a
   description.

**Amendment (2026-10-21; a check of the acceptance criteria found the manager's create half
never built):**

7. **The Payees page can create a payee** ("else it's a CRUD fallacy"). A New payee row on the
   page: the name (required; a name the viewer already has is refused with a pointer to it, as
   rename does), an optional remembered category, Enter saves, Esc cancels. It lands in the list
   with 0 transactions, scoped to the viewer like rename and merge. **Built 2026-10-27**
   (small-fixes batch): a New payee button at the right of the toolbar opens the row at the top of
   the table (name, default category, Save / Cancel). **Visibility rule added:** a payee is seen by
   a viewer when it is used on an account they can see, *or* it is their own payee (their
   `user_payee` row) that **no account uses at all**; with no account behind it nothing can leak
   (P0), and its first use makes it an ordinary payee. A name only another member uses privately
   answers the same as a new one, changes nothing of theirs (no un-hide), and shows to the viewer
   once they use it.
8. **A remembered category that's hidden since fills nothing** (2026-11-06, after a review of the
   app; F2 RD5's amendment). When a payee's remembered category, or its group, is hidden, picking the
   payee leaves Category blank (as after a delete); unhiding it brings the memory back. *Why:* it
   filled the field with an id the picker couldn't show, so the field looked blank and Save
   failed with "Choose an existing category".
9. **A transfer remembers its category per destination account, as a payee does**
   (2026-11-11, after a read of the money logic; looked up, not stored, 2026-11-14). Picked the first
   time, filled in after that when the category field is empty, editable, never guessed: an
   account no categorised transfer went into fills nothing. The memory is per user and is read
   from stored rows (no table, no migration): the latest transfer this user entered (newest save
   of either half) whose money lands in that account, both accounts visible to them, whose pair has
   a category. Deleting it, or clearing its category, falls back to the one before; a hidden
   category fills nothing (RD8). Filled in the register's entry row and Quick add (on picking
   "Transfer → X") and in Quick add's transfer form (on picking From or To), only for a pair that
   takes a category (C3 RD5). The destination is the account the money goes to: X for money out,
   the account typed in for money in; a row whose side isn't typed yet counts as money out.

## Circle addendum (Epic 8 · multi-user)

> Added 2026-06-25 by the [Circle epic](../circle/README.md) writeback (D6). Payees are **one canonical
> registry** with **earned per-user visibility** — zero duplication, but privacy preserved.

- **One canonical, deduped registry.** A single `payees(id, name, name_normalized UNIQUE)` table for the
  whole Circle; on save, resolve by normalized lookup → reuse or create (never duplicated across members
  or accounts). The F3 merge tools above mop up typos.
- **Earned visibility, not a shadow per-user index.** A shared projection
  `account_payee(account_id, payee_id, last_used_at)` is upserted on write; autocomplete queries it
  **filtered by the viewer's visible account set** ([H2](../circle/H2-account-ownership-and-sharing.md)).
  So a payee becomes visible to you **only once it's been recorded on an account you can access** — if a
  co-member only ever used "Durex" on their private account, you never see it until you record it
  yourself. Shared-account payees are naturally shared among that account's members.
- **Per-user autofill.** `user_payee(user_id, payee_id, last_category_id, last_used_at)` holds the
  remember-last-category default (F2) + personal recency ranking.
- **Perf (app-wide principle):** autocomplete does **not** hit the server per keystroke. The client
  loads the viewer's small reference sets once (visible payees, categories, accounts — hundreds/few-k
  rows) and filters **locally in memory** as you type; the server is hit only on initial load + on
  mutations. FTS5 on `payees.name` is an optional later add for fuzzy search (same visible-set filter).
- **AC delta:** no duplicate payees ever; autocomplete shows only payees recorded on the viewer's
  accessible accounts; last-category memory is per-user.

## Dependencies
- **Depends on:** F2 (Categories) — the remembered category is a category id; referential
  integrity is shared.
- **Independent of:** F1 in data terms, but the **picker** references accounts (for the "Transfer →"
  options), so the entry-time picker depends on F1 accounts existing.
- **Blocks:** **Capture (C1, C2)** — the entry loop's payee field and category pre-fill; and **C3**
  (inline transfer via payee field uses this picker).
- **Excludes:** rules engine / behaviour-learning auto-categorisation (v2 / intelligence layer);
  geo-payees / location autofill (not in scope); payee-level reporting beyond basic filtering.

---

### Research sources
- Actual Budget — Payees (manage, rename, **merge** variants, delete; payee default category;
  transfers as special payees): https://actualbudget.org/docs/transactions/payees/ ;
  https://actualbudget.org/docs/transactions/transfers/ ;
  https://deepwiki.com/actualbudget/actual/6.5-payee-management
- Actual Budget — Rules (self-writing rules from behaviour = the v2 we defer): https://actualbudget.org/docs/budgeting/rules/
- YNAB — Manage Payees (edit, auto-categorize, combine/merge, deactivate); remember-last-category
  behaviour: https://www.ynab.com/blog/manage-payees ;
  https://support.ynab.com/en_us/categorizing-transactions-a-guide-HyRl60sks
