# F4: Import from Actual Budget

> Epic 1 Foundations. Written and built 2026-11-10 (undeferred 2026-11-05). LOCKED.

## Title

Bring an Actual Budget file into Miserly, check it before anything is written, and undo it whole.

## ELI5

You used Actual. In Actual you click Settings, Export data, and it saves a zip. In Miserly you open
Settings, Import, From Actual Budget, and pick that zip. Miserly shows every account it found, what
each will become here (a bank account, a card, a PPF, an EPF, a home loan) and what it will be
worth. You fix any guess, then click Import. If it looks wrong afterwards, Undo import takes it all
back out.

## Business context

The release bar is a daily Actual user switching to Miserly. Anyone switching brings months or
years of rows; retyping them is the reason people don't switch. Actual's own export is a whole-file
zip that keeps transfer pairs, splits, closed accounts and on/off budget; its per-account CSV loses
most of that, so the zip is the import. The file is one the person opens
from another app, read on their own machine or server, nothing sent anywhere: inside the data hard
line (2026-11-05).

Actual has no account types (only on and off budget), can't categorise rows on off-budget accounts,
and records an investment's new value by reconciling. Those three facts shape the preview: the
person picks each account's type, says how plain deposits on a holding count, and Actual's
reconciliation adjustments become value updates.

## User workflow

### Happy path
1. In Actual: Settings, Export data. Actual saves `YYYY-MM-DD-<budget>.zip`.
2. In Miserly: Settings, the Import card, From Actual Budget, Choose file; pick the zip.
3. The preview opens (nothing written yet): one row per Actual account with a tick, On budget, Off
   budget or Closed, its rows, Add as (guessed), Plain deposits are (on a holding with any),
   Invested (asset holdings) and Value. Below: a group used on transfers into holdings and its kind;
   the counts; what isn't brought over.
4. The person checks the guesses, fixes a name that clashes, clicks Import N transactions.
5. The card lists the import (date, file, counts) with Undo import. The sidebar and net worth show
   the new accounts at once.

### Alt path: a newer export of the same budget
Open it the same way. Accounts already here show "Already here" and their count of new rows; only
rows whose Actual id isn't in the import log are added. Rows changed in Actual since aren't updated
(the preview says so).

### Recovery path: Undo import
Undo import (the latest import only) asks first, saying how many accounts go and how many rows were
typed into them since; it removes the import's accounts with all their rows, the rows it added to
accounts already here, and the groups, categories and payees it made that nothing else uses.

## Acceptance criteria

- [x] Settings has an Import card on desktop and hosted: "From Actual Budget. In Actual: Settings,
      Export data. Open the zip it saves." with Choose file.
- [x] The zip must hold exactly `db.sqlite` and `metadata.json`; anything else is refused in plain
      words ("This file isn't a zip.", "This zip isn't Actual Budget's export…", "This export is from
      a version of Actual that Miserly can't read…"). Sizes are bounded before unpacking (zip 60 MB,
      database 250 MB); CRCs checked; no new dependency (`node:zlib`).
- [x] The preview writes nothing. Each account: tick, In Actual, Rows, Add as (the Add account list:
      Bank account, Credit card, FD, RD, PPF, EPF, Home loan, Other loan, Mutual funds, Stocks,
      Sovereign Gold Bond, Gold, Property, Other asset, Other liability, and "EPS of" each EPF there
      will be: RD9), Plain deposits are, Invested, Value. It scrolls inside a 720 px window.
- [x] Every account comes in at Actual's balance. On the sample file, net worth reads
      −₹11,34,105.50 and each of the ten balances equals Actual's.
- [x] Transfers come in as linked pairs (C3). A pair between a spending account and a holding keeps
      its category on the spending leg (C3 RD5); other pairs drop it. A transfer to an account left
      unticked comes in as a plain row whose payee is that account's name.
- [x] A split comes in as its parts, each with its own category and amount, the parent's date and
      payee, the notes joined ("Prime Day order: Atta, oil").
- [x] Actual's "Reconciliation balance adjustment" on a holding is a value update on its date (S3
      RD10); elsewhere a Balance adjustment row.
- [x] Plain deposits are Return (as Actual left them) or Money put in, per holding, defaulted by
      type: EPF and EPS money put in (filed under Salary), others return. Invested follows the
      choice in the preview.
- [x] Actual's income group comes in as Income; other groups as Spending, or Investments where the
      person picks it for a group used on transfers into holdings (preselected when its categories
      sit only on transfers into holdings: RD3). A name already here is reused;
      a new Interest or Dividends in the income group counts as return; hidden stays hidden;
      "Starting Balances" isn't brought over.
- [x] The importer owns every imported account, private (H2); `entered_by` is them.
- [x] Importing the same file again adds nothing; a newer export adds only its new rows.
- [x] Undo import returns the file to before (accounts, rows, groups, categories, payees, the payee
      projections).

## Validation rules

- Accounts are made open, written, then closed (C4 RD6: nothing writes to a closed account). A closed
  Actual account closes only at zero and with no row after today (F1 RD17); otherwise it comes in open,
  flagged "Comes in open".
- The opening is Actual's first Starting Balance row, dated with the account's earliest row (F1 RD19:
  a start can't sit after a row). A start after today is refused (F1 RD19): the account is flagged
  "Starts after today", unticked, and refused if ticked.
- Names differ per owner and type among open accounts (C8). A clash makes the name an editable field
  in the preview, and Import waits until it's fixed.
- The whole import is one database transaction: a refusal leaves nothing behind.

## Edge cases

- The sample's PPF has interest on 31 Mar before its 1 May starting balance: the PPF starts 31 Mar.
- An Actual budget in another currency comes in as INR (one budget, one currency); not detected.
- A non-English Actual: the adjustment is matched by its English note only (see RD5).
- Two exports of one budget under different file names: the ids decide, not the name.
- An imported EPF comes with its EPS, empty unless an Actual account is added as "EPS of" it (RD9).

## Failure cases

- Not a zip, damaged, password-protected, other files inside, too large, not Actual's, a version
  without the columns read: refused in plain words, nothing written.
- A refusal during the import (a clash, a future start): the message names the account; nothing
  written.
- Undo while an imported account is shared: refused ("Cash was shared after the import. Stop sharing
  it, then undo."), the button disabled with the reason shown.

## UX considerations

- One card row, one button (the shell skill's settings rows). The preview is a dialog 64 rem wide,
  its table scrolling between a fixed header and footer, light dismiss off (an answer is needed).
- Copy: sentence case, plain words, no em dashes.
- The file goes up twice (preview, then import with the choices), so the server holds nothing
  between them; hosted and desktop behave the same.

## Operational considerations

- The zip is read in memory; the database is opened read-only from those bytes (better-sqlite3
  deserialises a buffer), never written to disk.
- The server accepts request bodies up to 64 MB (`BODY_SIZE_LIMIT`, desktop and Docker).
- Migration 0015 (additive): `imports` and `import_items`.

## Resolved decisions

1. **Actual's zip only, with a preview, "Add as" per account, Undo and re-import by Actual's ids**
   (2026-11-05). The CSV stays out (it loses transfer pairs and on/off
   budget).
2. **Plain deposits per holding, defaulted by type** (2026-11-10). Money put in
   files under the profile's `importDeposits` category (EPF and EPS: Salary, since
   EPF is part of pay, 2026-11-05), else Investments, Other.
   **Amended (2026-11-11, after a read of the money logic):** where a holding's plain deposits are money
   put in, a plain withdrawal on it (money out that isn't a transfer, the opening or a value update)
   is money taken out, filed under the same category; the preview's Invested follows. It lowers
   Invested at average cost instead of reading as a loss. On an EPF that category is Income,
   Salary, so the withdrawal also lowers that month's income, as the deposits raised theirs. A
   holding left at Return keeps its plain withdrawals uncategorised (growth), as before.
3. **The kind of a group used on transfers into holdings is the person's** (2026-11-10): Spending,
   as in Actual (the default), or Investments (F2 RD10).
   **Amended (2026-11-19):** a new group whose categories sit only on transfers
   into holdings (every row under it is a transfer whose leg in an asset holding is money in, by the
   preview's guesses) defaults to Investments; still editable. Every other new group keeps
   Spending, so a group that also carries a loan's EMI or a plain row stays Spending.
4. **Names already here are reused, not duplicated** (2026-11-10): the same name in the same-named
   group, else the one category of that name anywhere (Actual's Food, Groceries joins Miserly's
   Essentials, Groceries). A group is made only when one of its categories is new here.
   **Amended (2026-11-11, after a read of the money logic):** "anywhere" now means anywhere *of the same
   kind*. An Actual category's kind is the kind its group lands as: a group already here keeps its
   own; Actual's income group is Income; any other is as the preview's choice says (Spending by
   default). With no match of that kind, the category is made in a group named as Actual's, so an
   income Rent and a spending Rent can both exist, and an expense "Interest" or "Salary" no longer
   lands on Income's. A category in an Actual group named "Investment" left at Spending is made in
   that group (even "SIP"); set to Investments, "SIP" joins Miserly's Investments, SIP (since 2026-11-19,
   such a group is preselected as Investments: RD3).
5. **The adjustment note is matched in English only** (2026-11-10). Actual translates it; the other
   languages are deferred.
6. **Undo acts on the latest import only** (2026-11-10): a later import may have added rows to the
   earlier one's accounts. It's the one removal of accounts (F1 RD25). A transfer from an account it
   didn't make, into one it did, stays as a plain row.
7. **Payees come over only where a row uses them** (2026-11-10), so Undo leaves no orphans.
8. **A transfer whose other half isn't brought over is filed out of reports** (2026-11-11,
   after a read of the money logic; the name chosen 2026-11-12). The half that comes in (its other
   account left unticked, closed here, or brought in alone by an earlier import) is still one plain
   row named after the other account, now under **Transfer to Self**: a category in the first group
   of the Not in reports kind (Adjustments in the starter list), "Counts as return" off, made on the
   first such row if it isn't here. So it is neither spending nor in To categorize; on a holding it
   is money put in or taken out. A half that has a category in Actual keeps it. The preview says
   how many: "N transfers go to accounts left out or closed here. Each comes in as one row, under
   Transfer to Self (which reports leave out) unless it has a category in Actual." **Not mended:**
   a later import of the left-out account brings its half in alone, under the same category; the
   two halves are never linked (logged, not built).
9. **An Actual account can be an EPF's EPS** (2026-11-19). Actual keeps an EPF and
   its EPS as two off-budget accounts. Add as lists "EPS of" followed by the EPF's name, once for
   each EPF the person will have when the import lands: an open EPF of theirs already here, or an
   Actual account ticked and set to EPF in this preview. Choosing one brings that account's rows
   into the EPF's EPS (the child account, S5 RD16), never a new account; its plain deposits default
   to money put in under Salary, as the EPF's. The EPS takes Actual's opening, so it must be empty
   (no opening, no rows); one that already has money is refused in plain words, and so are two
   accounts into one EPS. An older EPF with no EPS gets one, made as Add account would. A
   re-import finds the EPS by Actual's ids ("Already here"); Undo removes the rows and empties the
   EPS again (or removes it with an EPF the import made, or the EPS it made). The name guess picks
   it for an off-budget account named like "EPS" or "Employee pension" when the file has exactly
   one EPF. The preview greys Import, with the reason, while a pick names an EPF since unticked or
   retyped.

## Dependencies

F1 (accounts, the close rules), F2 (groups, kinds, counts as return), F3 (payees), C3 (transfers),
S2/S3 (holding rule, value updates), S5 (the Add account list, EPF's EPS), H2 (ownership).

### Research sources

A read of Actual's export in its source code, and of how Actual, Firefly III, Sure and Wealthfolio
design imports; a sample file made with Actual's own API, kept with the app's tests
(`src/apps/web/test/fixtures/Sample-budget-export.zip`).
