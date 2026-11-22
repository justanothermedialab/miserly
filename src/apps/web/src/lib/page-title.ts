/**
 * The page's name, derived from its path: the TopBar's title and the document <title>
 * (browser tabs, the desktop window's taskbar name and screen readers on navigation)
 * read the same words. A nested page also names its parent, which the TopBar shows as a
 * back link (one heading only, in the bar), and the full path above it: a register reads
 * "All accounts / Loans / HDFC" (two accounts can share a name across
 * sections, and the section must show where people look to see where they are).
 */
import { sectionLabel } from '$lib/modules';

const LABELS: Record<string, string> = {
	'': 'Dashboard',
	accounts: 'All accounts',
	sections: 'All accounts',
	transactions: 'All transactions',
	reports: 'Reports',
	settings: 'Settings',
	inbox: 'To categorize',
	categories: 'Categories',
	payees: 'Payees',
	signin: 'Sign in',
	setup: 'Set up',
	'change-password': 'Change password'
};

export interface PageTrail {
	/** The page's own name. */
	name: string;
	/** The page one level up, for the back link on nested pages. */
	parent: { label: string; href: string } | null;
	/** Every page above this one, top first (the breadcrumb); its last entry is `parent`. */
	ancestors: { label: string; href: string }[];
}

/**
 * The page's name and the pages above it. `dataCrumb` is a route's precise name (an
 * account's own name); `dataSection` is a register's section, which sits between All accounts and
 * the account.
 */
export function trailFor(
	pathname: string,
	dataCrumb?: string,
	dataSection?: { label: string; href: string }
): PageTrail {
	const segs = pathname.split('/').filter(Boolean);
	const first = segs[0];
	if (!first) return { name: 'Dashboard', parent: null, ancestors: [] };
	const label = LABELS[first] ?? first;
	const second = segs[1];
	if (!second) return { name: label, parent: null, ancestors: [] };
	// Section pages and registers sit under All accounts (the /sections index is retired, S1 RD7).
	const parent = first === 'sections' ? { label: LABELS.accounts!, href: '/accounts' } : { label, href: `/${first}` };
	let name = dataCrumb ?? second;
	if (!dataCrumb && first === 'sections') name = sectionLabel(second);
	else if (!dataCrumb && first === 'accounts') name = 'Account';
	if (first === 'accounts' && dataSection) return { name, parent: dataSection, ancestors: [parent, dataSection] };
	return { name, parent, ancestors: [parent] };
}

/** Document title: the page's name, then the app name. */
export function titleFor(pathname: string, dataCrumb?: string): string {
	return `${trailFor(pathname, dataCrumb).name} - Miserly`;
}
