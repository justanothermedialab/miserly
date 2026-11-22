/**
 * jsdom has no Web Animations: Svelte transitions (lib/motion's foldIn / foldOut) call element.animate.
 * This stand-in finishes on the next task, so a component's in/out blocks mount and unmount as they
 * do in a browser once the motion ends.
 */
if (typeof Element !== 'undefined' && !Element.prototype.animate) {
	Element.prototype.animate = function () {
		const a = {
			currentTime: 0,
			onfinish: null as null | (() => void),
			cancel() {},
			finished: Promise.resolve()
		};
		setTimeout(() => a.onfinish?.(), 0);
		return a as unknown as Animation;
	};
}
