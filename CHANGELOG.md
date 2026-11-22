# Changelog

## 26.11.0 preview, 2026-11-27

The first public preview of Miserly, an expense and net worth tracker. Bank accounts, cards,
stocks, mutual funds, property and loans in one net worth, in the currency you choose. PPF, EPF,
NPS and lakhs and crores are built in too.

**Download:** `Miserly-preview-26.11.0-portable.zip` below for Windows 10 and 11, or the Docker
image `ghcr.io/justanothermedialab/miserly:26.11.0`. Setup steps are in the
[README](https://github.com/justanothermedialab/miserly#install-on-windows).

This is a preview: it works and has tests, but it's new. Keep a backup of your data file.

### Highlights

- **A register you type into.** Click any field to change it. Add a transaction from the
  register, or from **Add** on any page.
- **The accounts it knows:** PPF, EPF with its EPS, NPS Tier I and II, Sovereign Gold Bonds,
  fixed and recurring deposits, mutual funds, stocks, property and home loans.
- **Your investments at the value you last entered,** with what you put in, the return and a
  yearly rate.
- **One net worth** on the dashboard, in lakhs and crores or in thousands and millions.
- **Import from Actual Budget,** with a preview before anything is saved.

### Accounts and transactions

- Transfers between your accounts never count as spending and never change your net worth.
- Back-dated transactions fall into place, and the running balance follows.
- Transactions without a category wait in **To categorize** until you sort them.
- Payees remember the category you last used for them.

### Investments

- **Update value** records what a holding is worth today.
- Each holding has a chart of its value against what you put in.
- PPF shows what you've deposited this financial year.
- PPF, EPF, EPS, NPS and Sovereign Gold Bonds are always kept in rupees, whatever currency you
  total in.

### Reports

- Spending by category or by payee.
- Income against spending, with the share of income saved.
- Net worth by class over time.
- Each report has a table under the chart and a CSV export.
- Ranges from this month to all time, including this or last financial year.

### Currencies

- Choose the currency your totals add up in, and whether your year starts in January or April,
  when you set Miserly up.
- Accounts in other currencies are converted at rates you set. Transfers between currencies keep
  both amounts.

### More than one person

- One server can hold several people. Each person's accounts are private until they share them.
- A joint account counts in each holder's net worth at their share: equal parts, unless the
  owner sets the split.
- An admin adds and removes people and can reset a password, but never sees anyone else's
  accounts.

### Coming from Actual Budget

- Import Actual's export file from **Settings** or from the empty dashboard.
- In the preview, set each account's type and what each category group counts as.
- Importing a newer export adds only what's new. The latest import can be undone.

### Your data

- Miserly never reads your bank, SMS, email or statements, and sends nothing anywhere.
- On Windows, your data is one file on your computer and the app works offline.
- With Docker, it lives in a volume on your server. A new server asks for a one-time setup code
  from its log before the first login.
