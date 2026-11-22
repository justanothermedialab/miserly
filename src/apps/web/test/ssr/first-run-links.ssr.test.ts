import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import ImportCard from '$lib/components/ImportCard.svelte';
import { ADDRESSES, aboutLinks, legalLinks, linkTo } from '$lib/links';

// The empty dashboard's Import from Actual and User guide, and the About dialog's links. The
// addresses live in one place; an empty one hides its link.
describe('the outside links, from one list', () => {
	it('point at the website, the public repo and GitHub Sponsors over https', () => {
		const { licence, thirdPartyNotices, ...rest } = ADDRESSES;
		expect(Object.values(rest).every((a) => a.startsWith('https://'))).toBe(true);
		expect(aboutLinks().map((l) => l.label)).toEqual(['User guide', "What's new", 'Report a problem', 'Website', 'Support Miserly']);
		expect(linkTo('userGuide')).toBe('https://miserly.jamlab.in/docs/');
		expect(linkTo('website')).toBe('https://miserly.jamlab.in/');
		expect(linkTo('support')).toMatch(/^https:\/\/github\.com\/sponsors\//);
		expect(licence).toBe('https://www.gnu.org/licenses/agpl-3.0.html');
		expect(thirdPartyNotices).toBe('/THIRD-PARTY-NOTICES.txt');
		expect(legalLinks().map((l) => l.label)).toEqual(['Licence', 'Third-party notices']);
	});

	it('an empty address hides its link; About lists the filled ones in order', () => {
		const none = { ...ADDRESSES, userGuide: '', whatsNew: '', reportProblem: '', website: '', support: '' };
		expect(aboutLinks(none)).toEqual([]);
		expect(linkTo('userGuide', none)).toBeNull();
		const filled = { ...none, userGuide: 'https://example.org/docs', support: 'https://example.org/sponsor' };
		expect(aboutLinks(filled)).toEqual([
			{ label: 'User guide', href: 'https://example.org/docs' },
			{ label: 'Support Miserly', href: 'https://example.org/sponsor' }
		]);
		expect(linkTo('userGuide', filled)).toBe('https://example.org/docs');
	});
});

describe('Import from Actual on the empty dashboard', () => {
	it('is one button that opens the same import as Settings, without the Settings card', () => {
		const { body } = render(ImportCard, { props: { imports: [], rowCls: '', button: true } });
		expect(body).toContain('Import from Actual');
		expect(body).toContain('type="file"');
		expect(body).not.toContain('From Actual Budget');
	});

	it('keeps the Settings card as it is', () => {
		const { body } = render(ImportCard, { props: { imports: [], rowCls: '' } });
		expect(body).toContain('From Actual Budget');
		expect(body).not.toContain('Import from Actual<');
	});
});
