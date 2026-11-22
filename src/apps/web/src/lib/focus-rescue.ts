/**
 * Focus rescue: when the focused element is removed from the document (a message's
 * Undo or ✕, the bulk toolbar that unmounts after "Set category", a list item a Select or
 * menu takes away), land focus on `fallback()` instead of leaving it on <body>, where Tab and
 * F6 start again from the top of the window.
 *
 * Chrome sends no `focusout` for a removed element (the part 1 rescue listened for that and
 * never fired), so this tracks the last focused element with `focusin` and watches removals
 * with a MutationObserver. The check waits a frame, so a component that moves focus itself
 * (a dialog restoring it to its trigger, a row handing it to the next row) wins. An outside
 * click that closes a Select or menu counts too: it blurs the focused item to <body> first,
 * and the list is removed only after its close animation.
 *
 * Light dismiss (the focus part): a click outside an open popup only closes it, and on
 * Windows focus stays where it was (a ComboBox keeps it). A Select keeps focus on its trigger,
 * so the click on a non-focusable row blurred the trigger to <body>; put it back.
 */
const POPUP = '[data-slot=dropdown-menu-content], [data-slot=select-content], [data-popover-content]';

export function focusRescue(fallback: () => HTMLElement | null | undefined): () => void {
	let last: Element | null = null;
	let pending = false;
	let dismissing: Element | null = null;

	const onDown = () => {
		const a = document.activeElement;
		dismissing = a && a !== document.body && document.querySelector(POPUP) ? a : null;
	};
	const onOut = (e: FocusEvent) => {
		const t = e.target;
		if (e.relatedTarget || !dismissing || t !== dismissing) return;
		dismissing = null;
		requestAnimationFrame(() => {
			const a = document.activeElement;
			if (a && a !== document.body) return;
			if (t instanceof HTMLElement && t.isConnected) t.focus({ preventScroll: true });
			else fallback()?.focus({ preventScroll: true });
		});
	};

	const onIn = (e: FocusEvent) => {
		if (e.target instanceof Element && e.target !== document.body) last = e.target;
	};
	const check = () => {
		pending = false;
		if (!last || last.isConnected) return;
		last = null;
		const a = document.activeElement;
		if (a && a !== document.body) return;
		fallback()?.focus({ preventScroll: true });
	};
	const obs = new MutationObserver((records) => {
		if (pending || !last || last.isConnected) return;
		if (!records.some((r) => r.removedNodes.length)) return;
		pending = true;
		requestAnimationFrame(check);
	});

	document.addEventListener('focusin', onIn);
	document.addEventListener('focusout', onOut);
	document.addEventListener('pointerdown', onDown, true);
	obs.observe(document.body, { childList: true, subtree: true });
	return () => {
		document.removeEventListener('focusin', onIn);
		document.removeEventListener('focusout', onOut);
		document.removeEventListener('pointerdown', onDown, true);
		obs.disconnect();
	};
}
