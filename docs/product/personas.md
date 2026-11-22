# Personas

> Domain tier, next to [`overview.md`](overview.md). Written 2026-10-11;
> the three members checked against published research the same day. **P1 is researched** (June,
> and our own daily use of Actual). **P2 to P4 were extrapolated from P1, then checked:** each says
> what the evidence supports, what it changed, and what is still a guess. Sources are at the end.

Used to judge whether a screen is intuitive: every change is read as the primary user, then as each
member. A member is never an admin (H3: the admin manages people, never data).

## P1. The completionist (primary user, the group's admin)

- **Who:** an Indian software engineer or data scientist, mid-career, self-directed and mass
  affluent. Holds bank accounts, cards, mutual funds through SIPs, stocks, FDs, PPF and EPF, a home or
  car loan, gold, often US stock or RSUs in a USD account. Thinks in lakh and crore. Runs the group's
  instance (desktop or self-hosted).
- **How they use it:** logs every rupee by hand, down to a ₹1.71 SMS charge, with the mouse and
  typing (no shortcut keys); edits in place by clicking a field. Reads the monthly spending table and
  net worth as trackers. Types each investment's current value now and then (2026-10-11). Adds
  FD and PPF interest as income by hand rather than trusting a computed figure.
- **What they need:** Actual-grade speed in the register; every figure clickable to its rows; charts
  a data analyst respects; investments' invested amount, current value and return; an app that looks
  and feels finished (the reason not to stay on Actual).
- **What loses them:** one extra click per row; a figure they can't trace to transactions; anything
  that reads or links their bank data; a look that feels like a settings panel.

## P2. The partner (member)

- **Who:** P1's spouse or partner, with a salary account and a card of their own; shares a joint
  account and often the home loan. Comfortable with phone banking and UPI, not with spreadsheets.
- **What the evidence says:**
  - **Many decide on their own now.** DSP's Winvestor Pulse 2025-26 (5,050 urban investors, 13
    cities): 56 % of women take investment decisions independently (44 % in 2022; men 68 %), and
    women are more likely than men to consult their spouse. In its coverage, men more often lead on
    insurance, property, home loans and mutual funds or equity; women on household purchases, gold
    and school choices. So P2 is not a passive viewer: they own a part of the household's money.
  - **Couples who share decisions hold more financial products** (NSE-NYU Stern, on India's 2015
    financial literacy survey of about 60,000 households), which is the case for a shared view.
  - **Private money inside a marriage is common.** A 2015 Times of India survey: 56 % had spent money
    without telling their spouse; 39 % thought it fine to lie about money in a marriage. Private by
    default (H2) is what lets P2 join at all.
- **How they'd use it:** a few times a week: adds household purchases, school fees, gold, medical
  bills to the joint account or their own; checks "how much have we spent this month"; looks at the
  Shared net worth now and then.
- **What they need:** an obvious Add with Expense, Income and Transfer in words; categories picked by
  name; plain labels (no "XIRR", "cost basis", "mark"); undo after a mistake; their private accounts
  private from P1 too, and a clear sign of which view they're in (their own or Shared).
- **What loses them:** learning keys; a screen that assumes the ledger model; an error they can't
  undo; a figure they don't recognise without a way to see what it's made of.
- **Still a guess:** where they'd use it. They are phone-first, and Miserly is desktop-first (the
  hosted build in a phone browser is not designed for). Deferred.

## P3. The parent (member, mostly through P1)

- **Who:** P1's retired parent: pension account, several FDs, often a Senior Citizens' Savings Scheme
  or post office deposit; little or no market investment.
- **What the evidence says, and what it changed:**
  - **Most won't sit at a computer.** HelpAge India 2025 (5,798 people in 10 cities, 30 % aged 60+):
    71 % of the elderly use basic phones, 40 % own a smartphone, 13 % use computers, social media or
    the internet; 66 % find digital tools "too confusing"; 51 % avoid them for fear of making errors.
    **So P3 rarely signs in. P1 (or a sibling) types for them and shows them the screen.** The
    persona was first written as a reader; it is now a reader through someone else.
  - **Their children are their help desk.** The same survey: 54 % of children and 52 % of
    grandchildren help elders learn digital tools, and elders say the young lack patience (71 %) and
    explain too quickly (49 %).
  - **FDs are the preferred saving** for retirees in the surveys and the press; SCSS paid 8.2 %
    against about 7–7.5 % on big banks' 5-year senior FDs in 2026 commentary (promotional source).
  - **Reading:** older adults prefer larger text, up to a point where readability falls again; one
    study recommends at least 14 pt; finance apps fail them on small text, information overload and
    navigation (a Swedish study of users aged 71 to 82); going to the wrong page through complicated
    buttons is the commonest failure (a Thai banking study).
- **How they'd use it:** P1 keeps the parent's accounts (owned by the parent and shared with P1, or
  owned by P1 for them; `entered_by` records who typed each row). When P3 looks, it's at P1's screen
  or a printout: what each deposit is worth and when it matures, and whether the pension came in.
- **What they need:** large, readable figures (zoom: Ctrl+= and Ctrl+-); one screen listing their
  deposits with amounts and dates; nothing to configure; for P1, a quick way to show "your money"
  on its own.
- **What loses them:** small grey text; a page full of charts; any step that could go wrong.
- **Note:** FD maturity amounts and dates are the deferred "computed values" (values worked out from
  the rate and dates typed). Without them P3's deposits show only what was typed: principal, and interest when someone adds it.

## P4. The flatmate or co-investor (member)

- **Who:** a friend or sibling who shares one thing with P1: the rent and utilities in a shared flat,
  or a co-owned plot or fund. Tech-literate, privacy-minded, keeps their own tools for everything else.
- **What the evidence says:** thin. Shared flats are common among young professionals in the metros
  (Knight Frank's 2018 survey: over 55 % of 18 to 35 year-olds in five metros willing to rent
  co-living; a Deccan Herald report of young people choosing shared flats over PGs in Bengaluru), and
  the tool they use for shared bills is Splitwise, which settles through Paytm in India. No Indian
  survey of how flatmates track shared money was found.
- **What it changed:** P4's yardstick is Splitwise, not Actual: who paid what and who owes whom. The
  group's cross-member transfers (H4) cover settling up; Splitwise-style IOUs are a noted post-MVP
  idea (H4 C, `overview.md`).
- **How they'd use it:** logs their share of bills into the one shared account; checks its balance
  and who paid what. Never sees P1's net worth (H2: no all-group total).
- **What they need:** to see only what's shared with them, and to be sure of it; a clear "entered by"
  on each row; transfers to and from P1 that land on both sides (H4).
- **What loses them:** any hint that P1 or the admin can see their private data; screens that only
  make sense for P1's full balance sheet.
- **Still a guess:** most of it. Treat P4 as the privacy test, not a usage model.

## What the personas change

- **Copy and labels** are judged by P2 and P3, not P1: plain words, sentence case, no finance jargon
  where a word exists ("Annual return", not "XIRR"; "Update value", not "mark").
- **Speed** is judged by P1: the register and Add, by mouse and typing.
- **Undo and forgiving errors** are judged by P2 and by P1 working for P3: half the elderly avoid
  digital tools for fear of mistakes.
- **Privacy** is judged by P2 (private money within a couple) and P4 (one shared account): every
  viewer-scoped read through `accountsVisibleTo` (P0).
- **Where members use it** (phone browsers) is open, deferred with P3's FD
  maturity dates.

## Sources

- DSP Winvestor Pulse 2025-26 ([DSP press release](https://www.dspim.com/news-and-press-releases/dsp-winvestor-pulse-2025-26-women-take-charge-of-investing-as-confidence-rises-faster-than-planning);
  decision areas from [Outlook Money's coverage](https://www.outlookmoney.com/amp/story/personal-finance/international-womens-day-2026-women-are-taking-greater-control-of-investments-but-gender-gap-persists));
  the 2019 edition for comparison ([DSP](https://www.dspim.com/news-and-press-releases/dsp-winvestor-pulse-2019)).
- Shared decisions and holdings: [NSE-NYU Stern white papers 2020](https://www.stern.nyu.edu/sites/default/files/assets/documents/NSE-NYU%20Stern%20Initiative%202020%20White%20Papers.pdf).
- Money secrets in marriage, Times of India 2015 survey via [The Swaddle](https://www.theswaddle.com/when-financial-infidelity-shakes-up-a-marriage).
- HelpAge India 2025, via [Outlook Money](https://www.outlookmoney.com/amp/story/news/digital-divide-among-elderly-66-find-digital-tools-too-confusing).
- Seniors and FDs/SCSS: [Outlook Money on RBI deposit data](https://www.outlookmoney.com/amp/story/banking/indians-move-savings-to-fds-large-deposits-in-demand-senior-citizens-share-remains-steady-rbi-report),
  [stockcalc on SCSS vs FD](https://stockcalc.in/blog/scss-vs-fd-for-senior-citizens) (promotional).
- Older adults and app design: [font size review (PMC)](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC9376262/),
  [fintech apps for older adults (Jönköping)](https://ju.se/samarbeta/event-och-konferenser/event/xjobbsmassan/digital-showroom-2024/designing-fintech-applications-for-older-adults.html),
  [e-payment design for older adults (arXiv)](https://arxiv.org/pdf/2410.08555),
  [Thai digital banking study](https://ir-ithesis.swu.ac.th/handle/123456789/644),
  [OzCHI 2024 guidelines](https://outbox.eait.uq.edu.au/uqsville/OzCHI2024/Long%20Papers/Design%20for%20Older%20People%20-%20Improving%20the%20Usability%20of%20Mobile%20Apps%20through%20Targeted%20Design%20Recommendations.pdf).
- Shared flats: [Knight Frank co-living survey via Track2Realty](https://track2realty.track2media.com/?p=59330),
  [Deccan Herald on Bengaluru PGs](https://www.deccanherald.com/amp/story/india%2Fkarnataka%2Fbengaluru%2Fstudents-back-at-pgs-but-techie-crowd-still-a-trickle-1100892.html),
  [Splitwise on the App Store](https://apps.apple.com/app/splitwise-bill-splitter/id458023433).
