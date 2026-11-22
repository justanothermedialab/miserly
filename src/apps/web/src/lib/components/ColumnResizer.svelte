<!--
	ColumnResizer — the right edge of a table heading: a drag sets the column's width, a double-click
	fits it to its text again (columns.svelte.ts; Apple's macOS "Let people resize columns", Fluent's
	resizable Table columns). The heading must be `position: relative`. Pointer only: the fitted
	widths already show each column's text, and the keyboard's Tab order stays the grid's.
-->
<script lang="ts">
	import type { ColumnWidths } from '$lib/register/columns.svelte';

	let { cols, id, label }: { cols: ColumnWidths; id: string; label: string } = $props();
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<span
	class="col-resize"
	title={`Drag to resize ${label}. Double-click to fit`}
	onpointerdown={(e) => cols.startResize(e, id)}
	ondblclick={(e) => {
		e.stopPropagation();
		cols.reset(id);
	}}
></span>

<style>
	/* An 8 px target at the heading's right edge, inside it (headings clip, so a target past the edge
	   lost its outer half to the next heading); a 2 px line shows on hover and while dragging. */
	.col-resize {
		position: absolute;
		top: 0;
		right: 0;
		z-index: 1;
		width: 8px;
		height: 100%;
		cursor: col-resize;
		touch-action: none;
	}
	.col-resize::after {
		content: '';
		position: absolute;
		top: 6px;
		bottom: 6px;
		right: 0;
		width: 2px;
		border-radius: 1px;
		background: transparent;
		transition: background-color var(--duration-fast, 83ms);
	}
	.col-resize:hover::after,
	.col-resize:active::after {
		background: var(--border-strong);
	}
</style>
