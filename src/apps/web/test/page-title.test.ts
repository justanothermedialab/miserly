import { describe, expect, it } from 'vitest';
import { trailFor, titleFor } from '$lib/page-title';

// Every route names itself in the document title, using the TopBar's words.
describe('page title', () => {
	it('names the top-level screens', () => {
		expect(titleFor('/')).toBe('Dashboard - Miserly');
		expect(titleFor('/inbox')).toBe('To categorize - Miserly');
		expect(titleFor('/settings')).toBe('Settings - Miserly');
		expect(titleFor('/signin')).toBe('Sign in - Miserly');
		expect(titleFor('/setup')).toBe('Set up - Miserly');
	});
	it('uses the route crumb for deep pages, else a sensible default', () => {
		expect(titleFor('/accounts/abc', 'SBI Savings')).toBe('SBI Savings - Miserly');
		const all = { label: 'All accounts', href: '/accounts' };
		expect(trailFor('/accounts/abc')).toEqual({ name: 'Account', parent: all, ancestors: [all] });
		expect(trailFor('/sections/mutualFunds')).toEqual({ name: 'Mutual funds', parent: all, ancestors: [all] });
		expect(titleFor('/accounts')).toBe('All accounts - Miserly');
		expect(titleFor('/transactions')).toBe('All transactions - Miserly');
		expect(trailFor('/reports').parent).toBeNull();
	});
	it('puts a register under its section (HDFC in Loans and in Bank accounts)', () => {
		const all = { label: 'All accounts', href: '/accounts' };
		const loans = { label: 'Loans', href: '/sections/loan' };
		expect(trailFor('/accounts/abc', 'HDFC', loans)).toEqual({ name: 'HDFC', parent: loans, ancestors: [all, loans] });
	});
});
