import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import EmptyState from '$lib/components/EmptyState.svelte';

// Empty states render in the server's first frame on every list page.
describe('EmptyState on the server', () => {
	it('renders the icon, the line and the sentence', () => {
		const { body } = render(EmptyState, { props: { icon: 'inbox', title: 'All caught up', text: 'Every transaction has a category.' } });
		expect(body).toContain('All caught up');
		expect(body).toContain('Every transaction has a category.');
		expect(body).toContain('<svg');
	});
});
