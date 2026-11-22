# H2 — Account ownership & sharing (personal-by-default · per-account membership)

> **Epic:** Circle & shared accounts · **Story:** H2 · **Status:** LOCKED (2026-06-25)
> **MVP scope:** CRUD, zero intelligence. Provenance: MODE 2 decision D6 + domain HH-1.

---

## Title
As an account's owner, I can keep it **private by default** or **share it** with specific members of my
Circle, who then get full view/edit/add rights on that account — so a Circle can have both individual
privacy and genuinely shared money, with no all-seeing access.

## ELI5
Some money is just mine (my salary account); some is ours (the flat's expense pool). This story is the
switch: every account starts **private to whoever made it**, and the owner can hand specific people a
key to specific accounts. If I give you a key, you can fully use that account like I can. If I don't,
you can't even see it exists. A "shared account" is simply any account that more than one person holds a
key to.

## Business context
This is the **core of the privacy model** — the thing that makes "individual privacy + shared money"
real. Locked decision **HH-1**:

1. **Personal-by-default.** Every account has an **owner** (its creator, set at F1 creation) and is
   **invisible to all other members** until shared. No member — *not even the admin* (H3) — can see an
   account they haven't been added to.

2. **Per-account membership, full-access tier only.** The owner explicitly **adds specific members to
   specific accounts**. An added member gets **full view + edit + add-transactions** on that account —
   there is **no view-only / read-only tier** in MVP (it was considered and dropped: it doubles the
   permission surface for a niche need; sharing in a small trusted Circle means "you can actually use
   this"). A **shared account = any account with >1 member.**

3. **Visibility is the spine of every aggregate.** From here on, the rule every scoped query reads is:
   **the viewer's visible set = accounts they own ∪ accounts they're a member of.** Net worth, reports,
   transfers, and payee visibility (D/R/C/F edits) all filter to this set. The aggregation contract
   (architecture §5) is **unchanged** — visibility filters *which accounts feed it*, never the contract.

Schema added here: **`account.owner_id`** (→ `users`) and **`account_members(account_id, user_id, …)`**
(the share grants). The visible-set query is the join used everywhere downstream.

Benchmark note: most personal-finance tools are single-user (Actual, YNAB) or treat all of one instance's
data as one pool (Firefly III users are isolated, not *selectively* sharing). Per-account selective
sharing inside one Circle is closer to a shared-drive permission model than to any finance-app precedent
— hence we keep it deliberately simple (binary: shared or not, full access).

## User workflow

### Happy path — create (sets ownership)
1. Member creates an account via **F1** (in a module). The creator is recorded as **`owner_id`**; the
   account is **private** (no members beyond the owner).
2. It appears only in the owner's sidebar/net worth.

### Happy path — share an account
1. Owner opens the account → **Share** (or **Account settings → Members**).
2. Owner picks one or more Circle members to add. Each added member immediately gains **full access**.
3. The account becomes a **shared account**; it now appears in each member's sidebar, net worth (in
   full), registers, and pickers.

### Happy path — unshare / remove a member
1. Owner → account **Members** → remove a member.
2. ~~That member **immediately loses all access**~~ That member can no longer change it from that
   day (RD9): it drops from their sidebar, net worth, and pickers, and stays readable, read-only,
   for the dates they held it (All accounts, "No longer shared with you"). History they entered
   remains (their `entered_by` stamps persist for the owner/remaining members).

### Alt path — a member uses a shared account
- An added member can add/edit/delete transactions, run valuation marks, and transfer **to/from** it
  exactly like the owner (subject to H4 visibility on the *other* leg). Their entries are stamped
  `entered_by = them` (C1/C2 edit).

### Recovery path — shared the wrong account / wrong person
- Owner removes the member (above); access revocation is immediate. No data is destroyed; only
  visibility changes. (Mis-entered *transactions* are corrected via C4, unchanged.)

## Acceptance criteria
- [ ] Every account has exactly one **`owner_id`**, set to its creator at F1 creation, and is **private
      by default** (no `account_members` rows beyond — see Resolved decisions — the owner).
- [ ] A non-owner, non-member **cannot see** an account in any surface (sidebar, net worth, allocation,
      reports, registers, transfer pickers, payee autocomplete) — it is as if it does not exist.
- [ ] An owner can **add** one or more Circle members to an account; each gains **full view/edit/add**
      immediately, ~~on the whole account~~ for the dates from the day they were added (RD9: the
      balance that day, nothing earlier).
- [ ] An owner can **remove** a member; that member ~~**loses all access immediately**~~ can change
      nothing from that day, across every surface, and reads the dates they held it, nothing later
      (RD9).
- [ ] There is **no view-only tier** — added members have the same capabilities as the owner on that
      account (MVP).
- [ ] An account with >1 holder is treated as a **shared account** wherever the shared/personal
      distinction matters (the share, RD8; the Shared view and the by-member breakdown are gone, D1 RD12
      and R2 RD11).
- [ ] The **visible-set rule** (`owned ∪ member-of`) is implemented **once** as a shared service and is
      the basis of every viewer-scoped query (D1/D2/D3, R2/R3, C3, F3).
- [ ] Removing a member **does not delete** any transactions; `entered_by` stamps they created persist.
- [ ] Only the **owner** manages an account's membership in MVP (not other members, not admin — see
      Resolved decisions / H3).

## Validation rules
- **owner_id:** required, immutable in MVP (no ownership transfer — see Resolved decisions); must be an
  active Circle member.
- **account_members:** `(account_id, user_id)` unique; `user_id` must be an active member; the **owner
  is implicitly a holder** and is not required to appear as a row (or appears as one canonical row — see
  Resolved decisions 6); a member cannot be added twice.
- **Self-add/owner-add:** adding the owner as a member is a no-op (already has full access).
- **Cross-account integrity:** sharing changes visibility only; it never alters balances, the ledger, or
  the aggregation contract.

## Edge cases
- **Owner shares an account that is a transfer partner** of an account the new member *can't* see: the
  member sees the leg in the shared account; the partner leg stays private (the transfer is still
  internally linked — see H4 for the visibility-vs-linkage handling).
- **Member removed from an account they entered transactions in:** their rows stay; the stamp persists
  for audit; they simply can no longer see them.
- **Owner is removed from the Circle entirely** (H3 admin action): their **private** accounts go with
  them (still theirs); **shared** accounts they own need a defined outcome → **resolved in H3** (block
  removal while they solely own shared accounts, or reassign — H3 owns that rule).
- **Last holder of an account = the owner only:** that's just a private account; nothing special.
- **Two members both want to “own” a genuinely joint account** (e.g. a real joint bank account): MVP
  models it as **one owner + the other as a full member** (functionally identical access); true
  co-ownership/transfer is deferred (Resolved decisions 4).
- **A shared account is closed** (F1 close): it leaves everyone's net worth (closed-not-archived) but
  stays browsable for all its members under Closed accounts.

## Failure cases
- **Visibility leak (the P0):** any surface that shows an account, its balance, its transactions, or
  even its *existence* to a non-holder is a **P0 privacy defect**. The visible-set filter must be applied
  server-side in the shared aggregation/query service — **never** enforced only in the UI.
- **Admin override leak:** the admin querying "all accounts" and seeing private ones is the same P0 —
  admin is **not** a data-access role (H3). No endpoint returns accounts outside the caller's visible set.
- **Stale access after removal:** a removed member retaining access (cached session, un-invalidated
  query) is a defect — revocation is checked on every request via the visible-set service, not cached
  past the change.
- **Membership write by a non-owner:** only the owner may mutate `account_members` in MVP; any other
  caller is rejected (authorization defect otherwise).
- **Orphaned account (owner deleted without resolution):** must be impossible — H3 blocks/reassigns
  before removal; an account must always have a valid owner.

## UX considerations
- **Sharing is an explicit, visible act** on the account — a **Share** affordance + a small **Members**
  list showing who holds it; a clear **Shared** badge on shared accounts (the prototypes' account chip
  can carry it).
- **Private is the silent default** — creating an account never prompts about sharing; the owner opts in
  later when they mean to.
- **Removal is honest, not destructive-feeling:** "Remove <member> from this account? They'll lose
  access; nothing they entered is deleted."
- **No permission matrix** — sharing is "pick people," not "pick people × capabilities" (there's only
  one capability tier). Keeps it unscary for non-technical members.
- **Shared accounts read identically** to private ones in the register (same dense ledger UX); the only
  addition is the Members affordance and the `entered_by` column/feature surfacing who logged a row.

## Operational considerations
- **One visible-set service** (`accountsVisibleTo(user)` → owned ∪ member-of) is the shared primitive;
  every scoped query (net worth, allocation, growth, reports, transfer pickers, payee autocomplete) is
  built on it (§11 shared-service discipline). No query re-derives visibility ad hoc.
- **Authorization vs visibility** are distinct: *visibility* = can you read it (visible-set); *ownership*
  = can you manage its membership (owner only). Both are server-side checks.
- **Indexes:** `account.owner_id` and `account_members(user_id)` / `(account_id)` indexed — the visible-
  set join runs on essentially every page load; it must be cheap (trivial at Circle scale).
- **Schema is sync-ready** like the rest (UUID PKs, timestamps, soft-delete tombstones on
  `account_members` so an un-share is a tombstone, not a hard delete — preserves audit/sync intent).
- **Greenfield/offline:** in desktop mode the single signed-in user simply sees their own visible set;
  sharing is most meaningful in hosted mode but the model is identical.

## Resolved decisions (locked 2026-06-25)
1. **Personal-by-default** (HH-1): accounts are private to the owner until explicitly shared; no member,
   including admin, sees an account they're not on.
2. **Full-access tier only — no view-only** (HH-1): added = full view/edit/add. A read-only tier was
   considered and dropped (doubles permission surface for a niche need in a small trusted Circle). Can be
   added later if a real need appears.
3. **Owner manages membership** (HH-1, flagged-and-confirmed): only the owner adds/removes members for
   their account; admin does **not** override this (H3). Sensible default for "it's my account."
4. **Single owner, no co-ownership / ownership transfer in MVP**: a real joint account is modelled as one
   owner + the other as a full member (identical access). Co-ownership and ownership transfer are
   deferred (they add reassignment complexity for no MVP capability gain).
5. **Visible set = owned ∪ member-of**, implemented once as a shared service; it is the single basis for
   all viewer-scoping (D/R/C/F edits) and the aggregation contract stays unchanged (only its input set
   is filtered).
6. **Owner membership representation** is an implementation detail (implicit via `owner_id`, or one
   canonical `account_members` row for the owner) — either is acceptable provided the owner always has
   full access and counts as a holder; chosen at build time.
7. **Un-share = tombstone, not hard delete** — consistent with sync-ready soft-deletes; preserves audit
   and avoids resurrecting stale grants.
8. **Shares on a shared account** (2026-10-20; option C of three ways to split a joint
   account, chosen 2026-10-17). Every holder of a shared account (the owner and
   each added member) has a share. Equal by default: nobody types anything unless the split is
   unequal (a 60 / 40 plot, a parent-funded FD at 100 / 0). Only the account's owner edits the
   split, and it must add to 100 %. ~~One share per holder for the account's whole life in this
   version (no back-dated share changes).~~ **Shares are dated (2026-10-21, after accounting,
   data-modelling and app research: overwriting a share rewrites history; partnership accounting
   applies a new ratio from a stated date, SCD Type 2 and Fowler's Effectivity store each change
   with its start, Kubera dates shares):** each change of split takes a **From** date (today by
   default, a past date allowed) and applies from that date on; earlier dates keep the old split. Adding
   or removing a holder is a dated change too. A buyout's money is an ordinary transfer the members
   type; the share change moves only the ownership. ~~Adding or removing a holder resets the split to equal,
   which the owner can edit again.~~ **Adding or removing a holder (2026-10-21, after a web
   check: no app silently changes a stated split; equal is the default only when nothing was
   stated; Kubera, Splitwise, co-ownership law):** ~~while the split has never been edited it stays
   equal (1/n, nothing to lose)~~ while the split has never been stated, the people holding the
   account on a date have equal parts of it that day (1/n; see below); once the owner has set one, the stated shares stay, a new holder
   starts at 0 % and a removed holder's share returns to the owner. Either way the Share dialog
   says so in place, with the split fields open ("Bob has 0 %. Set the split."; an InfoBar, never
   a tooltip). Nothing changes anyone's figures without the owner seeing it. Stored in basis points in a small dated table
   (migration 0010, one row per holder per change with its from-date; no rows = equal, so existing
   data needs no backfill; the SQL approved 2026-10-27, keeping a CHECK that bounds each share to 0 to 10,000 bp in the database itself; the 100 % sum is checked in the service). A joint debt counts at the share in net worth, and the account says "you're liable for
   the full ₹X" (co-borrowers are jointly and severally liable). Registers and Recent activity keep
   the account's full amounts (they are the record), with a "your share 50 %" note on a shared
   account. ~~Sidebar balances keep the full amounts.~~ **Amended 2026-10-30 (option B of
   two):** the sidebar, section pages and All accounts show every figure at the
   viewer's share, rows and subtotals alike, so rows add to their group and groups add to the net
   worth above them; a joint account's row says its share ("50%" in the sidebar, "Your share 50%" on
   the pages). The full balance, the one the bank shows, is in the register. Why: the sidebar is
   headed by net worth, and a data analyst checks that what sits under a total adds up to it
   (option A, full rows under share subtotals, broke the sum inside every joint group); Kubera counts
   a part-owned asset at its share the same way. Supersedes the Shared view mentioned above.
   *Built 2026-10-30:* the account page's "People with access" flyout lists each
   holder's share; the owner's **Set split** opens one percentage per holder, a running total (Save
   only at 100%) and a **From** date (today by default; "Earlier dates keep the split they had").
   Saving a split on a date that already has one replaces it whole: that is how a mistake is
   corrected (removing a past change outright is not built). While a stated split gives someone 0%
   the flyout says "Bob has 0%. Set the split." with the fields open. The register header reads
   "Your share 50%, ₹X" and, on a joint debt, "You're liable for the full ₹Y"; Reports' drill rows
   keep full amounts and say "Your share 50%".
   **Holders by date (2026-11-09, after a review of the app; decided as a change to the frozen schema):**
   ~~equal (1/n) for every date~~ adding a holder is dated on the owner's today (`appClock`) and
   removing one too: migration 0013's `account_holder_periods` keeps each member's stretch (from
   the day they were added up to the day they were removed; a re-share starts a new one, the earlier
   is kept). A split applies only on the dates someone held the account, so sharing leaves the
   owner the whole of the past (Alice's ₹40,000 of March 2025 groceries stay ₹40,000 when she shares
   in November 2026; it read ₹20,000 each), and an unshare keeps the split of the dates the member
   held it, for them and the owner alike (it put the owner's whole past back at 100 %). Shared and
   removed on one day leaves no stretch. A grant from before 0013 counts as held since the start
   (what that member saw), so no backfill. The Share flyout says "Shared from today. Earlier dates
   stay yours." Why: partnership accounting and Splitwise apply a new share from its date; RD8
   already said "adding or removing a holder is a dated change too".
9. **A holder sees an account for the dates they held it** (2026-11-09, after a review of the
   app). ~~Added member =
   full access to the whole account; removed = loses all of it.~~ A member holds a shared account for
   stretches of dates (migration 0013, `account_holder_periods`): from the day they're added up to the
   day they're removed. Inside them they have full access (RD2 holds); outside them nothing. Before
   their first day the register shows one line, "Balance when you joined"; after they leave it is
   read-only and shows nothing later (its figures are the balance on their last day, and All accounts
   lists it under "No longer shared with you"). Their figures (net worth line, Reports) count their
   share for those dates only, so nobody's past is rewritten, the owner's or theirs. Rows, payees,
   the inbox, Recent activity and Reports' drill rows show only the dates held; a member adds or
   changes rows only on those dates while they hold it ("This account was shared with you on 6 Nov
   2026. Rows dated before that stay with its owner."), and a row id from outside them is "not
   found", as an account they can't see. The opening balance is the owner's (a member who joined
   later can't change it). A transfer between a member's own account and the joint one inside their
   dates stays readable on both sides after they leave ("To Joint (Alice's)"); its amount
   stays with whoever holds both halves: the owner shares it again (the member gets their earlier
   dates back) or H3 RD8 applies once the member has left the Circle. One rule, in `visibility.ts`
   (`viewerStretches`, `heldRowSql`, `canWriteOn`); `accountsVisibleTo` still means "holds it now",
   so every write and picker kept its gate. A grant from before 0013 counts as held from the start.
   Why: it matches a bank statement and Splitwise (a past member keeps the group's history of their
   time); nothing from before or after a holder's time leaks; A (lose it all) changed their own past
   figures, B (numbers without rows) showed totals from an account they couldn't open. Privacy
   property tests: `test/holder-stretches.property.test.ts`.
10. **An account that belongs to another is shared with it** (2026-11-10, S5 RD16): sharing,
    unsharing and a stated split act on an EPF and its EPS together, whichever page asked, with
    the same dates (RD8, RD9). A holder of the EPF sees its EPS; a non-holder sees neither.
    Since 2026-11-18 (after a security read) the whole family is checked first and written in one
    step: a refusal on either account changes neither.
11. **A member added to a holding later is measured from the day they joined**
    (2026-11-12, after a security read and a read of the money logic). The register already starts there for
    them (RD9); the holding's figures now follow it. For a member who holds it from a date (not its
    owner, not a share from before migration 0013): Invested is the holding's value at the end of
    the day before they joined plus what was put in since (less what was taken out); the return is
    measured against that; "tracked since" is the day they joined; the yearly rate runs from that
    day. Their section row is their part of the same, and the chart's Invested line starts at the
    value on that day. Worked: Alice's fund, ₹10,00,000 in on 1 Apr 2019, worth ₹18,00,000, shared
    half with Bob from 1 Nov 2026. Bob's header reads Invested ₹18,00,000, return 0, tracked since
    1 Nov 2026 (it read ₹10,00,000, +₹8,00,000, since 1 Apr 2019); his row ₹9,00,000 and 0 (was
    ₹5,00,000 and +₹4,00,000). Alice's figures do not change: giving away half already reads as
    taking half out at average cost (S2 RD3). Why: the amount and the yearly rate then agree for
    the member, and nothing from before they joined reaches their page (the opening is hidden
    there already). Server functions only (`dashboard.ts`), no change to the contract.

## Dependencies
- **Depends on:** **H1** (members must exist to be added; the current-user gate) and **F1** (accounts to
  own/share; `owner_id` is set at F1 creation — F1 gains a cross-link).
- **Blocks / feeds:** the **visible-set service** consumed by **D1/D2/D3** (viewer-scoped net worth +
  Shared view), **R2/R3** (viewer-scoped reports at the share), **C3/H4** (transfers among
  visible accounts), **F3** (earned-visibility payees filtered by accessible accounts).
- **Related:** **H3** owns the *Circle-level* membership lifecycle (adding/removing a person from the
  Circle, and what happens to accounts they own) — distinct from H2's *per-account* sharing.
- **Architecture:** introduces the visibility rule recorded in **architecture §12** ("whose net worth").

---

### Research sources
- Firefly III — per-user data isolation within one self-hosted instance (contrast: isolation, not
  selective sharing — motivates our per-account model): https://docs.firefly-iii.org/
- Actual Budget / YNAB — single-user budget files (the baseline our multi-user layer extends): https://actualbudget.org/docs/ ; https://www.ynab.com/
- General access-control modelling — resource-owner + per-resource membership (shared-drive style ACL),
  applied here as a deliberately binary (shared / not) grant to keep the surface minimal.
