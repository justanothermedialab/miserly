import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import Sidebar from '$lib/components/Sidebar.svelte';

// The server renders every page's first frame, sidebar included: anything browser-only read while
// rendering (window, innerWidth, localStorage) is a 500 on every signed-in page. The resizable pane's
// handle read innerWidth unguarded and did exactly that (2026-10-17, caught on the exe, not by tests).
describe('Sidebar on the server', () => {
	it('renders signed in, with accounts, without touching browser globals', () => {
		const { body } = render(Sidebar, {
			props: {
				nav: {
					hasOpenAccounts: true,
					netWorthPaise: 9_268_060_80,
					rateNeededCurrencies: [],
					monthChange: { absPaise: 215_180_00, pct: 2.4 },
					sections: [
						{ type: 'bank', label: 'Bank accounts', subtotalPaise: 4_395_262_00, rateNeeded: false, collapsed: false, accounts: [{ id: 'a1', name: 'HDFC Salary', sharePaise: 911_697_00, shareBp: null, currency: 'INR' }] }
					]
				},
				user: { username: 'alice', displayName: 'Alice', role: 'admin' },
				inboxCount: 8,
				baseCurrency: 'INR'
			}
		});
		expect(body).toContain('HDFC Salary');
		expect(body).toContain('role="separator"');
	});
});
