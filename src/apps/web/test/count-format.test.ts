/**
 * count-format.test.ts — counts read in the person's number format, as amounts do: the
 * Inbox header read "1501 transactions" beside amounts written 1,501.00.
 */
import { describe, expect, it } from 'vitest';
import { formatCount } from '../src/lib/format';
import { boundMoney, DEFAULT_PREFS } from '../src/lib/format-context';

describe('formatCount', () => {
	it('groups in the Indian style by default', () => {
		expect(formatCount(7)).toBe('7');
		expect(formatCount(1501)).toBe('1,501');
		expect(formatCount(150000)).toBe('1,50,000');
	});
	it('groups in the Western style when asked', () => {
		expect(formatCount(150000, true)).toBe('150,000');
	});
	it('follows the viewer’s number system through the bound formatter', () => {
		expect(boundMoney(DEFAULT_PREFS).count(123456)).toBe('1,23,456');
		expect(boundMoney({ ...DEFAULT_PREFS, numberSystem: 'western' }).count(123456)).toBe('123,456');
	});
});
