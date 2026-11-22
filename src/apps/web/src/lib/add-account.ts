/**
 * Open the Add account dialog over the current page. Every "Add account"
 * (sidebar, All accounts, a section page, the first-run card, Ctrl K, Quick Add with no
 * account) calls this; `?add=1&type=…` on any URL opens it too, for links.
 */
export const ADD_ACCOUNT_EVENT = 'miserly:addaccount';

export function openAddAccount(type?: string): void {
	window.dispatchEvent(new CustomEvent(ADD_ACCOUNT_EVENT, { detail: { type } }));
}
