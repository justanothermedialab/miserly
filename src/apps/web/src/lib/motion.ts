/**
 * Motion shared by components (app.css holds the tokens: --motion-*, --ease-*).
 *
 * `foldIn` / `foldOut`: things that open inline never jump:
 * the space opens and closes over 167 ms, the content fading with it, so what sits below glides. The
 * curve is --ease-point (an element on screen moving to a new place), not the enter / leave pair:
 * those put half the move in the first or last ~20 ms, which the rows below showed as a snap.
 * Sidebar groups, the dashboard's shared breakdown, Set split, StatusBar, the New payee row. None
 * with reduced motion.
 *
 * `flyoutMotion`: a Popover's open and close, the same as menus and selects (167 in, 83 out).
 */
import type { TransitionConfig } from 'svelte/transition';

export const reducedMotion = (): boolean =>
	typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** A CSS cubic-bezier(x1, y1, x2, y2) as an easing function (Newton's method, then bisection). */
function bezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
	const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
	const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
	const x = (t: number) => ((ax * t + bx) * t + cx) * t;
	const dx = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
	const y = (t: number) => ((ay * t + by) * t + cy) * t;
	return (p: number) => {
		if (p <= 0) return 0;
		if (p >= 1) return 1;
		let t = p;
		for (let i = 0; i < 8; i++) {
			const e = x(t) - p;
			if (Math.abs(e) < 1e-5) return y(t);
			const d = dx(t);
			if (Math.abs(d) < 1e-6) break;
			t -= e / d;
		}
		let lo = 0, hi = 1;
		t = p;
		for (let i = 0; i < 30; i++) {
			const v = x(t);
			if (Math.abs(v - p) < 1e-5) break;
			if (v < p) lo = t;
			else hi = t;
			t = (lo + hi) / 2;
		}
		return y(t);
	};
}
/** --ease-decelerate, --ease-accelerate and --ease-point (app.css). */
export const decelerate = bezier(0, 0, 0, 1);
export const accelerate = bezier(1, 0, 1, 1);
export const point = bezier(0.55, 0.55, 0, 1);

function fold(node: Element, duration: number, easing: (t: number) => number): TransitionConfig {
	const s = getComputedStyle(node);
	const px = (v: string) => parseFloat(v) || 0;
	const box = {
		height: px(s.height),
		'padding-top': px(s.paddingTop),
		'padding-bottom': px(s.paddingBottom),
		'margin-top': px(s.marginTop),
		'margin-bottom': px(s.marginBottom),
		'border-top-width': px(s.borderTopWidth),
		'border-bottom-width': px(s.borderBottomWidth)
	};
	const opacity = px(s.opacity) || 1;
	return {
		duration: reducedMotion() ? 0 : duration,
		easing,
		css: (t) =>
			// min-height 0: a StatusBar's min-h-8 held it at 32 px, then it vanished at the end.
			`overflow:clip;box-sizing:border-box;min-height:0;opacity:${t * opacity};` +
			Object.entries(box)
				.map(([k, v]) => `${k}:${t * v}px`)
				.join(';')
	};
}
export const foldIn = (node: Element): TransitionConfig => fold(node, 167, point);
export const foldOut = (node: Element): TransitionConfig => fold(node, 167, point);

export const flyoutMotion =
	'data-open:animate-in data-open:fade-in-0 data-open:motion-fast data-open:ease-decelerate data-closed:animate-out data-closed:fade-out-0 data-closed:motion-faster data-closed:ease-linear data-[side=bottom]:slide-in-from-top-2 data-[side=top]:slide-in-from-bottom-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2';
