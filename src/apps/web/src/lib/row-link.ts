/**
 * `use:rowLink` on a table: a click anywhere on a row follows the row's own link,
 * as rows do in Gmail, Monarch and every banking app's lists. The link stays a real <a> (Tab,
 * Enter, middle-click); `data-row-link` marks it when a row holds more than one. Clicks on the
 * row's own controls, and a click that ends a text selection, are left alone.
 */
const CONTROLS = 'a, button, input, select, textarea, label, [role=checkbox], [role=combobox], [contenteditable]';

export function rowLink(node: HTMLElement) {
	node.dataset.rowlink = '';
	function onClick(e: MouseEvent) {
		if (e.defaultPrevented || e.button !== 0) return;
		const target = e.target as Element | null;
		if (!target || target.closest(CONTROLS)) return;
		if (window.getSelection()?.toString()) return;
		const tr = target.closest('tr');
		if (!tr || !node.contains(tr)) return;
		const link = tr.querySelector<HTMLAnchorElement>('a[data-row-link]') ?? tr.querySelector<HTMLAnchorElement>('a[href]');
		link?.click();
	}
	node.addEventListener('click', onClick);
	return {
		destroy() {
			node.removeEventListener('click', onClick);
		}
	};
}
