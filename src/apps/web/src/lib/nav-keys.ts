/**
 * Keyboard for the navigation pane's item list, the WinUI NavigationView way: Up and
 * Down move focus between items, Space opens the focused one. Left to the browser, both keys
 * scrolled the pane instead, so on a short window the focused item slid up under the pane's
 * header and out of sight. Moving focus with `focus()` scrolls the next item into view.
 * A section item is a button that folds its group: Right unfolds it, Left folds
 * it, and Space and Enter are the button's own.
 */
const ITEMS = 'a[href], button[data-section-toggle]';

export function navListKeys(e: KeyboardEvent): void {
	if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
	const t = e.target;
	const section = t instanceof HTMLButtonElement && t.dataset.sectionToggle !== undefined;
	if (!(t instanceof HTMLAnchorElement) && !section) return;
	if (e.key === ' ' && !section) {
		e.preventDefault();
		t.click();
		return;
	}
	if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && section) {
		e.preventDefault();
		if ((t.getAttribute('aria-expanded') === 'true') !== (e.key === 'ArrowRight')) t.click();
		return;
	}
	if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
	const list = e.currentTarget as HTMLElement;
	// Skip items the rail hides (checkVisibility is absent in jsdom: keep them all there).
	const items = [...list.querySelectorAll<HTMLElement>(ITEMS)].filter((a) => a.checkVisibility?.() ?? true);
	const i = items.indexOf(t);
	const next = items[i + (e.key === 'ArrowDown' ? 1 : -1)];
	e.preventDefault();
	next?.focus();
}

/** Svelte action: `use:navKeys` on the pane's scrolling item list. */
export function navKeys(node: HTMLElement): { destroy: () => void } {
	node.addEventListener('keydown', navListKeys);
	return { destroy: () => node.removeEventListener('keydown', navListKeys) };
}
