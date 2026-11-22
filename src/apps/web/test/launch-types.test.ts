/**
 * The launch-list types (S5 RD13 to RD15, 2026-11-10): the profiles, the Add account entries and
 * the worked-out figures (dates fixed by the scheme, sums of the person's own rows; no interest).
 */
import { describe, expect, it } from 'vitest';
import { getModule } from '@miserly/core';
import { COLOUR_ICONS } from '$lib/icons/colour';
import {
	MODULE_PROFILES,
	creatableProfiles,
	financialYearStart,
	FOLDED_GROUPS,
	moduleColour,
	moduleProfile,
	profileEntries,
	profilesByGroup,
	sectionLabel,
	sectionTypeOf,
	workedOutFigures,
	yearsAfter
} from '$lib/modules';

describe('launch types', () => {
	it('every creatable profile has a registered core module and a sidebar icon', () => {
		for (const p of creatableProfiles()) {
			expect(getModule(p.type).type).toBe(p.type);
			// The built app's sidebar showed PPF and Sovereign Gold Bonds without one (2026-11-10).
			expect(COLOUR_ICONS[p.type], p.type).toMatch(/^<svg/);
		}
	});

	it('O31 (A): the Indian schemes are one India group, last and folded; FD, RD, Home loan and Gold stay', () => {
		const groups = profilesByGroup();
		expect(groups.map((g) => g.group)).toEqual(['Spending', 'Deposits', 'Loans', 'Investments', 'Property', 'Other', 'India']);
		expect(groups.at(-1)!.profiles.map((p) => p.type)).toEqual(['ppf', 'epf', 'sgb', 'nps', 'npsTier2']);
		expect(FOLDED_GROUPS).toEqual({ India: 'PPF, EPF, SGB, NPS' });
		expect(['fd', 'rd'].map((t) => moduleProfile(t)?.group)).toEqual(['Deposits', 'Deposits']);
		expect(moduleProfile('gold')?.group).toBe('Investments');
		expect(moduleProfile('loan')?.group).toBe('Loans');
	});

	it('SGB is a Sovereign Gold Bonds section; nothing is coming soon', () => {
		expect(sectionLabel('sgb')).toBe('Sovereign Gold Bonds');
		expect(MODULE_PROFILES.filter((p) => p.comingSoon)).toEqual([]);
		expect(getModule('ppf').metadata.liquidity).toBe('Illiquid');
		expect(getModule('sgb').metadata.liquidity).toBe('Semi');
	});

	it('NPS is two types, Tier I and Tier II, in one NPS section, in rupees', () => {
		const t1 = moduleProfile('nps')!;
		const t2 = moduleProfile('npsTier2')!;
		expect([t1.label, t2.label]).toEqual(['NPS Tier I', 'NPS Tier II']);
		expect(sectionLabel('nps')).toBe('NPS');
		expect(sectionTypeOf('npsTier2')).toBe('nps');
		expect(t2.childOf).toBeUndefined(); // added on its own, only by someone who has one
		expect([t1.currency, t2.currency]).toEqual(['INR', 'INR']);
		expect([t1.openingLabel, t2.openingLabel]).toEqual(['Amount invested', 'Amount invested']);
		expect(t1.infoFields.map((f) => f.label)).toEqual(['PRAN or note']);
		expect(t1.staleAfterMonths).toBe(3);
		// The employer pays Tier I straight in, as with EPF: an Actual NPS's plain deposits are Salary.
		expect(t1.importDeposits).toEqual({ name: 'Salary', kind: 'income' });
		expect(getModule('nps').metadata.liquidity).toBe('Illiquid');
		expect(getModule('npsTier2').metadata.liquidity).toBe('Semi');
		expect(moduleColour('nps')).toBe('var(--cat-6)');
		expect(moduleColour('npsTier2')).toContain('var(--cat-6)');
	});

	it("Other asset's description invites anything not listed", () => {
		const d = moduleProfile('otherAsset')!.description;
		expect(d).not.toMatch(/NPS/u);
		expect(d).toMatch(/not listed/u);
	});

	it('the Loan module shows as "Home loan" and "Other loan", the first presetting its Kind', () => {
		expect(profileEntries(moduleProfile('loan')!)).toEqual([
			{ label: 'Home loan', preset: { kind: 'Home loan' } },
			{ label: 'Other loan', preset: {} }
		]);
		expect(profileEntries(moduleProfile('bank')!)).toEqual([{ label: 'Bank account', preset: {} }]);
		// 11 + PPF, SGB, EPF and NPS's two tiers, one more entry for the loan's two names: 17 (the
		// EPS comes with its EPF).
		expect(creatableProfiles().flatMap(profileEntries)).toHaveLength(17);
	});

	it("PPF matures on 1 April, 15 years after the end of the financial year it opened in", () => {
		for (const opened of ['2019-04-01', '2019-06-12', '2020-03-31']) expect(yearsAfter(opened, 15, true)).toBe('2035-04-01');
		expect(yearsAfter('2020-04-01', 15, true)).toBe('2036-04-01');
	});

	it('SGB matures 8 years after issue, early exit from the 5th anniversary; 29 Feb lands on 28 Feb', () => {
		expect(yearsAfter('2023-12-28', 8)).toBe('2031-12-28');
		expect(yearsAfter('2023-12-28', 5)).toBe('2028-12-28');
		expect(yearsAfter('2024-02-29', 5)).toBe('2029-02-28');
		expect(yearsAfter('not a date', 5)).toBeNull();
	});

	it('the financial year starts on 1 April', () => {
		expect(financialYearStart('2026-11-10')).toBe('2026-04-01');
		expect(financialYearStart('2027-03-31')).toBe('2026-04-01');
		expect(financialYearStart('2026-04-01')).toBe('2026-04-01');
	});

	it("PPF's figures: Matures, and this year's deposits by transfer against ₹1,50,000", () => {
		const rows = [
			{ date: '2026-08-04', amountPaise: 75_000_00, kind: 'ordinary', transferPartnerId: 't2' },
			{ date: '2026-05-04', amountPaise: 75_000_00, kind: 'ordinary', transferPartnerId: 't1' },
			{ date: '2026-03-31', amountPaise: 28_700_00, kind: 'ordinary', transferPartnerId: null }, // interest, last year
			{ date: '2025-08-04', amountPaise: 75_000_00, kind: 'ordinary', transferPartnerId: 't0' }, // last year
			{ date: '2026-09-30', amountPaise: 10_000_00, kind: 'valuationMark', transferPartnerId: null },
			{ date: '2026-12-04', amountPaise: 50_000_00, kind: 'ordinary', transferPartnerId: 't3' } // after today
		];
		expect(workedOutFigures('ppf', JSON.stringify({ openedOn: '2019-06-12' }), rows, '2026-11-10')).toEqual([
			{ key: 'wo0', label: 'Matures', kind: 'date', value: '2035-04-01' },
			{ key: 'wo1', label: 'Deposited this year', kind: 'limit', paise: 1_50_000_00, limitPaise: 1_50_000_00 }
		]);
		// The rows Invested counts. A plain deposit whose category isn't return
		// counts; a transfer whose category counts as return (a payout) doesn't.
		const flagged = [
			...rows,
			{ date: '2026-06-01', amountPaise: 20_000_00, kind: 'ordinary', transferPartnerId: null, countsAsReturn: false },
			{ date: '2026-06-02', amountPaise: 9_000_00, kind: 'ordinary', transferPartnerId: null, countsAsReturn: true },
			{ date: '2026-06-03', amountPaise: 5_000_00, kind: 'ordinary', transferPartnerId: 't4', countsAsReturn: true }
		];
		expect(workedOutFigures('ppf', null, flagged, '2026-11-10')).toEqual([
			{ key: 'wo1', label: 'Deposited this year', kind: 'limit', paise: 1_70_000_00, limitPaise: 1_50_000_00 }
		]);
		// No opening date typed: only the yearly sum shows.
		expect(workedOutFigures('ppf', null, [], '2026-11-10').map((f) => f.label)).toEqual(['Deposited this year']);
		// Other types work nothing out.
		expect(workedOutFigures('fd', JSON.stringify({ maturity: '2027-01-01' }), rows, '2026-11-10')).toEqual([]);
	});
});
