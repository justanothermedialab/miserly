# Key workflows

> Workflow tier. End-to-end journeys that cut across epics — the "make-or-break" loops the product
> lives or dies by. Each step links to the story that specifies it. These are narratives, not specs;
> the acceptance criteria live in the stories.

## W1 — The daily capture loop (the make-or-break)

The whole product hinges on this being faster and nicer than Actual.

1. The user is in an account register, or hits the global quick-add from anywhere
   ([C1](../user-stories/capture/C1-quick-add-in-register.md) / [C2](../user-stories/capture/C2-global-quick-add.md)).
2. A blank row opens with **date = today**; they type **payee** (autocomplete, creates on the fly —
   [F3](../user-stories/foundations/F3-payees.md)), an **optional category** (pre-fills from the payee
   if blank — [F2](../user-stories/foundations/F2-categories-and-groups.md)/F3), and an explicit
   **inflow or outflow** amount.
3. **Enter** commits and opens the next blank row (the power loop); **Ctrl/Cmd+Enter** commits one.
   The **running balance** is correct after every row, including back-dated inserts
   ([C1](../user-stories/capture/C1-quick-add-in-register.md) §`(date, sequence)`).
4. No category? It persists as **uncategorized** and surfaces in the **To-categorize inbox**
   ([C5](../user-stories/capture/C5-to-categorize-inbox.md)) — logging never blocks on categorization.

## W2 — Catch-up after a capture gap

The user logs in bursts (weekly, or after travel), back-filling from bank SMS/statements.

1. Rapid sequential entry via the Enter-loop ([C1](../user-stories/capture/C1-quick-add-in-register.md)),
   often back-dated; balances and history recompute correctly
   ([C4](../user-stories/capture/C4-edit-delete-backdate.md), [D3](../user-stories/dashboard/D3-net-worth-over-time.md)).
2. The **inbox** ([C5](../user-stories/capture/C5-to-categorize-inbox.md)) groups by payee so lookalikes
   bulk-select; **bulk categorize** ([C4](../user-stories/capture/C4-edit-delete-backdate.md)) clears
   the backlog in a couple of actions → "all caught up".

## W3 — Moving money between accounts

1. **Same currency:** inline (payee = "Transfer → <account>") or an explicit From→To form →
   two linked rows, excluded from spending, net worth unchanged
   ([C3](../user-stories/capture/C3-transfer-between-accounts.md)).
2. **Cross-currency** (e.g. repatriating USD → INR): the dialog reveals an FX row; the user enters
   amount-out plus **either the rate or the received amount** (the other computes); two native legs are
   stored with the frozen **linkage rate** ([MC2](../user-stories/multi-currency/MC2-cross-currency-transfer.md)).

## W4 — Tracking an investment (contribute → grow → see return)

1. Contribute by **transferring** cash into a holding account → cost basis and value both rise
   ([S2](../user-stories/instruments/S2-holding-account-model.md), [C3](../user-stories/capture/C3-transfer-between-accounts.md)).
2. When the market moves, **update the value** ("now worth ₹X") → a mark posts the gap; value and
   return rise, cost basis unchanged ([S3](../user-stories/instruments/S3-valuation-mark.md)).
3. The holding shows **value / invested / return (₹ & %)**
   ([S2](../user-stories/instruments/S2-holding-account-model.md)); it flows into net worth, allocation,
   and growth via the contract ([D1](../user-stories/dashboard/D1-net-worth-command-center.md)–D3).

## W5 — Onboarding an existing portfolio

1. For each account, pick its **module** from the full instrument list (the discovery showcase —
   [S1](../user-stories/instruments/S1-section-ia-and-navigation.md)) and create it with an **opening
   balance as-of a date** ([F1](../user-stories/foundations/F1-account-lifecycle.md)).
2. For a holding, enter **amount invested + current value** so returns are correct from day one (the
   gap recorded as an initial mark — [S2](../user-stories/instruments/S2-holding-account-model.md)).
3. Foreign-currency accounts get **one current rate** per currency so they fold into the INR net worth
   ([MC1](../user-stories/multi-currency/MC1-account-currency-and-base-rate.md)).

## W6 — The "how am I doing?" check (the wealth view)

1. Open the app → the **net-worth hero** (as-of-today, assets vs liabilities, base INR)
   ([D1](../user-stories/dashboard/D1-net-worth-command-center.md)).
2. **Allocation** by asset class / liquidity, **growth** over time + "change since last month", and
   **recent activity + account summary** below
   ([D2](../user-stories/dashboard/D2-allocation-breakdown.md)–[D4](../user-stories/dashboard/D4-recent-activity-and-account-summary.md)).
3. Drill from any account card into its **section/register**
   ([S1](../user-stories/instruments/S1-section-ia-and-navigation.md), [D4](../user-stories/dashboard/D4-recent-activity-and-account-summary.md)).
   No logging happens here — the dashboard is the *wealth view*, not the *work view*.

## W7 — Reviewing where the money went (the reports view)

1. Open **Reports**, pick a period once — presets incl. **This FY (Apr–Mar)** / FY-to-date — that
   drives every report ([R1](../user-stories/reports/R1-reports-shell-and-date-range.md)).
2. **Spending by category** (donut, drill group → category → transactions —
   [R2](../user-stories/reports/R2-spending-by-category.md)) and **income vs expense + net cashflow**
   per month ([R3](../user-stories/reports/R3-income-vs-expense-and-cashflow.md)). Both share one
   spending predicate, so their totals reconcile; both exclude transfers and Neutral.
