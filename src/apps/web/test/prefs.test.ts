/**
 * prefs.test.ts — SET1 pure render policy: `$lib/prefs` + `boundMoney`
 * (`$lib/format-context`).
 * ============================================================================
 * `prefs.ts` and `format-context.ts` are the client-safe halves of M11 —
 * no DB, no SvelteKit server import — so they are unit-tested directly, the
 * same way `format.test.ts` covers the raw formatter. Proves: the locale ->
 * number-system default; the `isWesternGrouping` policy (system default,
 * the base-currency-always-follows-system exception, and the native-locale
 * foreign-grouping override); and that `boundMoney` wires those two together
 * correctly for both number systems and for a native-locale foreign amount.
 * ============================================================================
 */
import { describe, expect, it } from 'vitest';
import { defaultNumberSystem, defaultNumberSystemForLocale, isWesternGrouping, type UserPrefs } from '../src/lib/prefs';
import { boundMoney } from '../src/lib/format-context';

function prefs(overrides: Partial<UserPrefs> = {}): UserPrefs {
	return {
		numberSystem: 'indian',
		compact: false,
		foreignGrouping: 'preference',
		theme: 'system',
		accent: 'ink',
		...overrides,
	};
}

describe('defaultNumberSystem (SET1 RD2 amended — REL-12)', () => {
	it('an INR base is indian regardless of the device locale', () => {
		expect(defaultNumberSystem('en-US', 'INR')).toBe('indian');
		expect(defaultNumberSystem(null, 'inr')).toBe('indian');
	});
	it('any other base falls back to the locale rule', () => {
		expect(defaultNumberSystem('en-US', 'USD')).toBe('western');
		expect(defaultNumberSystem('en-IN', 'USD')).toBe('indian');
		expect(defaultNumberSystem(null, null)).toBe('western');
	});
});

describe('defaultNumberSystemForLocale', () => {
	it('a South-Asian language tag resolves to indian', () => {
		expect(defaultNumberSystemForLocale('hi')).toBe('indian');
		expect(defaultNumberSystemForLocale('bn-BD')).toBe('indian');
	});

	it('a South-Asian region tag resolves to indian even for a non-South-Asian language', () => {
		expect(defaultNumberSystemForLocale('en-IN')).toBe('indian');
		expect(defaultNumberSystemForLocale('en-PK')).toBe('indian');
	});

	it('a non-South-Asian locale resolves to western', () => {
		expect(defaultNumberSystemForLocale('en-US')).toBe('western');
		expect(defaultNumberSystemForLocale('fr-FR')).toBe('western');
	});

	it('no hint (undefined/null) falls back to western', () => {
		expect(defaultNumberSystemForLocale(undefined)).toBe('western');
		expect(defaultNumberSystemForLocale(null)).toBe('western');
		expect(defaultNumberSystemForLocale('')).toBe('western');
	});

	it('reads only the highest-priority tag of an Accept-Language list', () => {
		expect(defaultNumberSystemForLocale('en-US,hi;q=0.5')).toBe('western');
		expect(defaultNumberSystemForLocale('hi;q=0.9,en-US;q=0.5')).toBe('indian');
	});
});

describe('isWesternGrouping', () => {
	it('the base currency always follows the user system, regardless of foreignGrouping', () => {
		expect(isWesternGrouping(prefs({ numberSystem: 'indian' }), 'INR', 'INR')).toBe(false);
		expect(isWesternGrouping(prefs({ numberSystem: 'western' }), 'INR', 'INR')).toBe(true);
		expect(
			isWesternGrouping(prefs({ numberSystem: 'indian', foreignGrouping: 'native-locale' }), 'INR', 'INR'),
		).toBe(false);
	});

	it('foreignGrouping = preference: a foreign amount follows the user system too', () => {
		expect(isWesternGrouping(prefs({ numberSystem: 'indian' }), 'USD', 'INR')).toBe(false);
		expect(isWesternGrouping(prefs({ numberSystem: 'western' }), 'USD', 'INR')).toBe(true);
	});

	it('foreignGrouping = native-locale: a foreign amount groups by ITS OWN currency style', () => {
		const p = prefs({ numberSystem: 'indian', foreignGrouping: 'native-locale' });
		// USD is not South-Asian -> western grouping, even though the user's system is indian.
		expect(isWesternGrouping(p, 'USD', 'INR')).toBe(true);
		// PKR IS South-Asian -> stays 2-2-3 (non-western) even under a western user system.
		const q = prefs({ numberSystem: 'western', foreignGrouping: 'native-locale' });
		expect(isWesternGrouping(q, 'PKR', 'INR')).toBe(false);
	});
});

describe('boundMoney', () => {
	it('indian system: groups 2-2-3 for INR', () => {
		const m = boundMoney(prefs({ numberSystem: 'indian' }), 'INR');
		expect(m.money(12345600, { currency: 'INR' })).toBe('₹1,23,456.00');
	});

	it('western system: groups every 3 digits for INR', () => {
		const m = boundMoney(prefs({ numberSystem: 'western' }), 'INR');
		expect(m.money(12345600, { currency: 'INR' })).toBe('₹123,456.00');
	});

	it('native-locale foreign grouping: USD groups western even under an indian system', () => {
		const m = boundMoney(prefs({ numberSystem: 'indian', foreignGrouping: 'native-locale' }), 'INR');
		expect(m.money(12345600, { currency: 'USD' })).toBe('$123,456.00');
	});

	it('INR always follows the system, even with native-locale grouping on', () => {
		const m = boundMoney(prefs({ numberSystem: 'western', foreignGrouping: 'native-locale' }), 'INR');
		expect(m.money(12345600, { currency: 'INR' })).toBe('₹123,456.00');
	});

	it('exposes the compact preference and the raw prefs object', () => {
		const p = prefs({ compact: true });
		const m = boundMoney(p, 'INR');
		expect(m.compact).toBe(true);
		expect(m.prefs).toEqual(p);
	});

	it('baseApprox always renders in base currency with the "≈" prefix', () => {
		const m = boundMoney(prefs({ numberSystem: 'indian' }), 'INR');
		expect(m.baseApprox(830000)).toBe('≈ ₹8,300.00');
	});

	it('signedMoney and moneyWithCode delegate through the same grouping policy', () => {
		const m = boundMoney(prefs({ numberSystem: 'western' }), 'INR');
		expect(m.signedMoney(120000)).toBe('+₹1,200.00');
		expect(m.moneyWithCode(1234567800, 'USD')).toBe('$12,345,678.00 USD');
	});
});
