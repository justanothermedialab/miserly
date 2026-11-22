# Notes for coding agents

Miserly is an expense and net worth tracker for people who type their own transactions. The base
currency is chosen at setup (rupees by default); Indian schemes such as PPF, EPF and NPS have
their own account types. It is not an envelope budgeting tool.

## Where the truth is

`docs/` is the specification, written before the code, and the code is held against it. Read in
this order: `docs/product/overview.md`, `docs/product/architecture.md`,
`docs/product/workflows.md`, `docs/user-stories/README.md`, then `docs/tech-stack.md` before
writing code. Each story has a "Resolved decisions" block: changing one is a deliberate act, not a
side effect of a code change. `docs/user-guide/` is the user guide's source.

## Layout and commands

A pnpm workspace in `src/` (pnpm 10, Node 24):

- `src/packages/core`: the money engine in plain TypeScript. No framework, UI or database imports.
- `src/apps/web`: the SvelteKit app (Svelte 5, better-sqlite3 with Drizzle, Tailwind v4,
  shadcn-svelte on Bits UI, LayerChart).
- `src/apps/desktop`: the Electron shell that runs the same server on 127.0.0.1.

From `src/`:

```
pnpm install
pnpm -r test        # Vitest, core and web
pnpm -r typecheck   # tsc and svelte-check
pnpm -r lint        # ESLint, including the aggregation import boundary
pnpm --filter @miserly/web dev
```

## Rules the code depends on

- Every account is transaction based: balance = opening + the sum of its transactions. Nothing
  stores a separate value that can drift.
- Rows are ordered by `(date, sequence)`, never by insert id. Running balances are worked out on
  read, so back-dated rows land in the right place.
- A transfer is two linked rows. Net worth doesn't change under a transfer, and transfers stay out
  of spending reports.
- Holdings are valued by marks the user types; the gap is posted as one adjustment row.
- Every account type exposes the same contract (`packages/core/src/aggregation/contract.ts`):
  current value, cost basis, cash flows and metadata. Net worth, allocation and growth read only
  the contract. A branch on the account type inside aggregation is a defect; a new type is a new
  module.
- Money is integer paise (minor units); dates are `Temporal.PlainDate`.
- Every read or write scoped to a person goes through `accountsVisibleTo`. Someone an account
  isn't shared with must not learn it exists. An admin manages members, not their data.
- The schema (`apps/web/src/lib/server/db/schema.ts`) and the contract are frozen interfaces.
  Migrations are forward only, keyed on `PRAGMA user_version`, with a backup first.
- The app never reads or links to a person's financial data: no bank, broker, SMS, email or
  statement access. What the user types is the record. Public price files, downloaded whole and
  looked up locally, are allowed.

## Writing for the screen

Sentence case, plain labels, no em dashes, no `·` chains, no slogans.
