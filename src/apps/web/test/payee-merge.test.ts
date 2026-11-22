/**
 * payee-merge.test.ts: Payees offers Merge only when a payee would move (found in testing: one
 * payee ticked and chosen as the target asked "Merge 0 payees into X?").
 */
import { describe, expect, it } from 'vitest';
import { mergeMoves } from '../src/lib/payee-merge';

describe('mergeMoves', () => {
	it('is the ticked payees without the target', () => {
		expect(mergeMoves(['a', 'b', 'c'], 'b')).toEqual(['a', 'c']);
	});

	it('is nothing until a target is chosen', () => {
		expect(mergeMoves(['a', 'b'], '')).toEqual([]);
	});

	it('is nothing when the only ticked payee is the target', () => {
		expect(mergeMoves(['a'], 'a')).toEqual([]);
	});
});
