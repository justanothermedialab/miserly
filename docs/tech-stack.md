# Technical architecture & stack (the build decisions)

> The engineering counterpart to [`product/architecture.md`](product/architecture.md). That doc is the
> **conceptual** backbone (double-entry, derived balances, the aggregation contract — *what's true of
> the data*); **this** doc is the **technical** backbone (*what we build it with and how it's deployed*).
> These are the locked MODE 2 decisions (D1–D10), the durable record of the stack the greenfield rebuild
> follows.

## Scale reality (why almost nothing here is performance-driven)

**One instance = one Circle: ≤ a handful of users, one server, ≤ ~500k rows over a decade.** Indexed
SQLite does this without breaking a sweat. So the stack optimizes for **correctness, maintainability,
and solo velocity** — not throughput. Any "we might need to scale" argument is answered by the numbers:
we won't.

## The shape in one paragraph

**ONE SvelteKit (full-stack) TypeScript app.** The Svelte 5 UI and the Node server live in the same
project; server endpoints / form-actions hold the data logic and talk to **SQLite via better-sqlite3**
through **Drizzle** (raw SQL for the hairy aggregations). The same server ships two ways: **Electron**
bundles it on `127.0.0.1` (desktop, offline, data = a local file) and a **Docker image** runs it for
self-host / homelab (data on the server, open a URL, multi-device for free). Multi-user is the **Circle**
model (per-account sharing, server-side session auth).

## Stack table (D1–D10)

| Layer | Choice | D# |
|---|---|---|
| Language | TypeScript end-to-end | D1 |
| Desktop shell | Electron (wraps the server on localhost) | D2 |
| Core architecture | **Server-centric** — Node server + SQLite; browser = client | D3 |
| UI framework | Svelte 5 (runes) | D4 |
| Styling | Tailwind (+ shadcn-svelte) | D5 |
| Users | Multi-user **Circle** (per-account sharing) | D6 |
| App structure | SvelteKit full-stack (subsumes Vite + server + meta-framework) | D7 |
| Auth | Thin **owned** session auth — Argon2id + SQLite sessions; no OAuth/signup | D8 |
| Data access | **Drizzle** on better-sqlite3 + raw-SQL escape hatch | D9 |
| API style | SvelteKit-native (load fns / form actions / typed endpoints) | D10 |
| Components | shadcn-svelte + Bits UI / Melt | D10 |
| Charts | LayerChart | D10 |
| Register grid | Hand-roll (TanStack svelte-table if needed); **no AG Grid** (license trap) | D10 |
| Testing | Vitest + Playwright + **fast-check** (property-based ledger invariants) | D10 |
| Money / dates | **Integer paise** (INTEGER) + **Temporal.PlainDate** | D10 |
| Packaging | Electron + Docker, both wrap the one SvelteKit Node server | D10 |

## Deployment model — two modes, one server (the local-first reconciliation)

The original plan assumed **local-first-in-the-browser** (Actual's SQLite-WASM model). **D3 superseded
that**: the engine + data live in **one Node server**; the browser is a client. The same portable TS
server runs in two homes, giving two deployment modes:

- **Desktop (Electron):** Electron bundles the SvelteKit Node server on `127.0.0.1`. Data = a local
  SQLite file (the eviction-immune **system of record**). **Fully offline** — no internet needed for any
  operation (manual FX rates included). This is where the "local-first / offline" promise still holds.
- **Self-host (Docker):** the same server runs on a homelab/VPS. Data lives **on the server**; members
  open a URL, no install, **multi-device for free** (central data → **no sync engine needed**).
  Trade-off: not offline; small network latency (negligible on a LAN). This is the conventional
  self-host most people expect (cf. Firefly / Ghostfolio / Maybe).

**What D3 deleted** from the WASM-era plan: SQLite-WASM, OPFS, COOP/COEP headers, browser
storage-eviction risk, multi-tab corruption, and **the sync engine** (multi-device is solved by hosting,
not by sync). The engine no longer "must run in a Web Worker" — it *is* the Node server; the old
Worker↔UI boundary became the client↔server HTTP/WS boundary (same async pattern). Data access got
**simpler** (native better-sqlite3, no WASM wrapper). The schema is still kept **sync-ready cheaply**
(UUID PKs, per-row timestamps, soft-delete tombstones) as insurance, but sync is effectively dropped.

> **This is the reconciliation of [`architecture.md` §11](product/architecture.md#11-shared-service-discipline--deployment-model):**
> "no network needed for any MVP operation" is now precise — it is a **desktop-mode** guarantee. In
> hosted mode the client talks to the server. The conceptual rules (single source of truth, derived
> balances, shared-service discipline) are **unchanged** by the deployment pivot.

## Internal structure (non-negotiable)

- **Pure-TS, framework-agnostic domain engine.** The ledger / double-entry / valuation-mark /
  aggregation logic is plain TypeScript imported by server endpoints. It does **not** import SvelteKit,
  the DB driver concretely, or any UI. This makes the UI choice **reversible** and the engine
  **property-testable** in isolation (the real payoff of D1 all-TS).
- **The aggregation contract is sacred** ([architecture §5](product/architecture.md#5-per-instrument-modules-behind-one-aggregation-contract)):
  aggregation imports only the contract + registry, never a concrete module; **any `if module === 'FD'`
  in an aggregation path is a defect.** Enforce with an ESLint import-boundary rule.
- **Derived-on-read** ([architecture §1](product/architecture.md#1-single-source-of-truth--derived-never-stored)):
  balances / net worth from ordered transactions (`(date, sequence)`), memoised in memory + invalidated
  on write; nothing stores a drift-able value. The ledger *is* event-sourcing without the framework.
- **Separate financial data from UI/session state** (panels, column widths, theme, selection live
  outside the financial DB) so exports stay pure-finance and UI corruption can't harm data.

## Data & money rules

- **Money = integer paise** in INTEGER columns (never floats / REAL — drift); a `Money{amount,currency}`
  wrapper; convert to base **once at the boundary** (`to_base`), sum-per-currency → convert → total,
  round-half-even at display only.
- **Dates = `Temporal.PlainDate`** (civil dates, no timezones), stored TEXT `YYYY-MM-DD`; `sequence`
  integer kept separate. Avoid JS `Date` (TZ footguns). `temporal-polyfill` until Safari/mobile catch up.
- **Migrations:** drizzle-kit, forward-only, keyed to `PRAGMA user_version`, transactional,
  backup-before-migrate, tested against old fixtures.
- **Backup / export:** the raw SQLite file is the canonical portable backup (+ JSON full, CSV
  per-register). Data ownership = a portable file.

## Multi-user (the Circle) — schema baked in now

Per [Epic 8](user-stories/circle/README.md) and [architecture §12](product/architecture.md#12-members-circle--visibility-multi-user):
`users`, `sessions`, `account.owner_id`, `account_members(account_id, user_id)`, `entered_by` on
transactions, a canonical `payees(name_normalized UNIQUE)` registry, the shared `account_payee`
projection, and per-user `user_payee`. **No `circle` entity** — one Circle per instance *is* the
instance (its display name is an instance-wide SET1 setting). Visibility = `owned ∪ member-of`, enforced
server-side; aggregates are viewer-scoped. Auth = admin-gated, server-side sessions, Argon2id (D8 / H1).

## Risks carried forward (honest)

- Supporting **both** desktop and hosted modes = the UI treats the engine as an async service (in-process
  or remote) — a generalization, not a redesign, but real work.
- **Hand-rolled** register grid + auth = we own those bugs; mitigated by small surfaces + property/E2E
  tests.
- **Code-signing** (Win/mac) is a bounded later cost → ship Linux/Docker + web first.
- **Encryption-at-rest** is deferred (v1.x; better-sqlite3-multiple-ciphers + OS-keychain key); MVP
  relies on OS disk + the server boundary — acceptable for self-hosted private use.

## Relationship to the conceptual spec

This doc never overrides [`product/architecture.md`](product/architecture.md) on *what the data means* —
it records *what we build it with*. Where they touch (the §11 deployment note, the §5 contract the engine
implements, the §12 multi-user schema), this doc defers to the conceptual rules and only adds the
technical "how".
