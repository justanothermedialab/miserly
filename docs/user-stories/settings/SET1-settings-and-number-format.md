# SET1 — Settings & the app-wide number-format preference

> **Epic:** Settings & preferences · **Story:** SET1 · **Status:** LOCKED (2026-06-21)
> **MVP scope:** CRUD + manual valuation only, zero intelligence.

---

## Title
As the user, I can choose my **number system** (Indian lakh/crore *or* Western thousands/millions)
once in **Settings**, and every figure across the entire app — hero, registers, charts, everywhere —
respects it, shown in full precision where I'm reading the ledger and compactly where space is tight.
Settings is also where my **currencies & rates** (MC3) and other app preferences live.

## ELI5
I think in lakhs and crores, not millions. So I pick "Indian" once, and the whole app writes
₹12,34,567 (and ₹12.3L when it's squeezed into a chart) instead of ₹1,234,567 / ₹1.2M. Someone who
prefers the Western style picks that instead. It's one switch that changes how *all* numbers look,
everywhere — and Settings is the little home for that switch plus my exchange rates and other knobs.

## Business context
This story discharges a **cross-cutting rule locked during D1**: number formatting is **app-wide and
multi-format, a user preference applied across the ENTIRE app** (plan, "Cross-cutting rules"). The
persona is INR-first and thinks natively in **lakh/crore**; an app that shows "₹1.2M" for ₹12 lakh
reads as foreign and untrustworthy. But the product is also for people comfortable with Western
grouping, so the *system* is a preference, not a hardcode.

The mechanism is a solved problem we adopt rather than invent: `Intl.NumberFormat` renders the **Indian
2-2-3 grouping** for `en-IN` (1,23,456.789) and standard **3-digit grouping** for `en-US`
(123,456.789); CLDR **compact** notation yields **K / L / Cr** (Indian) and **K / M / B** (Western)
([MDN Intl.NumberFormat](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/NumberFormat),
[Indian numbering system](https://en.wikipedia.org/wiki/Indian_numbering_system),
[CLDR compact, hi-Latn: 1K/1L/1Cr](https://www.unicode.org/cldr/charts/49/verify/numbers/hi_Latn.html)).
Abbreviation conventions confirmed: "₹5L", "₹15Cr" (Indian) vs "₹1.2M" (Western)
([Crore](https://en.wikipedia.org/wiki/Crore), [Lakh](https://en.wikipedia.org/wiki/Lakh)).

Key design refinement from the plan: **long-form vs compact is context-driven, not a second user
toggle.** The user picks the **system** (Indian/Western); the app then uses **full long-form for
precise ledger figures** (registers, transaction amounts, account balances — where exactness matters,
incl. paise) and **compact short-form where space is tight** (chart axes, hero secondary line, dense
summaries). One preference, applied intelligently per surface.

This story also defines **Settings** as the **container** that hosts: the number-format preference, the
**Currencies & rates** section (specified in MC3), the existing dark-mode toggle, and — as a deferred
slot — base-currency change (MC1 locked base = INR fixed for MVP).

## User workflow

### Happy path — pick a number system
1. The user opens **Settings → Display** (or Preferences) and sees **Number format**: *Indian
   (lakh/crore)* vs *Western (thousand/million)*, with a live preview of each (e.g. "₹12,34,567 ·
   ₹12.3L" vs "₹1,234,567 · ₹1.2M").
2. They choose **Indian**. Immediately, **every** figure app-wide re-renders: the dashboard hero,
   registers, account headers, allocation/trend charts, recent activity — all in Indian grouping.
3. Reading a register, amounts show **full long-form** (₹1,23,456.78 incl. paise); glancing at a chart
   axis or the hero's secondary line, the same values show **compact** (₹1.2L, ₹1.2Cr).

### Happy path — Western user
- Picks **Western**; the same values render ₹1,23,456 → **₹123,456** long / **₹123.5K**, **₹1.2M**,
  **₹1.2B** compact, everywhere.

### Alt path — currencies & rates (MC3) and other settings
- Within Settings, the user opens **Currencies & rates** (MC3) to set/edit exchange rates and see
  "updated N days ago"; toggles **dark mode**; finds the (disabled/"coming later") base-currency note.

### Recovery path — change my mind
- Switching the system back re-renders everything instantly; nothing about the stored data changes (it's
  a pure display preference) — no migration, no risk.

## Acceptance criteria
- [ ] **Settings** exists as a dedicated area hosting app preferences, including **Number format**,
      **Currencies & rates** (MC3), and **dark mode**.
- [ ] The **number system** is a single preference with two options — **Indian (lakh/crore, 2-2-3
      grouping)** and **Western (thousands/millions, 3-digit grouping)** — each shown with a **live
      preview**.
- [ ] Selecting a system applies it **across the entire app** (hero, registers, account headers, charts,
      recent activity, tooltips — every money figure) with **no exceptions/holdouts**.
- [ ] **Long-form vs compact short-form is a user-controlled preference** (manual), not purely
      automatic: the user chooses their default display form; **compact** = Indian K/L/Cr · Western
      K/M/B, **long-form** = full grouping + full decimal precision. **Ledger-exactness guard:**
      precise ledger figures (register rows, transaction amounts, account balances) **always** retain
      full precision incl. paise regardless of the compact preference — the manual long/compact choice
      governs the **glanceable/space-constrained surfaces** (hero, charts, summaries).
- [ ] The number-system preference is **display-only** — it never alters stored amounts, balances, or
      computations; switching it requires **no data migration** and is instantly reversible.
- [ ] Formatting is implemented via **one shared formatter** (locale-driven, e.g.
      `Intl.NumberFormat`), so behaviour is consistent and no surface formats numbers ad-hoc.
- [ ] The currency symbol/ISO code rules (MC3: native-primary, base-secondary, code to disambiguate)
      compose with the chosen number system.
- [ ] **Foreign-currency grouping is a changeable preference** — by default a foreign amount groups by
      the user's chosen number system; the user can switch it to each currency's **native-locale
      grouping** instead.
- [ ] The default number system on first run is **Indian when the base currency is INR**; otherwise
      it is **derived from the device locale** (e.g. `en-IN` → Indian, otherwise Western). It remains
      user-changeable. (Amended 2026-10-02 — see Resolved decisions 2.)

## Validation rules
- **System options:** exactly the two presets (Indian / Western) in MVP; no custom separators/grouping
  builder (over-engineering — deferred).
- **Precision:** long-form shows the currency's standard fraction digits (₹ → 2 dp / paise); compact
  rounds to ~1 significant fraction digit (₹12.3L) with a tooltip/long-form available on hover where
  feasible.
- **Long/compact = user-controlled** (manual preference) for glanceable/space-constrained surfaces
  (hero, charts, summaries); **ledger/registers/detail are always long-form with full precision**
  regardless (ledger-exactness guard — non-negotiable for the per-paisa persona). Where a
  space-constrained label physically cannot fit the chosen form (e.g. a crowded chart axis), the
  formatter may fall back to compact for that label only.
- **Foreign-currency grouping = changeable preference:** default = the user's chosen number system
  applied to all currencies; alternative = each currency's native-locale grouping. A single global
  preference (not per-figure) in MVP.
- **Default system on first run = Indian when the base currency is INR**, else derived from device
  locale (`en-IN`/South-Asian locales → Indian; otherwise Western); always user-changeable thereafter.
- **Display-only:** the number-system, compact, and foreign-grouping preferences touch **no** stored
  value, rate, or derived computation — purely the render layer.
- **Composability:** number system composes with MC1/MC3 currency conversion and with the
  native/base display convention; it governs *grouping & compaction*, not *which currency*.

## Edge cases
- **Negative amounts** (liabilities, losses): grouping/compaction applies identically; sign shown
  honestly (−₹12.3L / −₹1.2M) per the balance-sheet conventions (D1/D2).
- **Very large net worth** (₹10Cr+ / billions): compact stays readable (₹12.3Cr / ₹1.2B); long-form
  still exact in the ledger.
- **Sub-rupee / paise precision** (the per-paisa persona, ₹1.71): long-form preserves paise; compact
  for tiny values just shows the value (no "0.0L" nonsense — small numbers render plainly).
- **Mixed currencies on screen** (MC3): each figure carries its **own currency** symbol/code; grouping
  follows the **foreign-grouping preference** — by default the user's number system (so a USD figure
  reads `$12,34,567` under Indian), or each currency's native locale if the user switched that
  preference (so USD reads `$12,345,678`).
- **Chart axis with few pixels:** compact with minimal fraction digits; avoid overlapping labels.
- **First run / no preference set yet:** default applies (see Resolved decisions).

## Failure cases
- **A surface that ignores the preference** (hardcoded `toLocaleString('en-US')` somewhere): defect —
  one shared formatter, zero holdouts.
- **The preference changing a stored/derived value** (e.g. rounding a balance that then feeds math):
  defect — display-only; computations use full precision regardless of display.
- **Compact used where exactness is required** (a register row showing ₹1.2L instead of ₹1,23,456.78):
  defect — ledger is always long-form.
- **Inconsistent grouping across screens** for the same preference (hero Indian, chart Western): defect —
  single formatter, single preference.
- **Loss of paise** in long-form for the per-paisa user: defect — ledger precision is sacrosanct.

## UX considerations
- **Pick once, applies everywhere** — the switch is a small, low-stakes display choice with an instant,
  obvious effect (live preview removes guesswork).
- **Indian-first framing** — the default and the preview lead with lakh/crore for the core persona;
  Western is an equal, available choice (no second-class treatment).
- **Long where it counts, compact where it's tight** — never make the user choose this per-screen; the
  app is smart about it. The ledger always reads exactly; dashboards stay glanceable.
- **Settings is calm and minimal** — Display (number format, dark mode), Currencies & rates (MC3), and a
  clearly-"later" base-currency note; no sprawling options (MVP restraint).
- **Reversible & safe** — switching never warns or migrates; it's just how numbers look.

## Operational considerations
- **One formatting utility** (locale-driven via `Intl.NumberFormat`: `en-IN` vs `en-US` grouping; CLDR
  `notation: "compact"` for short-form) is the **single** path every component calls — the structural
  guarantee against ad-hoc formatting drift (continues the shared-service discipline of C1–C4 / MC).
- **Preference stored** as a small app/user setting (e.g. `numberSystem: "indian" | "western"`); read
  by the formatter; no impact on the data model.
- **Preferences stored:** `numberSystem: "indian" | "western"` (default Indian for an INR base, else locale-derived),
  `compact: boolean` (user-controlled long/compact for glanceable surfaces),
  `foreignGrouping: "preference" | "native-locale"`. The formatter takes `(amount, currency, surface)`;
  the **ledger-exactness guard** forces long-form for ledger surfaces regardless of `compact`.
- **Composes with MC1/MC3**: the formatter handles grouping/compaction + decimals; currency symbol/code
  and native-vs-base selection are MC3's concern layered on top.
- **Settings container**: hosts SET1 (number format), MC3's Currencies & rates, dark mode; a disabled
  base-currency-change slot reserved for post-MVP (MC1).
- **Per-user display preference**, like theme; offline in desktop mode (hosted = client↔server, §11).

## Resolved decisions (locked 2026-06-21)
1. **Long/compact = MANUAL, user-controlled** (LOCKED): the user explicitly chooses their display form
   (a `compact` preference) rather than it being purely context-automatic. **Hard guard:** precise
   ledger figures (registers, transaction amounts, account balances) **always** render long-form with
   full precision incl. paise — the manual compact preference applies to glanceable/space-constrained
   surfaces (hero, charts, summaries). A crowded label that physically can't fit may fall back to
   compact for that label only.
2. **Default number system = INDIAN WHEN THE BASE CURRENCY IS INR, else DEVICE LOCALE** (LOCKED;
   amended 2026-10-02): on first run (no stored preference), an instance whose base currency is INR
   defaults to Indian (lakh/crore); otherwise South-Asian locales (`en-IN` etc.) → Indian, everything
   else → Western. Always user-changeable afterward.
   *Amendment rationale (a release audit, 2026-10-02):* most Indian Windows
   desktops report `en-US`, so the pure locale rule gave the INR-first persona Western grouping on
   every first run. The base currency is a stronger signal of the user's number culture than the OS
   locale. *(Originally: "Derived from device locale … not a hardcoded Indian default.")*
3. **Foreign-currency grouping = MANUAL, CHANGEABLE** (LOCKED): a user preference (`foreignGrouping`) —
   default applies the user's number system to all currencies (a USD figure reads `$12,34,567` under
   Indian); the user can switch to each currency's **native-locale grouping** instead
   (`$12,345,678`). A single global preference in MVP (not per-figure).
4. **SET1 is the Settings CONTAINER** (LOCKED): it hosts the number-format/compact/foreign-grouping
   preferences, MC3's **Currencies & rates** section, the **dark-mode** toggle, and a reserved
   (disabled, "coming later") **base-currency change** slot (MC1 = base fixed INR in MVP).
   *Reworded (2026-11-18):* the slot is now two read-only rows at the top of
   Currencies: "Currency for totals" (the base chosen at setup) and "Year starts in" (January or
   April, with the year it gives reports), each with "Changing it comes in a later version". The
   "Short amounts" example and the number-format previews show the base's sign.

**Amendments (2026-10-05, each chosen from options with their evidence):**

5. **Compact is the default on summaries** (amends RD1, whose hard guard stands). Headlines, the
   sidebar, tiles and chart ticks show the compact form ("₹18.8L") by default, with the full
   Indian-grouped figure under or beside a headline. Registers, tables, transaction amounts and forms
   always show the full figure with paise. The compact preference stays, now meaning "summaries
   compact" (default on) or "summaries full". *Why:* 236 of 236 lakh figures printed paise;
   INDmoney pairs "₹58.89L" with the full figure, Kite uses "1L".
6. **Accent colour = a per-user display preference** (DECIDED 2026-10-20, see the last amendment) (2026-10-17;
   built as a trial to try first): Settings › Display › Accent colour offers a curated set, **Ink (default)**, Gold, Teal,
   Indigo, Plum, each solved for ~5:1 in both themes. It colours buttons,
   selection marks and links only; money, warnings and charts never read it, and the brand mark stays
   gold whatever the accent. Stored in `user_preferences.accent` (migration 0009), stamped on `<html>`
   in the first byte like the theme (a `miserly_accent` cookie for the signed-out screens), instant like
   the theme. *Precedent:* Windows' accent colour, Todoist's themes, Actual's custom themes.
   **Amended 2026-10-17 (the setting kept, the set chosen after
   research):** Ink (default), Gold, **Windows accent** (the colour the
   person picked in Windows; desktop only, read by the shell and passed in a `miserly_win_accent`
   cookie so the first byte carries it; hidden in a browser), **Blue** (Fluent's `#0f6cbd`) and
   **Purple** (`#8a3ffc`). Teal, Indigo and Plum are retired (stored values map to Blue and Purple on
   read; no migration). Every accent comes from one solver (`$lib/accent`): the seed's hue and chroma
   kept, lightness moved only until a white label reads at >= 4.5:1 and accent text at >= 5.3:1 on
   both grounds (property-tested). *Why:* blue is the most liked colour everywhere surveyed; dark
   yellow, which a contrast-safe gold becomes, is the least liked (Palmer and Schloss 2010); saturated
   colours beat muted ones.
   **Decided 2026-10-20:** the setting stays and the set is **Ink (default), Gold,
   Windows accent, Teal, Coral**. Blue went (too close to the Windows accent, which on most machines
   is blue) and so did Purple ("no purple of any sort"). **Teal** is Fluent's `#038387`, solved as
   above. **Coral** is Monzo's `#ff4f40`, 1 % darker (`#fc4e3f`) so it reads at 3:1 on the Light
   ground. It is not solved: a white label fails on coral, and the solver's darkened fill is the red
   of Delete, so Coral carries a **near-black label** (`#141414`, 5.5:1) as Monzo's coral does, and
   in Light accent text (links, focus ring) uses Ink's near-black, since a coral dark enough to be
   text is the outflow red. Dark text is coral itself (5.4:1). Stored blue and indigo map to Teal,
   purple and plum to Coral, on read; no migration. *Sources:* Monzo's coral with navy text; WCAG
   1.4.3 / 1.4.11; guidance that a primary button must not share the destructive red (UX Movement).
   **Amended the same day:** Coral read red on a real screen; after a wider search (Radix,
   Apple, Fluent, finance brands, the options mocked) the choice was
   **Lime** (Radix `#bdee63`, Wise's family) in Coral's place. Kept bright with a near-black label
   (13.7:1); in Light its text and thin marks (`--accent-mark`: the selected nav bar, tab and
   editing underlines) use the dark lime `#506e00` (5.4:1), since the bright fill is a 1.3:1 line
   there. Stored coral maps to Lime.
7. **Black, a fourth theme** (2026-10-20: "it should be its own thing like light and dark").
   Theme offers System, Light, Dark and Black. Black is Dark on a true-black ground for
   OLED screens: surfaces step up in small shades and borders carry the edges, since shadows don't
   read on black; every Dark rule (text, money colours, accents) applies unchanged. Stored as
   `theme = 'black'` (a text column, no migration), stamped on `<html data-theme="black">` like the
   others. System never picks Black: it follows the OS's light or dark only. *Precedent:* Spark's
   True black, Bitwarden's Black theme.
8. **Compact amounts round before they pick a unit** (2026-11-06,
   after a review of the app). In whole paise, half away from zero, then the unit:
   a figure that rounds up to the next unit reads in it. ₹99,96,000 reads ₹1Cr (was ₹100L),
   ₹99,960 ₹1L (was ₹100K), ₹999.60 ₹1K (was ₹1000), ₹1,45,000 ₹1.5L like ₹2,45,000 ₹2.5L (binary
   rounding gave ₹1.4L), and −₹0.40 ₹0 (was −₹0). Western the same with K, M and B.

## Circle addendum (Epic 8 · multi-user)

> Added 2026-06-25 by the [Circle epic](../circle/README.md) writeback (D6). Settings split into
> **instance-wide** vs **per-user**.

- **Instance-wide (shared; FX/base managed by admin):** the **Circle display name** (H1; replaces any
  notion of a `household` entity), **base currency** (INR, fixed in MVP) and **currency rates** (MC1/MC3
  — shared financial data so net worth has a consistent base for everyone), and the shared **category
  taxonomy** (F2).
- **Per-user (personal display preferences):** the **number-format preference** becomes **per-user** —
  each member picks Indian (lakh/crore) vs Western (K/M/B), long/compact — since it's a personal display
  choice, not shared data. (Refines the originally "app-wide" rule: the *formatter* is still one shared
  service; the *selected option* is now read per-viewer.) Also per-user: **theme (System, Light, Dark,
  Black; RD7)**, the **accent (RD6)** and the
  per-user last-category memory (F2/F3).
- **Members administration** lives in Settings as an **admin-only** section (add/remove members, reset
  passwords — [H1](../circle/H1-circle-setup-and-auth.md)/[H3](../circle/H3-roles-and-membership.md));
  members see their own account/password settings only.
- **AC delta:** number format + theme are stored per-user; base currency, rates, Circle name, and the
  category taxonomy are instance-wide; Members management is gated to admin.

## Dependencies
- **Depends on:** D1 (where the app-wide number-format rule was locked), the aggregation/display layers
  that render money (D1–D4, registers C1–C4), MC3 (Currencies & rates section it hosts).
- **Feeds:** **every** money-rendering surface across the app (one formatter); the charts/reports epic
  (axes/labels use the compact form); MC3 (composes currency display with grouping).
- **Relates to:** MC1 (base-currency-change is a deferred Settings slot), dark-mode (existing app
  preference now homed in Settings).
- **Excludes:** custom/arbitrary separator & grouping builder (over-engineering); per-screen manual
  long/compact control (context-driven instead); locale-based language/date formatting beyond numbers
  (later); base-currency change (post-MVP, MC1).

---

### Research sources
- MDN `Intl.NumberFormat` — locale-driven grouping (`en-IN` → 1,23,456.789 vs `en-US` → 123,456.789)
  and `notation: "compact"` for short-form:
  https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/NumberFormat ;
  https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Number/toLocaleString
- Indian numbering system — 2-2-3 grouping; lakh = 10^5 (1,00,000), crore = 10^7 (1,00,00,000):
  https://en.wikipedia.org/wiki/Indian_numbering_system ; https://en.wikipedia.org/wiki/Lakh ;
  https://en.wikipedia.org/wiki/Crore
- CLDR compact short forms — Indian 1K / 1L / 1Cr (vs Western 1K / 1M / 1B); financial abbreviations
  "₹5L", "₹15Cr": https://www.unicode.org/cldr/charts/49/verify/numbers/hi_Latn.html
