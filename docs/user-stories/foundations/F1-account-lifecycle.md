# F1 — Account lifecycle (create · open · close · reopen)

> **Epic:** Foundations · **Story:** F1 · **Status:** LOCKED (2026-06-20)
> **MVP scope:** CRUD only, zero intelligence. See the locked plan for context.

---

## Title
As the user, I can create a financial account inside an instrument module, give it an
opening balance as of a date, and later close it (without losing history) or reopen it —
so that every balance in Miserly is anchored to real, transaction-based data from day one.

## ELI5
An "account" is one real-world money container — a savings account, a credit card, an FD,
a PPF, a flat. Before I can log anything, the container has to exist and Miserly has to know
how much was in it on the day I started tracking. This story is "make the container, tell it
its starting amount, and let me retire it later without shredding its history."

## Business context
This is the **first brick** — nothing else (transactions, transfers, net worth, charts) can
exist without accounts. Two locked design decisions land here:

1. **Single source of truth.** Every account's balance = `opening balance + Σ(its
   transactions)`. There is **no stored `value` field** that can drift. This story establishes
   *how the opening balance enters the ledger* — and the benchmark answer is: as the account's
   **first transaction**, not a mutable column. GnuCash, Firefly III, and beancount all post
   opening balances as a transaction against an `Equity:Opening-Balances` account
   ([beancount](https://academy.beanhub.io/intro/beancount-and-double-entry/),
   [GnuCash](https://wiki.gnucash.org/wiki/Closing_Books)). Modelling it as a transaction is
   what *makes* "balance = opening + Σ(tx)" literally true with one code path.

2. **Per-instrument modules.** An account is always created **within a module** (Bank, Credit
   Card, FD, PPF, …). The module fixes the account's behaviour (valuation mechanism,
   cardinality, spending-vs-holding, default side/liquidity). In MVP all modules share the same
   transaction engine, but the *type is chosen at birth and shapes everything downstream*.

**Closing, not deleting,** is the lifecycle default. Actual and YNAB both keep closed accounts
under a "Closed Accounts" area and allow reopening; delete is destructive and (per Firefly)
can silently corrupt other accounts' balances through transfer links
([Actual](https://actualbudget.org/docs/accounts/),
[YNAB](https://support.ynab.com/en_us/how-to-close-or-delete-an-account-in-ynab-ry_409Gko),
[Firefly](https://docs.firefly-iii.org/how-to/firefly-iii/finances/accounts/)). Our locked rule
— **"closed, not archived; history kept; reopenable; never hides value"** — matches this exactly.

## User workflow

### Happy path — create
1. User opens an instrument section (e.g. **Bank**) and clicks **+ Add account**.
2. Form: **Name** (required), **Currency** (defaults to base = INR), **Opening balance**
   (default 0), **As-of date** (defaults to today). Module-fixed fields (side, liquidity,
   spending/holding) are pre-set by the module and shown read-only.
3. User saves → account is created **open**, and the opening balance is written as the
   account's **first transaction** dated the as-of date. Balance immediately reads as the
   opening amount.

### Happy path — close
1. From the account's menu → **Close account**.
2. If the balance is **non-zero**, Miserly requires the user to move it: pick a destination
   account to transfer the remaining balance to (Actual's model), *or* confirm a **force close**
   that posts a single closing adjustment to bring it to zero.
3. Account moves to **Closed**; it disappears from net worth and the active section list but
   remains visible under **Closed accounts** with its full register intact.

### Alt path — reopen
- From **Closed accounts** → **Reopen**. Account returns to active; history untouched; it
  re-enters net worth from its (now non-zero, if reopened to receive funds) balance.

### Recovery path — wrong opening balance / wrong as-of date
- User edits the opening-balance transaction (amount or date) like any other transaction
  (handled fully in **C4**). Because the balance is derived, the correction propagates with no
  separate "fix balance" tool.

## Acceptance criteria
- [ ] An account can be created within a module with: name, currency, opening balance, as-of date.
- [ ] At creation the account records **`owner_id` = the creating member** and is **private by default**
      (only the owner sees it until explicitly shared); every account always has exactly one owner — no
      orphans ([H2](../circle/H2-account-ownership-and-sharing.md)). Sharing itself is a later act (H2),
      not part of F1.
- [ ] Creating an account with a non-zero opening balance produces exactly **one** opening
      transaction dated the as-of date; the derived balance equals the opening amount.
- [ ] Creating with opening balance = 0 produces **no** spurious transaction (or a zero one —
      see Resolved decisions) and the account reads 0.
- [ ] Module-derived metadata (side: Asset/Liability, liquidity, spending/holding) is applied
      automatically and is **not** free-form editable in MVP.
- [ ] An open account appears in its section list and contributes to net worth; a closed account
      does neither, but is reachable under **Closed accounts**.
- [ ] Closing a **zero-balance** account succeeds directly.
- [ ] Closing a **non-zero-balance** account requires either a transfer-out destination or an
      explicit force-close confirmation; afterwards the account balance is 0.
- [ ] A closed account can be reopened, with all transactions and history intact.
- [ ] **(v2 — deferred 2026-06-21)** The ≤1-active **soft-warn** for PPF/EPF is deferred *with those
      modules*. MVP ships **no singleton module**; `cardinality` remains a registry dimension, first
      exercised when PPF/EPF land in v2. (See Resolved decision 8.)

## Validation rules
- **Name:** required, non-empty after trim; unique within (module + active set) — duplicates of
  a *closed* account's name are allowed.
- **Currency:** must be a known currency code; defaults to base currency. (Multi-currency
  mechanics — rates, base conversion — are out of scope here; F1 only stores the field.)
- **Opening balance:** a signed decimal; may be 0; may be negative (e.g. a credit card or loan
  opened in debt — Firefly explicitly supports negative opening balances
  ([Firefly](https://docs.firefly-iii.org/explanation/financial-concepts/accounts/))).
- **As-of date:** required when opening balance ≠ 0; may be in the past **and may be in the
  future** (LOCKED — we don't babysit users; a future as-of date is a valid pre-entry of a known
  starting point). Future-dated entries are consistent with C1's future-dated-transaction rule.
- **PPF/EPF cardinality:** **soft** constraint — "≤1 active instance"; a 2nd active warns, never
  blocks. Closed PPF/EPF instances do not count against the limit.

## Edge cases
- **Opening balance = 0:** common for a brand-new account opened today; should be frictionless,
  no forced as-of date.
- **Negative opening balance:** valid for liabilities (credit card carrying a balance, loan).
  Sign convention must follow the module's side.
- **As-of date earlier than other accounts:** fine — accounts are independent; net-worth-over-time
  simply starts showing this account from its as-of date.
- **Reopening an account whose name now collides** with an account created while it was closed:
  must be detected and resolved (prompt to rename).
- **Closing an account that is the transfer partner of open transactions:** history must remain
  valid; the linked transactions in the *other* account must not break (this is the Firefly
  corruption pitfall we are explicitly avoiding).
- **Multiple closed PPF accounts + one active:** allowed; only *active* count triggers the warn.

## Failure cases
- **Delete is deferred (LOCKED):** MVP ships **Close only**, no Delete — this sidesteps the
  entire Firefly transfer-corruption bug class (deleting an account whose transfers touch other
  accounts). If Delete is ever added, it must be clearly separated from Close, warn about
  affected transfer partners, and require explicit confirmation.
- **Close with non-zero balance and no destination chosen:** block the close; explain the user
  must transfer out or force-close.
- **Force-close adjustment posted to the wrong sign:** the closing adjustment must zero the
  derived balance exactly; verify against the same `opening + Σ(tx)` computation, not a cached
  number.
- **Currency mismatch on transfer-out at close:** if the destination account is a different
  currency, this becomes a cross-currency transfer → defer/route to the Multi-currency epic, or
  restrict close-transfer to same-currency destinations in MVP.

## UX considerations
- **Create form is module-aware:** the section the user is in pre-selects the module, so the
  type isn't a generic dropdown buried in a long list — it's contextual (banking-app pattern).
- **Opening balance feels like "what's in it now,"** not like a ledger entry — the
  transaction-under-the-hood is invisible to the user (it just appears as the first register row
  labelled e.g. "Starting balance").
- **Closed accounts are one collapse away,** never deleted-feeling: a "Closed accounts" group at
  the bottom of the sidebar/section (Actual/YNAB convention).
- **Soft-warn copy for PPF/EPF** should be informative, not scolding: e.g. "You already have an
  active PPF account. Indian rules generally allow only one active PPF — keep both?" with a clear
  proceed option.
- **No "edit balance" button anywhere** — balances are derived; the only way to change a balance
  is a transaction or a valuation mark. This is a deliberate teaching cue.

## Operational considerations
- The opening transaction needs a stable **type/marker** ("opening") so reports can distinguish
  it (e.g. exclude it from cashflow income, treat it like the beancount opening-balance entry).
- Closing should be a **state change + (if needed) one adjustment/transfer transaction**, all in
  a single atomic operation — never a partial state where the account is closed but still
  carries a balance.
- **Reliability rule (carried from the plan):** any balance shown — active or closed — is always
  recomputed from `opening + Σ(tx)`; never cached in a way that can drift. Avoid an earlier prototype's
  running-balance approach.
- **Greenfield**: account + opening-transaction creation work offline in desktop mode (hosted = client↔server).

## Resolved decisions (locked 2026-06-20)
1. **Opening balance = the account's first transaction** (label "Starting balance"), not a stored
   field — one code path, zero drift; matches GnuCash/Firefly/beancount. **Counterparty =
   single-sided "opening" origin** (LOCKED), *not* a hidden `Equity:Opening-Balances` account. We
   don't track equity accounts for net worth, so the textbook double-entry counterparty buys us
   nothing in MVP; the opening entry is a one-sided "money was already here" marker.
2. **Future-dating allowed** (LOCKED) for both the opening as-of date and transactions (C1). We
   don't babysit users; a future date is a legitimate pre-entry of a known event.
   *Amended 2026-11-06 (RD19):* transactions only; the opening date can't be after today.
3. **Both close mechanics** (LOCKED): the user may **transfer the remaining balance out** to a
   chosen account *or* **force-close** (system posts one closing adjustment to zero it). Both end
   with balance = 0 and the account under Closed accounts.
4. **Delete deferred** (LOCKED): MVP is **Close only**. Avoids the Firefly transfer-corruption bug
   class entirely.
5. **Zero opening balance → no opening transaction** (default): an account opened at 0 gets no
   spurious "Starting balance" row and simply reads 0. Its first real row is the user's first
   transaction. *(Minor; revisit only if a guaranteed first row proves useful for reports.)*
6. **Account type/module is immutable after creation** (MVP): modules differ in behaviour and
   type-change is complex (Actual only toggles on/off-budget, never arbitrary type). Revisit later.
7. **No manual spending-vs-holding override** in F1: metadata stays **type-derived**. An override
   for oddball accounts can come later if a real need appears.
8. **PPF/EPF deferred to v2 → singleton soft-warn deferred with them** (LOCKED 2026-06-21): no v1
   module is ≤1-active, so MVP builds **no singleton-constraint UI**. `cardinality` stays a registry
   dimension (collection vs ≤1-active) — unused in MVP, first exercised when PPF/EPF arrive in v2. See
   [S5](../instruments/S5-instrument-profiles.md) Resolved decision 6 and architecture §5.

## Resolved decisions — build reconciliation (locked 2026-07-12, M5 audit)

> The M3 frozen schema stores no `kind='opening'` transaction, so RD1's *storage* was reconciled at
> build time; these decisions record it and settle the semantics RD1's letter used to imply.

9. **Opening balance is stored as a COLUMN (`accounts.opening_paise` + `opening_date`), not a
   transaction row.** The invariant is unchanged (`balance = opening + Σtx`, derived on read); the
   user-facing "Starting balance" register row is **synthetic**, rendered from the columns. The
   operational note above about an "opening marker" type is superseded — there is no opening row for
   reports to distinguish. Correcting a wrong opening balance/date = editing these account fields (a
   small F1 surface), **not** a C4 transaction edit.
10. **The opening is DATED for history: `balance_at(d)` counts `opening_paise` only when
    `d ≥ opening_date`** (an account with a zero opening / NULL date contributes from its first
    transaction). This restores what RD1's opening-as-first-transaction gave for free — D3's locked
    "an account that didn't exist at a given month contributes 0" — under the column model
    (GnuCash/beancount get the same behaviour from their dated opening postings). Implemented in the
    M7 history math; current-balance paths (`asOf = today ≥ opening_date` in practice) are unaffected.
11. **The force-close adjustment is a plain `ordinary` transaction stamped with the seeded
    Neutral-kind "Adjustments → Balance adjustment" category** (fixed id, rename-proof): categorized →
    it never appears in the C5 inbox; Neutral → excluded from R2/R3 spending & income. If the user
    deletes that seeded category, the entry degrades to uncategorized (Actual's `closeAccount`
    categorizes its closing adjustment the same way). Force-close therefore reuses the
    assert-value→post-gap *arithmetic* of the S3 mark, but is **not** a `valuationMark` row — S3's
    "marks apply to markable holdings only" stands with no carve-out.

**Amendments (2026-10-05, each chosen from options with their evidence):**

12. **The opening "As of" date defaults to today, editable**, and **Name** takes focus once a
    type is picked. Add account opens as a dialog from its button (type list on the left, the form on
    the right), not as an always-open wizard on the Accounts page (no forms above data).

**Amendments (2026-10-10, after a review of the app's screens):**

13. **An account can be renamed.** "Edit account" in the register header opens one dialog: Name,
    Opening balance and its As of date (RD9's account-field surface), with Close or Reopen at the
    bottom left. A rename follows the create rule (no two OPEN accounts of one owner and module share
    a name), which the reopen edge case above already assumed. The folded "Account settings" panel
    under the register is gone.
14. **Add account opens over the current page** (sidebar, All accounts, a section page, the first-run
    card, Ctrl K), and **Save opens the new account's register**, as Actual and YNAB do.

**Amendment (2026-10-21; a check of the acceptance criteria found RD3 built as one-click
force-close only, with no confirmation):**

15. **Closing an account with money left asks what to do with it, as Actual does** (restores RD3).
    A zero balance closes at once. Otherwise a small dialog states the balance ("HDFC still holds
    ₹12,400") and offers: **move it to** an open account the user can see (a linked transfer, C3,
    or MC2 across currencies) and close, or **close with an adjustment** (RD11's entry). Cancel
    leaves everything as it was. *Why:* a misclick or a forgotten transfer must not silently move
    net worth. **Built 2026-10-27** (small-fixes batch): the dialog says "HDFC still holds ₹X"
    (or "owes" for a negative balance, which is paid *from* the chosen account), with **Move and
    close** / **Close with adjustment** / Cancel; across currencies it asks the amount in the other
    account's currency. The transfer is posted first, then the close, so a failure leaves the
    account open at zero, never closed with money gone.

16. **A card or loan can start in credit** (2026-11-05).
    Add account's "Current outstanding" takes a negative amount ("Amount owed, minus if in
    credit"), which opens as a positive balance: an overpaid card or loan. Holdings' Invested and
    Value still can't be negative.

**Amendments (2026-11-06, after a review of the app):**

17. **A close works on the as-of-today balance and waits for rows dated later**. While an
    account has rows dated after today, Close (both answers of RD15) is refused: "This account has
    1 upcoming row (5 Dec 2026). Delete or move it first." Checked in the route before Pay and
    close moves money and again in the service. *Why:* the zeroing row zeroed the projected
    balance, so a closed account still held the future rows' amount as of today, and the headline
    and the net worth line disagreed (the class of Actual's #5413).
18. **A closed account's opening can't change**. The service refuses it ("This account is
    closed. Reopen it to change its opening balance."), and Edit account on a closed account shows
    the opening and its date as text with "Reopen to change the opening balance."; the name and the
    details still save. The same rule covers every row write (C4 RD6). *Why:* a new opening gave a
    closed account a balance again, counted by the net worth line but not the headline.
19. **A start date can't be after today, and an edit can't move it past the first row**
    (amends RD2 for the opening date only: future-dated rows stay allowed).
    Add account and Edit account refuse a start (As of) date after today ("The start date can't
    be after today"); Edit account also refuses moving it after the account's first row ("The
    start date can't be after the account's first row (10 Jan 2025)"). A row typed before an
    unchanged start stays allowed (C4 RD5); an amount-only edit keeps the stored date. *Why:* a
    future start counted in the headline but not the line, and a start moved past the first
    rows dropped them from the line's earlier points.
20. **One name can show twice, so lists add who owns it and whether it's closed**.
    Names stay unique per owner and type, ignoring case and spaces (Firefly III's rule; a
    Circle-wide check would reveal other members' accounts). Where two can meet, a co-member's
    account reads "HDFC (Bob's)" and a closed one "HDFC (closed)": payee and account pickers and
    the other side of a transfer (C3 RD6).
21. **Edit account's opening reads as Add account's** (2026-11-06, after a review of the app). The field
    takes the type's own label ("Amount invested", "Principal invested", "Current outstanding"),
    and a card's or loan's outstanding is typed as a positive amount owed (minus if in credit) and
    stored negative, as RD16; a holding's amount invested can't be negative. *Why:* Edit account
    showed every opening as a signed "Opening balance", so a ₹5L loan read −5,00,000 and a typed
    5,00,000 turned the loan into ₹5L of credit.
22. **One name in two sections adds the section** (2026-11-06). When two accounts
    the viewer sees, open or closed, share a name (case and spaces aside) and sit in different
    sections, each reads with its section in the sidebar's words: "HDFC (Bank accounts)", "HDFC
    (Mutual funds)". It goes before RD20's tags ("HDFC (Mutual funds) (Bob's)", "HDFC (Bank
    accounts) (closed)") and applies everywhere an account is named outside its own section:
    Quick Add's and All transactions' Account field once picked, All transactions' Account column,
    Recent activity, a transfer's payee text ("Transfer → HDFC (Mutual funds)"), the close
    dialog's account list, To categorize, the Reports drill rows, the search's Accounts results,
    the dashboard's shared-accounts table. A list already under a section heading (the payee
    lists, the Account lists, the sidebar, All accounts, a section page) shows the bare name, as
    do the register's own title and breadcrumb. A name only one account has stays bare, and so do
    two in one section (RD20's tags tell those apart). Only the viewer's visible set counts (P0:
    another member's private account never changes how a name reads). *Why:* the lists were clear
    (C3 RD6) but after the pick "HDFC" read the same for a bank and a fund.
23. **The close dialog says what a write-off does** (2026-11-09, after a review
    of the app). With money left, Move (or Pay) and close leads, as Actual's close asks for the
    account the money went to; the other answer reads "Write off ₹1,07,000 as a loss" (it read
    "Close with adjustment"), and the text says "Move it to the account it went to. If it's gone,
    write it off as a loss." An account that owes keeps "Close with adjustment". A closed holding's
    register shows what it earned (S2 RD13), so a write-off reads as the loss it is, not "−100 %".
24. **Closing follows the account an account belongs to** (2026-11-10, S5 RD16). An EPF closes
    only once its EPS holds nothing ("Its EPS still holds money. Close that first, on its tab.",
    in the close dialog, Close, and Pay and close, like RD17's upcoming rows); then both close.
    Reopening the EPF reopens its EPS; renaming it renames its EPS ("EPS of" + the name). An EPS
    closes on its own by RD15/RD23. Since 2026-11-10, after Add account the sidebar and net
    worth show the new account at once (the layout reloads).
25. **Undo import is the one removal of accounts** (2026-11-10, F4 RD6). Accounts are still
    closed, never deleted, with one exception: Undo import removes the accounts an import made,
    with all their rows, refused while one is shared. An import makes its accounts open, writes,
    then closes what Actual closed (at zero, nothing after today; otherwise open, flagged).

## Circle addendum (Epic 8 · multi-user)

> Added 2026-06-25 by the [Circle epic](../circle/README.md) writeback (D6). The locked body above is
> single-user; under multi-user the lifecycle is unchanged except for **ownership**.

- **Creator = owner.** At creation the account records **`owner_id` = the creating member** and is
  **private by default** (only the owner sees it). Sharing is a separate, later act — see
  [H2](../circle/H2-account-ownership-and-sharing.md). F1 itself gains no sharing UI; it only stamps the
  owner.
- **Lifecycle is per-account, not per-Circle.** Close/reopen work as specified; closing a **shared**
  account removes it from **every** holder's net worth (closed-not-archived) but keeps it browsable for
  all its members under Closed accounts.
- **Owner removal interaction (H3):** a member who owns **shared** accounts cannot be removed from the
  Circle until those are reassigned/unshared — an account must always have a valid owner (no orphans).
- **AC delta:** every created account has exactly one `owner_id` (its creator) and starts private;
  no account exists without an owner. **Folded into the canonical Acceptance criteria above (2026-06-25,
  MODE 2.5 M1).**

## Dependencies
- **Depends on:** the instrument-module registry (which modules exist and their fixed metadata)
  — a structural prerequisite, defined as part of the greenfield architecture, not a user story.
- **Blocks:** F2/F3 indirectly and **all of Capture (C1–C5)** directly — you cannot log a
  transaction without an account.
- **Related / shared primitive:** the **valuation-mark** mechanism (mark-to-market) is the same
  "assert a balance, synthesize the adjustment" pattern as beancount's `pad`/`balance`
  ([beancount](https://academy.beanhub.io/intro/beancount-and-double-entry/)); opening balance,
  force-close adjustment, and mark-to-market should likely share one implementation.
- **Cross-epic:** close-by-transfer touches the Transfer story (C3) and, if cross-currency, the
  Multi-currency epic.

---

### Research sources
- Actual Budget — Accounts (close/delete/reopen, Closed Accounts): https://actualbudget.org/docs/accounts/ ; API reference (`closeAccount` transfer/category, `deleteAccount`): https://actualbudget.org/docs/api/reference/
- YNAB — Close or delete an account (close preserves history; recommended over delete): https://support.ynab.com/en_us/how-to-close-or-delete-an-account-in-ry_409Gko
- Firefly III — Accounts & types, negative opening balance, delete-removes-transactions / transfer-corruption warning: https://docs.firefly-iii.org/explanation/financial-concepts/accounts/ ; https://docs.firefly-iii.org/how-to/firefly-iii/finances/accounts/
- GnuCash — Opening balance via equity, Closing Books: https://wiki.gnucash.org/wiki/Closing_Books
- Beancount — opening balance as transaction against `Equity:Opening-Balances`; `pad` + `balance` synthesizing an adjustment (the valuation-mark pattern): https://academy.beanhub.io/intro/beancount-and-double-entry/
