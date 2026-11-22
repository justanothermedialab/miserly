/**
 * fluentScroll — a WinUI-style overlay scrollbar for the app's two main panes.
 *
 * Windows 11 apps (Settings, File Explorer) show a thin 2px indicator whenever the pointer
 * moves over a scrollable area or it scrolls, widen it into a full bar (track + arrows) when
 * the pointer reaches the right edge, and fade it out about 4s after the last movement.
 * Chromium's overlay bar only appears while scrolling or with the pointer on the bar itself,
 * so these panes hide the native bar and draw this one. Scrolling stays native (wheel, keys,
 * touch); the bar is aria-hidden and never takes focus.
 *
 * When Windows' "Always show scrollbars" is on, the desktop bridge says so and the pane keeps
 * the native always-visible bar instead (main.cjs, preload.cjs).
 */
import type { Action } from 'svelte/action';

const HIDE_AFTER = 4000; // WinUI's default auto-hide delay
const EDGE = 16; // width of the bar, and of the edge zone that widens it
const MIN_THUMB = 24;
const STEP = 48; // one arrow click
const BAR_PAD = 4; // the bar's 2px top + bottom padding (app.css)
const ARROWS = 28; // two 14px arrows when expanded (app.css)

type State = 'hidden' | 'indicator' | 'expanded';

export const fluentScroll: Action<HTMLElement> = (node) => {
	const bridge = (window as unknown as { miserlyDesktop?: { alwaysShowScrollbars?: boolean } })
		.miserlyDesktop;
	const parent = node.parentElement;
	if (bridge?.alwaysShowScrollbars || !parent) return;
	if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
	node.classList.add('fluent-scroll');

	const bar = document.createElement('div');
	bar.className = 'fluent-scrollbar';
	bar.dataset.state = 'hidden';
	bar.setAttribute('aria-hidden', 'true');
	const up = document.createElement('div');
	up.className = 'fs-arrow fs-up';
	const track = document.createElement('div');
	track.className = 'fs-track';
	const thumb = document.createElement('div');
	thumb.className = 'fs-thumb';
	const down = document.createElement('div');
	down.className = 'fs-arrow fs-down';
	track.append(thumb);
	bar.append(up, track, down);
	parent.insertBefore(bar, node.nextSibling);

	let state: State = 'hidden';
	let timer: ReturnType<typeof setTimeout> | undefined;
	let onBar = false;
	let drag: { y: number; top: number; ratio: number } | null = null;

	const scrollable = () => node.scrollHeight > node.clientHeight + 1;

	function place() {
		const pr = parent!.getBoundingClientRect();
		const nr = node.getBoundingClientRect();
		bar.style.top = `${nr.top - pr.top - parent!.clientTop}px`;
		bar.style.left = `${nr.left - pr.left - parent!.clientLeft + node.clientWidth - EDGE}px`;
		bar.style.height = `${node.clientHeight}px`;
		// The track's height from the target state, not the live one: the arrows grow over
		// 150 ms when the bar expands, so the live height would size the thumb 28px too tall.
		const trackH = Math.max(0, node.clientHeight - BAR_PAD - (state === 'expanded' ? ARROWS : 0));
		const range = node.scrollHeight - node.clientHeight;
		const thumbH = Math.min(trackH, Math.max(MIN_THUMB, (trackH * node.clientHeight) / node.scrollHeight));
		const top = range > 0 ? ((trackH - thumbH) * node.scrollTop) / range : 0;
		thumb.style.height = `${thumbH}px`;
		thumb.style.transform = `translateY(${top}px)`;
	}

	function set(next: State) {
		if (next !== 'hidden' && !scrollable()) next = 'hidden';
		state = next;
		bar.dataset.state = next;
		if (next !== 'hidden') place();
	}

	function armHide() {
		clearTimeout(timer);
		timer = setTimeout(() => {
			if (!drag && !onBar) set('hidden');
		}, HIDE_AFTER);
	}

	function onMove(e: PointerEvent) {
		if (e.pointerType === 'touch') return;
		const nearEdge = e.clientX >= node.getBoundingClientRect().right - EDGE;
		set(nearEdge ? 'expanded' : 'indicator');
		armHide();
	}
	function onScroll() {
		if (state === 'hidden') set('indicator');
		else place();
		armHide();
	}
	function onBarEnter() {
		onBar = true;
		clearTimeout(timer);
	}
	function onBarLeave() {
		onBar = false;
		if (!drag) {
			set('indicator');
			armHide();
		}
	}
	function onThumbDown(e: PointerEvent) {
		e.preventDefault();
		e.stopPropagation();
		const travel = track.clientHeight - thumb.offsetHeight;
		const range = node.scrollHeight - node.clientHeight;
		drag = { y: e.clientY, top: node.scrollTop, ratio: travel > 0 ? range / travel : 0 };
		thumb.setPointerCapture?.(e.pointerId);
		thumb.dataset.dragging = '';
	}
	function onThumbMove(e: PointerEvent) {
		if (!drag) return;
		node.scrollTop = drag.top + (e.clientY - drag.y) * drag.ratio;
	}
	function onThumbUp(e: PointerEvent) {
		if (!drag) return;
		drag = null;
		thumb.releasePointerCapture?.(e.pointerId);
		delete thumb.dataset.dragging;
		if (!onBar) set('indicator');
		armHide();
	}
	function onTrackDown(e: PointerEvent) {
		if (e.target !== track) return;
		e.preventDefault();
		const above = e.clientY < thumb.getBoundingClientRect().top;
		node.scrollBy({ top: (above ? -1 : 1) * node.clientHeight * 0.9 });
	}
	const arrow = (dir: number) => (e: PointerEvent) => {
		e.preventDefault();
		node.scrollBy({ top: dir * STEP });
	};
	const onUp = arrow(-1);
	const onDown = arrow(1);
	const onResize = () => {
		if (state !== 'hidden') set(state);
	};

	// The pane can change size or move without the window resizing (pane collapse,
	// overlay, an entry row opening, content loading). When its width or left edge changes,
	// hide the bar at once, with no fade at the old spot (WinUI hides the indicator on layout
	// changes); otherwise keep the bar and thumb in step with the new size. The coordinates are
	// refreshed either way, so the next pointer move shows the bar where it belongs.
	let lastW = -1;
	let lastX = -1;
	function onLayout() {
		const r = node.getBoundingClientRect();
		const moved = lastW >= 0 && (Math.abs(r.width - lastW) > 0.5 || Math.abs(r.left - lastX) > 0.5);
		lastW = r.width;
		lastX = r.left;
		// A width / position change, or content that no longer scrolls: hide at once, with no
		// fade left behind.
		if (state !== 'hidden' && !drag && (moved || !scrollable())) {
			bar.dataset.instant = '';
			set('hidden');
			requestAnimationFrame(() => delete bar.dataset.instant);
		}
		place();
	}
	const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(onLayout);
	const watchChildren = () => {
		for (const c of node.children) ro?.observe(c);
	};
	ro?.observe(node);
	ro?.observe(parent);
	watchChildren();
	const mo = typeof MutationObserver === 'undefined' ? null : new MutationObserver(watchChildren);
	mo?.observe(node, { childList: true });

	node.addEventListener('pointermove', onMove);
	node.addEventListener('scroll', onScroll, { passive: true });
	bar.addEventListener('pointerenter', onBarEnter);
	bar.addEventListener('pointerleave', onBarLeave);
	thumb.addEventListener('pointerdown', onThumbDown);
	thumb.addEventListener('pointermove', onThumbMove);
	thumb.addEventListener('pointerup', onThumbUp);
	thumb.addEventListener('pointercancel', onThumbUp);
	track.addEventListener('pointerdown', onTrackDown);
	up.addEventListener('pointerdown', onUp);
	down.addEventListener('pointerdown', onDown);
	window.addEventListener('resize', onResize);

	return {
		destroy() {
			clearTimeout(timer);
			ro?.disconnect();
			mo?.disconnect();
			node.removeEventListener('pointermove', onMove);
			node.removeEventListener('scroll', onScroll);
			window.removeEventListener('resize', onResize);
			node.classList.remove('fluent-scroll');
			bar.remove();
		}
	};
};
