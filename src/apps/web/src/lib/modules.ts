/**
 * modules.ts — the app-side module PROFILE catalogue (S1/S5).
 * ============================================================================
 * The engine registry (`@miserly/core`) owns the aggregation-relevant metadata
 * (side / liquidity / accountClass / markable). This catalogue owns the
 * PRESENTATION + capture profile: display label, one-line description, the S1
 * nav GROUP + fixed order, the ONBOARDING shape (how F1 collects opening cash),
 * and the S5 DISPLAY-ONLY informational fields. It is the single source the nav,
 * the add-account picker, the section pages, and the create form all read — a new
 * instrument is a new entry here + a core module, no route edits.
 *
 * DISPLAY-ONLY discipline (S5): informational fields drive NO computation,
 * valuation or alert in MVP — they are captured, stored (accounts.info_json) and
 * shown, nothing more. Aggregation never reads them and never branches on `type`.
 *
 * Pure data; its one import (the date check) is client-safe too, so this is safe on both server
 * and client.
 * ============================================================================
 */
import { isRealDate } from './dates';
import { textProblem } from './text-limits';

/** Add account's groups (and the import's Add as): S1's fixed order (S1 RD4), then India. */
export const SECTION_GROUPS = [
  'Spending',
  'Deposits',
  'Loans',
  'Investments',
  'Property',
  'Other',
  // O31 (option A): Add account's last group, folded for everyone,
  // so the Indian schemes don't puzzle anyone else; the sidebar doesn't read these groups.
  'India',
] as const;
export type SectionGroup = (typeof SECTION_GROUPS)[number];

/** Groups Add account shows folded, one row that opens with a click, named by what's inside (O31). */
export const FOLDED_GROUPS: Partial<Record<SectionGroup, string>> = { India: 'PPF, EPF, SGB, NPS' };

/**
 * How F1 collects an account's opening cash position:
 *  - `balance`        — a single signed opening balance (Bank).
 *  - `cardOutstanding`— current amount owed on a card → stored as a negative opening.
 *  - `investedValue`  — amount invested + current value (asset holdings; S2 RD1).
 *  - `loanOutstanding`— current amount owed → stored as a negative opening (liabilities).
 */
export type OnboardingShape = 'balance' | 'cardOutstanding' | 'investedValue' | 'loanOutstanding';

export interface InfoField {
  readonly key: string;
  readonly label: string;
  readonly type: 'text' | 'date' | 'number' | 'select';
  /** Options for a `select` field. */
  readonly options?: readonly string[];
}

export interface ModuleProfile {
  /** Registry key (or a coming-soon placeholder's key). */
  readonly type: string;
  readonly label: string;
  readonly description: string;
  readonly group: SectionGroup;
  /** `holding` sections foreground value/invested/return; `spending` are ledgers. */
  readonly sectionShape: 'spending' | 'holding';
  readonly onboarding: OnboardingShape;
  /** Label for the opening-cash input on the create form. */
  readonly openingLabel: string;
  /** S5 display-only informational fields captured at creation. */
  readonly infoFields: readonly InfoField[];
  /** Shown in the picker as "coming soon", not creatable (S1 RD6; none since NPS). */
  readonly comingSoon?: boolean;
  /**
   * C7: months after which a holding's last known value reads as stale ("Last
   * updated" turns amber). 3 where prices move daily (funds, stocks, gold), 13 where statements
   * come yearly (FD, RD, property, other assets, loans). Absent: never stale (cash accounts).
   */
  readonly staleAfterMonths?: number;
  /**
   * C1 A: when the details say the interest is paid out (the field `when`
   * holds `equals`), the holding never sees its interest (it's typed where it lands, the bank), so
   * it shows the stated rate from the field `rate` in place of a measured return, and the section's
   * rate leaves it out. Read generically by `paidOutRate`; aggregation never checks a type.
   */
  readonly paidOut?: { readonly when: string; readonly equals: string; readonly rate: string };
  /**
   * The Add account list's entries for this type, when it shows under more than one name (S5
   * RD15: "Home loan" and "Other loan" are both the Loan module, the first presetting its Kind).
   * Absent: one entry, the label.
   */
  readonly entries?: readonly { readonly label: string; readonly preset: Readonly<Record<string, string>> }[];
  /**
   * Figures worked out from the details and the person's own rows, never an interest amount (S5
   * RD14, the data hard line's "values computed from typed inputs", labelled): a date a fixed
   * number of years after a detail's date (`afterFinancialYear`: counted from the 1 April after the
   * financial year it falls in, PPF's rule), or money put in this financial year against a limit.
   */
  readonly workedOut?: readonly WorkedOut[];
  /**
   * An account of another type made with this one and linked to it (S5 RD16: an EPF's EPS). Add
   * account asks for its opening (`openingLabel`); it is named `namePrefix` + this account's name.
   */
  readonly child?: { readonly type: string; readonly openingLabel: string; readonly namePrefix: string };
  /** This type only exists under a parent of type `childOf` (made with it, never on its own). */
  readonly childOf?: string;
  /** The section it shows in, when not its own (an EPS in its EPF's section). */
  readonly sectionOf?: string;
  /** Counted at what was paid in (EPS): no value to update, no return, left out of a section's rate. */
  readonly paidInOnly?: boolean;
  /**
   * F4 (the Actual import, choice 4 I-C): plain deposits (rows that aren't transfers) on an account
   * of this type count as money put in by default, filed under this category (found by name in a
   * group of this kind, made if missing). Absent: they count as return, as Actual left them, and
   * money put in, when chosen, files under Investments, Other.
   */
  readonly importDeposits?: { readonly name: string; readonly kind: 'income' | 'investments' };
  /**
   * The currency an account of this type is always held in, whatever the currency for totals: an
   * Indian scheme (PPF, EPF and its EPS, SGB) is in rupees, so its rupee rules (PPF's ₹1.5 lakh a
   * year) count rupees. Add account shows it fixed. Absent: the
   * person picks, opening on the base (MC1).
   */
  readonly currency?: string;
}

export type WorkedOut =
  | { readonly kind: 'date'; readonly label: string; readonly from: string; readonly years: number; readonly afterFinancialYear?: boolean }
  | { readonly kind: 'depositedThisYear'; readonly label: string; readonly limitPaise: number };

/** The v1 catalogue: the 11 modules, PPF and SGB (S5 RD13), EPF and its EPS (RD16), NPS's two
 *  tiers (RD6). No coming-soon placeholder is left. */
export const MODULE_PROFILES: readonly ModuleProfile[] = [
  {
    type: 'bank',
    label: 'Bank account',
    description: 'Savings or current account.',
    group: 'Spending',
    sectionShape: 'spending',
    onboarding: 'balance',
    openingLabel: 'Opening balance',
    infoFields: [],
  },
  {
    type: 'creditCard',
    label: 'Credit card',
    description: 'What you owe on a card.',
    group: 'Spending',
    sectionShape: 'spending',
    onboarding: 'cardOutstanding',
    openingLabel: 'Current outstanding',
    infoFields: [{ key: 'creditLimit', label: 'Credit limit', type: 'number' }],
  },
  {
    type: 'fd',
    label: 'Fixed deposit',
    description: 'A locked-in deposit at a fixed rate.',
    group: 'Deposits',
    sectionShape: 'holding',
    onboarding: 'investedValue',
    openingLabel: 'Principal invested',
    infoFields: [
      { key: 'rate', label: 'Interest rate (%)', type: 'text' },
      { key: 'maturity', label: 'Maturity date', type: 'date' },
      { key: 'payout', label: 'Payout', type: 'select', options: ['Cumulative', 'Payout'] },
    ],
    paidOut: { when: 'payout', equals: 'Payout', rate: 'rate' },
    staleAfterMonths: 13,
  },
  {
    type: 'rd',
    label: 'Recurring deposit',
    description: 'A deposit paid in monthly instalments.',
    group: 'Deposits',
    sectionShape: 'holding',
    onboarding: 'investedValue',
    openingLabel: 'Amount invested so far',
    infoFields: [
      { key: 'installment', label: 'Monthly instalment', type: 'number' },
      { key: 'rate', label: 'Interest rate (%)', type: 'text' },
      { key: 'maturity', label: 'Maturity date', type: 'date' },
    ],
    staleAfterMonths: 13,
  },
  {
    // S5 RD13 (launch list): deposits arrive as transfers from a bank; the
    // passbook balance is typed with Update value. RD14: the maturity (1 April, 15 years after
    // the financial year it opened in) and this year's deposits against ₹1.5 lakh are worked out.
    type: 'ppf',
    currency: 'INR',
    label: 'PPF',
    description: 'Public Provident Fund: 15 years, ₹500 to ₹1.5 lakh a year.',
    group: 'India',
    sectionShape: 'holding',
    onboarding: 'investedValue',
    openingLabel: 'Deposited so far',
    infoFields: [{ key: 'openedOn', label: 'Opened on', type: 'date' }],
    workedOut: [
      { kind: 'date', label: 'Matures', from: 'openedOn', years: 15, afterFinancialYear: true },
      { kind: 'depositedThisYear', label: 'Deposited this year', limitPaise: 1_50_000_00 },
    ],
    staleAfterMonths: 13,
  },
  {
    // S5 RD16 (launch list): contributions are income rows from the employer
    // (Salary: money put in, C3); the passbook balance by Update value. Its EPS is a child account.
    type: 'epf',
    currency: 'INR',
    label: 'EPF',
    description: 'Employees’ Provident Fund: your 12 % and your employer’s share. Type the figures from your EPFO passbook.',
    group: 'India',
    sectionShape: 'holding',
    onboarding: 'investedValue',
    openingLabel: 'Paid in so far',
    infoFields: [{ key: 'employer', label: 'Employer', type: 'text' }],
    child: { type: 'eps', openingLabel: 'EPS paid in so far', namePrefix: 'EPS of ' },
    staleAfterMonths: 13,
    // F4: an Actual EPF's deposits (from EPFO, uncategorised, as Actual can't categorise off budget)
    // are pay put in ("epf is INCOME, its part of CTC").
    importDeposits: { name: 'Salary', kind: 'income' },
  },
  {
    // S5 RD16 (counted at what was paid in, Illiquid E2, a line of its
    // own under its EPF): the employer's pension share from the passbook's pension column.
    type: 'eps',
    currency: 'INR',
    label: 'EPS pension',
    description: 'The employer’s pension contributions, from the passbook’s pension column. Counted at what was paid in.',
    group: 'India',
    sectionShape: 'holding',
    onboarding: 'investedValue',
    openingLabel: 'Paid in so far',
    infoFields: [],
    childOf: 'epf',
    sectionOf: 'epf',
    paidInOnly: true,
    importDeposits: { name: 'Salary', kind: 'income' },
  },
  {
    type: 'loan',
    label: 'Loan',
    description: 'Home, car, personal, education or gold loan.',
    group: 'Loans',
    sectionShape: 'holding',
    onboarding: 'loanOutstanding',
    openingLabel: 'Current outstanding',
    // S5 RD15 ("Home loan by name"): two entries over the one module; the Kind
    // is a display-only detail, so the Loans section, net worth and allocation are unchanged.
    entries: [
      { label: 'Home loan', preset: { kind: 'Home loan' } },
      { label: 'Other loan', preset: {} },
    ],
    infoFields: [
      {
        key: 'kind',
        label: 'Kind',
        type: 'select',
        options: ['Home loan', 'Car loan', 'Personal loan', 'Education loan', 'Gold loan', 'Other loan'],
      },
      { key: 'principal', label: 'Original principal', type: 'number' },
      { key: 'rate', label: 'Interest rate (%)', type: 'text' },
      { key: 'security', label: 'Security', type: 'select', options: ['Secured', 'Unsecured'] },
    ],
    staleAfterMonths: 13,
  },
  {
    type: 'mutualFunds',
    label: 'Mutual funds',
    description: 'SIPs and lump-sum fund holdings.',
    group: 'Investments',
    sectionShape: 'holding',
    onboarding: 'investedValue',
    openingLabel: 'Amount invested',
    infoFields: [{ key: 'folio', label: 'Fund name or folio number', type: 'text' }],
    staleAfterMonths: 3,
  },
  {
    type: 'stocks',
    label: 'Stocks',
    description: 'Shares held with a broker.',
    group: 'Investments',
    sectionShape: 'holding',
    onboarding: 'investedValue',
    openingLabel: 'Amount invested',
    infoFields: [{ key: 'ticker', label: 'Ticker', type: 'text' }],
    staleAfterMonths: 3,
  },
  {
    type: 'gold',
    label: 'Gold',
    description: 'ETF, digital or physical gold.',
    group: 'Investments',
    sectionShape: 'holding',
    onboarding: 'investedValue',
    openingLabel: 'Amount invested',
    // SGB is its own type now (S5 RD13); a Gold account already set to SGB keeps showing it.
    infoFields: [
      { key: 'subType', label: 'Type', type: 'select', options: ['ETF', 'Digital', 'Physical'] },
      { key: 'sgbMaturity', label: 'SGB maturity date', type: 'date' },
    ],
    staleAfterMonths: 3,
  },
  {
    // S5 RD13: its own type (every SGB fact is fixed at issue). The 2.5 % interest is paid into a
    // bank (RBI) and typed there; nothing here works it out. RD14: Matures 8 years after issue,
    // early exit from the 5th anniversary.
    type: 'sgb',
    currency: 'INR',
    label: 'Sovereign Gold Bond',
    description: 'Government gold bonds: 8 years, early exit from the 5th. The interest is paid into your bank: add it there.',
    group: 'India',
    sectionShape: 'holding',
    onboarding: 'investedValue',
    openingLabel: 'Amount invested',
    infoFields: [
      { key: 'grams', label: 'Grams', type: 'text' },
      { key: 'issueDate', label: 'Issue date', type: 'date' },
      { key: 'issuePrice', label: 'Issue price a gram', type: 'number' },
      { key: 'pricePaid', label: 'Price you paid a gram', type: 'number' },
    ],
    workedOut: [
      { kind: 'date', label: 'Matures', from: 'issueDate', years: 8 },
      { kind: 'date', label: 'Early exit from', from: 'issueDate', years: 5 },
    ],
    staleAfterMonths: 3,
  },
  {
    type: 'property',
    label: 'Property',
    description: 'Land, a house or a flat.',
    group: 'Property',
    sectionShape: 'holding',
    onboarding: 'investedValue',
    openingLabel: 'Purchase cost',
    infoFields: [{ key: 'address', label: 'Address or note', type: 'text' }],
    staleAfterMonths: 13,
  },
  {
    type: 'otherAsset',
    label: 'Other asset',
    // Anything without a type of its own goes in here, and the app says so.
    description: 'Anything of value not listed here, such as crypto, ESOPs, bonds or a ULIP.',
    group: 'Other',
    sectionShape: 'holding',
    onboarding: 'investedValue',
    openingLabel: 'Amount invested',
    infoFields: [{ key: 'note', label: 'Note', type: 'text' }],
    staleAfterMonths: 13,
  },
  {
    type: 'otherLiability',
    label: 'Other liability',
    description: 'Any other debt you want to track.',
    group: 'Other',
    sectionShape: 'holding',
    onboarding: 'loanOutstanding',
    openingLabel: 'Current outstanding',
    infoFields: [{ key: 'note', label: 'Note', type: 'text' }],
    staleAfterMonths: 13,
  },
  {
    // S5 RD6, RD17 (in the first release). Tier I and
    // Tier II are separate accounts in one NPS section: Tier I locked in, Tier
    // II available soon (no lock-in). Your own contributions are transfers from a bank; the
    // employer's are Salary rows (money put in, as EPF's). The value is typed from the CRA
    // statement.
    type: 'nps',
    currency: 'INR',
    label: 'NPS Tier I',
    description: 'National Pension System, the pension account. Type the value from your CRA statement.',
    group: 'India',
    sectionShape: 'holding',
    onboarding: 'investedValue',
    openingLabel: 'Amount invested',
    infoFields: [{ key: 'pran', label: 'PRAN or note', type: 'text' }],
    staleAfterMonths: 3,
    // F4: an Actual NPS's plain deposits are most likely the employer's (paid straight in).
    importDeposits: { name: 'Salary', kind: 'income' },
  },
  {
    type: 'npsTier2',
    currency: 'INR',
    label: 'NPS Tier II',
    description: 'National Pension System, the savings account you can withdraw from. Type the value from your CRA statement.',
    group: 'India',
    sectionShape: 'holding',
    onboarding: 'investedValue',
    openingLabel: 'Amount invested',
    infoFields: [{ key: 'pran', label: 'PRAN or note', type: 'text' }],
    sectionOf: 'nps',
    staleAfterMonths: 3,
  },
];

const BY_TYPE = new Map(MODULE_PROFILES.map((p) => [p.type, p]));

/** The profile for a type, or undefined (e.g. an unknown/legacy type). */
export function moduleProfile(type: string): ModuleProfile | undefined {
  return BY_TYPE.get(type);
}

/**
 * S5 informational fields from a form (`info_<key>`), as Add account and Edit account post them:
 * blanks dropped (a cleared field is removed), dates checked; `infoJson` is null when none is
 * filled. Display-only (S5 RD3): nothing reads these into a figure.
 */
export function readInfoForm(
  profile: ModuleProfile,
  form: FormData,
): { infoJson: string | null } | { errors: Record<string, string> } {
  const info: Record<string, string> = {};
  for (const f of profile.infoFields) {
    const val = String(form.get(`info_${f.key}`) ?? '').trim();
    if (val === '') continue;
    if (f.type === 'date' && !isRealDate(val)) {
      return { errors: { [`info_${f.key}`]: 'Enter a valid date' } };
    }
    const problem = textProblem(val, 'details');
    if (problem) return { errors: { [`info_${f.key}`]: problem } };
    info[f.key] = val;
  }
  return { infoJson: Object.keys(info).length > 0 ? JSON.stringify(info) : null };
}

/** The stored informational values of an account, by key (an unreadable value reads as none). */
export function infoValues(infoJson: string | null | undefined): Record<string, string> {
  if (!infoJson) return {};
  try {
    const parsed: unknown = JSON.parse(infoJson);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/**
 * S5 RD8: the filled informational fields in the profile's order, for the account page's line. A
 * choice shows its value alone (S5 RD12); the label drops its unit ("Interest rate (%)" reads "Interest rate"); the page formats each value by
 * its `type` (an amount in the account's currency, a date, a rate with its %).
 */
export function infoDetails(
  type: string,
  infoJson: string | null | undefined,
): { key: string; label: string; showLabel: boolean; type: InfoField['type']; value: string; percent: boolean }[] {
  const values = infoValues(infoJson);
  return (moduleProfile(type)?.infoFields ?? [])
    .filter((f) => (values[f.key] ?? '').trim() !== '')
    .map((f) => ({
      key: f.key,
      label: f.label.replace(/\s*\(%\)$/u, ''),
      // A choice's value names itself ("Payout", "Secured", "SGB"); "Payout Payout" read
      // twice. Typed values keep their label ("Interest rate 7.1%").
      showLabel: f.type !== 'select',
      type: f.type,
      value: values[f.key]!.trim(),
      percent: f.label.endsWith('(%)'),
    }));
}

/**
 * C1 A: the stated yearly rate of a holding whose details say its interest is paid out, as a ratio
 * (7.1 % → 0.071), or null (not a paid-out holding, or no readable rate). From the profile's
 * `paidOut` fields, so any profile can declare it.
 */
export function paidOutRate(type: string, infoJson: string | null | undefined): number | null {
	const rule = moduleProfile(type)?.paidOut;
	if (!rule) return null;
	const values = infoValues(infoJson);
	if ((values[rule.when] ?? '').trim() !== rule.equals) return null;
	const n = Number((values[rule.rate] ?? '').replace(/%/gu, '').trim());
	return Number.isFinite(n) && n > 0 && n < 100 ? n / 100 : null;
}

/** The currency a new account of this type opens in: its fixed one (an Indian scheme), else the
 *  one picked, else the base. */
export function openingCurrency(type: string, picked: string | null, base: string): string {
  return BY_TYPE.get(type)?.currency ?? (picked?.trim() ? picked.trim().toUpperCase() : base);
}

/** A readable label for a type, falling back to the raw key. */
export function moduleLabel(type: string): string {
  return BY_TYPE.get(type)?.label ?? type;
}

/**
 * A class's chart colour (DECISIONS-S4 D4: colour follows the entity, never its rank). Fifteen
 * classes share ten swatches, so a class is a swatch slot or a shade of one: the slot's colour
 * mixed halfway to the text colour (darker in Light, lighter in Dark), which keeps a family
 * together and apart (EPS under EPF, SGB under Gold, FD under Bank). Chosen with the dataviz
 * validator over every pair a household holds together, in Light and Dark (U6):
 * every two assets at least ΔE 10.8 apart, except Funds and Gold in Dark (7.6, the anchors kept)
 * and NPS beside Bank (6.2). Liabilities are drawn in the money red on Reports (not these).
 */
type ClassColour = number | { shadeOf: number };
const CLASS_COLOUR: Record<string, ClassColour> = {
  bank: 1,
  fd: { shadeOf: 1 },
  rd: { shadeOf: 3 },
  mutualFunds: 5,
  stocks: 10,
  gold: 9,
  sgb: { shadeOf: 9 },
  property: 7,
  ppf: 3,
  epf: 2,
  eps: { shadeOf: 2 },
  otherAsset: 4,
  nps: 6,
  npsTier2: { shadeOf: 6 },
  creditCard: 6,
  loan: 8,
  otherLiability: 6,
};

/** A class's chart colour as a CSS value; unknown types share the neutral grey. */
export function moduleColour(type: string): string {
  const c = CLASS_COLOUR[type];
  if (c === undefined) return 'var(--cat-other)';
  return typeof c === 'number' ? `var(--cat-${c})` : `color-mix(in srgb, var(--cat-${c.shadeOf}) 50%, var(--text))`;
}

/** Plural names where a section (a list of accounts of one type) reads better than the type's own label. */
const SECTION_LABELS: Record<string, string> = {
  bank: 'Bank accounts',
  creditCard: 'Credit cards',
  fd: 'Fixed deposits',
  rd: 'Recurring deposits',
  loan: 'Loans',
  otherAsset: 'Other assets',
  otherLiability: 'Other liabilities',
  sgb: 'Sovereign Gold Bonds',
  // The section holds both tiers (Tier II shows in it, `sectionOf`).
  nps: 'NPS',
};

/** A section's name: the sidebar heading and the section page's title (S1 RD7). */
export function sectionLabel(type: string): string {
  return SECTION_LABELS[type] ?? moduleLabel(type);
}

/** The Add account list's entries of a profile: its `entries`, or one entry under its label. */
export function profileEntries(p: ModuleProfile): { label: string; preset: Readonly<Record<string, string>> }[] {
  return p.entries ? [...p.entries] : [{ label: p.label, preset: {} }];
}

/** A date `years` after an ISO date (29 Feb lands on 28 Feb); with `afterFinancialYear`, counted
 *  from the 1 April that ends the financial year (April to March) the date falls in. */
export function yearsAfter(iso: string, years: number, afterFinancialYear = false): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(iso);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (afterFinancialYear) return `${(mo >= 4 ? y + 1 : y) + years}-04-01`;
  const ty = y + years;
  const leap = (ty % 4 === 0 && ty % 100 !== 0) || ty % 400 === 0;
  const day = mo === 2 && d === 29 && !leap ? 28 : d;
  return `${ty}-${String(mo).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** The first day (ISO) of the financial year (April to March) an ISO date falls in. */
export function financialYearStart(iso: string): string {
  const y = Number(iso.slice(0, 4));
  return Number(iso.slice(5, 7)) >= 4 ? `${y}-04-01` : `${y - 1}-04-01`;
}

export type WorkedOutFigure =
  | { key: string; label: string; kind: 'date'; value: string }
  | { key: string; label: string; kind: 'limit'; paise: number; limitPaise: number };

/**
 * S5 RD14: the profile's worked-out figures for one account, for the details line. Dates from the
 * details; "deposited this year" sums the money put in that Invested counts (a PPF's deposits)
 * dated from this financial year's 1 April to today: a transfer in, unless its category counts as
 * return, and a plain row whose category doesn't (the engine's `movesInvested`). `countsAsReturn` is the row's flag from `returnFlags`. Nothing about interest.
 */
export function workedOutFigures(
  type: string,
  infoJson: string | null | undefined,
  rows: readonly { date: string; amountPaise: number; kind: string; transferPartnerId: string | null; countsAsReturn?: boolean }[],
  todayIso: string,
): WorkedOutFigure[] {
  const values = infoValues(infoJson);
  const out: WorkedOutFigure[] = [];
  for (const [i, w] of (moduleProfile(type)?.workedOut ?? []).entries()) {
    if (w.kind === 'date') {
      const date = yearsAfter((values[w.from] ?? '').trim(), w.years, w.afterFinancialYear);
      if (date) out.push({ key: `wo${i}`, label: w.label, kind: 'date', value: date });
    } else {
      const from = financialYearStart(todayIso);
      const paise = rows
        .filter(
          (r) =>
            r.kind === 'ordinary' &&
            r.amountPaise > 0 &&
            r.date >= from &&
            r.date <= todayIso &&
            (r.transferPartnerId ? r.countsAsReturn !== true : r.countsAsReturn === false),
        )
        .reduce((s, r) => s + r.amountPaise, 0);
      out.push({ key: `wo${i}`, label: w.label, kind: 'limit', paise, limitPaise: w.limitPaise });
    }
  }
  return out;
}

/** The section a type shows in: its own, or its parent's (an EPS in its EPF's section, S5 RD16). */
export function sectionTypeOf(type: string): string {
  return BY_TYPE.get(type)?.sectionOf ?? type;
}

/** Creatable (non-coming-soon) profiles, in catalogue order; a child type is made with its parent. */
export function creatableProfiles(): ModuleProfile[] {
  return MODULE_PROFILES.filter((p) => !p.comingSoon && !p.childOf);
}

/** Profiles grouped by S1 nav group, in the fixed group order (empty groups omitted), for Add
 *  account: a child type (EPS) is left out, it comes with its parent. */
export function profilesByGroup(): { group: SectionGroup; profiles: ModuleProfile[] }[] {
  return SECTION_GROUPS.map((group) => ({
    group,
    profiles: MODULE_PROFILES.filter((p) => p.group === group && !p.childOf),
  })).filter((g) => g.profiles.length > 0);
}
