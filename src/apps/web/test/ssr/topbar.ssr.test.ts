import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import TopBar from '$lib/components/TopBar.svelte';

// The full-width title bar (chrome B, 2026-10-20) observes <html data-pane> and measures its path;
// both must wait for the browser, or every signed-in page 500s on the server.
describe('TopBar on the server', () => {
	it('renders the corner mark, the pane toggle, the search field and Add', () => {
		const { body } = render(TopBar);
		expect(body).toContain('id="app-pane-toggle"');
		expect(body).toContain('id="app-search"');
		expect(body).toContain('role="combobox"');
		expect(body).toContain('wco-reserve');
	});
});
