/**
 * links.ts: the app's outside addresses, in one place. The licence and the third-party notices
 * are known now (the AGPL-3.0 text, and the notices file the app serves from static/); the rest
 * point at the public repo and the site. An empty address hides its link
 * everywhere (About, the empty dashboard). No prompts or banners point at them.
 */
export type LinkKey = 'userGuide' | 'whatsNew' | 'reportProblem' | 'website' | 'support' | 'licence' | 'thirdPartyNotices';
export type Addresses = Readonly<Record<LinkKey, string>>;

export const ADDRESSES: Addresses = {
	// The guide is built from docs/user-guide/pages/ into the website.
	userGuide: 'https://miserly.jamlab.in/docs/',
	whatsNew: 'https://github.com/justanothermedialab/miserly/releases',
	reportProblem: 'https://github.com/justanothermedialab/miserly/issues',
	website: 'https://miserly.jamlab.in/',
	support: 'https://github.com/sponsors/varunnjbehera',
	licence: 'https://www.gnu.org/licenses/agpl-3.0.html',
	thirdPartyNotices: '/THIRD-PARTY-NOTICES.txt'
};

/** One link's address, or null while it is empty. */
export function linkTo(key: LinkKey, addresses: Addresses = ADDRESSES): string | null {
	return addresses[key] || null;
}

const shown = (list: readonly [string, LinkKey][], addresses: Addresses) =>
	list.filter(([, key]) => addresses[key]).map(([label, key]) => ({ label, href: addresses[key] }));

/** The About dialog's links, in order, those with an address only. */
export function aboutLinks(addresses: Addresses = ADDRESSES): { label: string; href: string }[] {
	return shown(
		[
			['User guide', 'userGuide'],
			["What's new", 'whatsNew'],
			['Report a problem', 'reportProblem'],
			['Website', 'website'],
			['Support Miserly', 'support']
		],
		addresses
	);
}

/** The About dialog's legal line. */
export function legalLinks(addresses: Addresses = ADDRESSES): { label: string; href: string }[] {
	return shown(
		[
			['Licence', 'licence'],
			['Third-party notices', 'thirdPartyNotices']
		],
		addresses
	);
}
