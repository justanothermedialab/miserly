/**
 * App-wide keyboard accelerators (Q17). One place decides what a key means
 * outside a text field; QuickAdd.svelte's window listener calls `globalAccelerator` because it
 * owns Quick Add and the palette, and knows when another layer holds the keyboard.
 *
 *   Ctrl+Shift+N Quick Add (QuickAdd.svelte; bare N was dropped in item 2.5, below). Edge and Chrome
 *                keep it for InPrivate/incognito, so in a tab only the desktop app gets it (DIRECTION Q17).
 *   Ctrl+N       New: a page with its own "new" claims it through the cancelable `miserly:new`
 *                event (the register opens its entry row); otherwise Quick Add. Browsers keep
 *                Ctrl+N for a new window, so in a tab only the desktop app gets it.
 *   Ctrl+F       The page's search field (`data-page-search`), else the palette.
 *   Ctrl+Z       The visible Undo (`data-undo`) after a delete. In a text field, the field's own undo.
 *   F2           Edit the focused row (the register handles it; no single-letter row keys).
 *   Alt + letter Access keys (`accesskey`); the letters are underlined while Alt is held.
 */

/** True when the key goes to a control that takes typing (or picks from a list as you type). */
export function isTyping(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) return false;
	if (target.isContentEditable) return true;
	if (target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') return true;
	if (target.tagName === 'INPUT') {
		const type = (target as HTMLInputElement).type;
		return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file'].includes(type);
	}
	return target.getAttribute('role') === 'combobox';
}

/** Focus is inside a layer that owns its own keys (a dialog, menu, list, calendar, popover). */
function inLayer(target: EventTarget | null): boolean {
	return (
		target instanceof Element &&
		target.closest('[role=dialog], [role=alertdialog], [role=menu], [role=listbox], [role=grid], [data-popover-content]') !== null
	);
}

function visible(el: HTMLElement): boolean {
	return el.isConnected && (el.checkVisibility?.() ?? true);
}

export type AcceleratorHost = {
	quickAdd: () => void;
	palette: () => void;
	/** Another dialog, menu or list holds the keyboard: no accelerators. */
	blocked: () => boolean;
};

/** Handle an app-wide accelerator; returns true (and prevents the default) when it did. */
export function globalAccelerator(e: KeyboardEvent, host: AcceleratorHost): boolean {
	if (e.defaultPrevented || inLayer(e.target)) return false;
	const mod = e.ctrlKey || e.metaKey;
	const typing = isTyping(e.target);
	const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;

	// No bare N (item 2.5): focus rests on the page after a save or Esc, and a payee typed then
	// ("Namma Metro") opened Quick Add. Ctrl+N stays.
	if (mod && !e.altKey && !e.shiftKey && key === 'n') {
		if (host.blocked()) return false;
		e.preventDefault();
		const claim = new Event('miserly:new', { cancelable: true });
		if (window.dispatchEvent(claim)) host.quickAdd();
		return true;
	}
	if (mod && !e.altKey && !e.shiftKey && key === 'f') {
		if (host.blocked()) return false;
		e.preventDefault();
		const field = [...document.querySelectorAll<HTMLElement>('[data-page-search]')].find(visible);
		if (field) {
			field.focus();
			if (field instanceof HTMLInputElement) field.select();
		} else host.palette();
		return true;
	}
	if (mod && !e.altKey && !e.shiftKey && key === 'z') {
		if (typing || host.blocked()) return false;
		const undo = [...document.querySelectorAll<HTMLElement>('[data-undo]')].find(visible);
		if (!undo) return false;
		e.preventDefault();
		undo.click();
		return true;
	}
	return false;
}

/** Underline access-key letters while Alt is held, as Windows does (`<u class="ak">`). */
export function trackAltKey(): () => void {
	const root = document.documentElement;
	const down = (e: KeyboardEvent) => {
		if (e.key === 'Alt') root.dataset.alt = '';
	};
	const up = (e: KeyboardEvent) => {
		if (e.key === 'Alt' || !e.altKey) delete root.dataset.alt;
	};
	const clear = () => delete root.dataset.alt;
	window.addEventListener('keydown', down);
	window.addEventListener('keyup', up);
	window.addEventListener('blur', clear);
	return () => {
		window.removeEventListener('keydown', down);
		window.removeEventListener('keyup', up);
		window.removeEventListener('blur', clear);
		clear();
	};
}
