# Miserly — Documentation

Miserly is an **expense-tracking + net-worth-tracking** app for the self-directed, mass-affluent
DIY user, built first for India (the base currency is chosen at setup, INR by default;
multi-currency supported). It is **not** an envelope-budgeting
tool. Think *Actual Budget's keyboard-first ledger ∪ Ghostfolio-grade holdings ∪ India-native
instruments* — a niche nobody occupies.

This folder is the **product specification**: the durable, versioned source of truth for *what we are
building and why*. It is written before the greenfield rebuild and is the reference the code is held
against.

The stories were drafted and researched with an AI model. Every decision in them is ours,
and each amendment made after a story was locked carries its date. Where a note reads "after a
review of the app" or "after a security read", the working notes behind it stayed private.

## How these docs are organized

The specification follows a five-tier chain — **domain → workflows → epic → feature → story** — laid
out physically as:

| Tier | Where | What it answers |
|---|---|---|
| **Domain** | [`product/overview.md`](product/overview.md) | Who is this for, what is the product, what's in the MVP |
| **Architecture (conceptual)** | [`product/architecture.md`](product/architecture.md) | The cross-cutting backbone every story leans on — *what's true of the data* |
| **Workflows** | [`product/workflows.md`](product/workflows.md) | Key end-to-end journeys that cut across epics |
| **Epic → Feature** | [`user-stories/<epic>/README.md`](user-stories/) | An epic's goal, scope, and the features that compose it |
| **Story** | [`user-stories/<epic>/<story>.md`](user-stories/) | A single buildable unit, fully specified |
| **Tech stack (engineering)** | [`tech-stack.md`](tech-stack.md) | *What we build it with and how it's deployed* — the locked MODE 2 stack (D1–D10) |

Start at the [**user-stories index**](user-stories/README.md) for the complete epic → feature → story map.

## Status at a glance

- **Active MVP program: 8 epics · 29 stories — all LOCKED.** See the [index](user-stories/README.md).
- **Stack locked (MODE 2):** TypeScript · SvelteKit (server-centric) · SQLite/better-sqlite3 + Drizzle ·
  Svelte 5 + Tailwind · Electron + Docker · multi-user Circle. See [`tech-stack.md`](tech-stack.md).
- **MVP scope:** CRUD + descriptive charts only — **zero intelligence**. Manual valuation via marks.
- **Permanently deferred** (until explicitly re-activated): onboarding and the intelligence/AI
  layer. Import from Actual Budget is no longer deferred (F4). Plus a list of noted post-MVP items — see [`product/overview.md`](product/overview.md#deferred).

## Reading order for someone new

1. [`product/overview.md`](product/overview.md) — the "what and why" in ten minutes.
2. [`product/architecture.md`](product/architecture.md) — the handful of ideas that make every story
   consistent (the aggregation contract, double-entry, valuation marks, `to_base`, as-of-today).
3. [`user-stories/README.md`](user-stories/README.md) — then dive into whichever epic you're building.
4. [`tech-stack.md`](tech-stack.md) — *if you're about to write code:* the locked stack + deployment model.
