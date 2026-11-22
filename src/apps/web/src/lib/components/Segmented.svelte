<!--
	Segmented — the ONE canonical segmented control. Built on the Bits UI
	ToggleGroup primitive (the locked D10 stack — the same primitive shadcn-svelte's
	ToggleGroup wraps), so it gets real segmented-control keyboard semantics
	(roving focus + arrow-key navigation between segments) for free. Styled to the
	prototype `.seg` look: a bordered pill-group whose active segment fills with the
	brand accent.

	Single-select and ALWAYS one selected: it's controlled (value + onValueChange
	guard), so re-clicking the active segment can't clear the selection (Bits'
	default deselect-on-reclick is suppressed) — correct for view-switches like
	Mine/Shared, By class/By liquidity, Out/In, number format, theme.

	Instant by design (no Save step — segmented-control best practice): bind the
	value, or pass `onChange` to react/persist immediately.
-->
<script lang="ts" generics="T extends string">
	import { ToggleGroup } from 'bits-ui';
	import { tick, untrack } from 'svelte';

	let {
		options,
		value = $bindable(),
		size = 'md',
		ariaLabel,
		onChange
	}: {
		/** `accessKey`: an Alt+letter access key; the letter must occur in the label. */
		options: { value: T; label: string; accessKey?: string }[];
		value: T;
		size?: 'sm' | 'md';
		ariaLabel?: string;
		onChange?: (value: T) => void;
	} = $props();

	// Exact mock `.selbar button` padding: 6px 13px; the small header variant is 5px 11px.
	// sm is 32 px (Fluent's control height), not 28: with 4 px under the text Inter's descenders (g, p)
	// touched the marker even after it was lowered (seen on the exe).
	const pad = $derived(size === 'sm' ? 'px-3 py-1.5 text-body' : 'px-3 py-2 text-body');
	// The selected marker sits under the text, clear of its descenders: on the small size it is lower
	// and thinner (it struck through "Light" and "lakh / crore").
	const mark = $derived(size === 'sm' ? 'after:bottom-px after:h-0.5' : 'after:bottom-0.75 after:h-0.75');

	/** Split a label around its access-key letter (first occurrence, any case). */
	function akParts(label: string, key?: string): [string, string, string] | null {
		if (!key) return null;
		const i = label.toLowerCase().indexOf(key.toLowerCase());
		return i < 0 ? null : [label.slice(0, i), label.charAt(i), label.slice(i + 1)];
	}

	// What Bits shows as pressed. Bits 2 emits '' (not undefined) when the active segment is
	// clicked again; the old guard let that through, so a second click on the selected theme
	// posted theme "" (400) and blanked the choice (hunt walk).
	let pressed = $state<string>(untrack(() => value));
	$effect.pre(() => {
		pressed = value;
	});
	function handle(next: string | undefined): void {
		// Deselect guard: a segmented control always keeps exactly one selection.
		if (!next || next === value) {
			pressed = value;
			return;
		}
		value = next as T;
		onChange?.(next as T);
	}

	// The selection slides (Fluent's TabList, Windows' SelectorBar): one indicator, the fill and the
	// underline, moves to the chosen segment in 250 ms on Windows' point-to-point curve (visual checks
	// M8; the fill used to jump while the text faded). Until it's measured (the server
	// render, the first frame) the selected segment draws its own fill, so nothing flashes.
	let rootEl = $state<HTMLElement | null>(null);
	let ind = $state<{ x: number; w: number } | null>(null);
	let glide = $state(false);
	function place() {
		const on = rootEl?.querySelector<HTMLElement>('[data-state="on"]');
		if (on && (on.offsetLeft !== ind?.x || on.offsetWidth !== ind?.w)) ind = { x: on.offsetLeft, w: on.offsetWidth };
	}
	$effect(() => {
		void value;
		if (!rootEl) return;
		// Read without tracking: place() writes ind, and tracking it re-ran this forever.
		const first = untrack(() => ind === null);
		void tick().then(() => {
			place();
			if (first) requestAnimationFrame(() => (glide = true));
		});
	});
	$effect(() => {
		if (!rootEl || typeof ResizeObserver === 'undefined') return;
		const ro = new ResizeObserver(() => place());
		ro.observe(rootEl);
		return () => ro.disconnect();
	});
</script>

<!-- Fluent SelectorBar: a veil track; the active segment gets a subtle fill + a
     centred gold underline (::after), NOT a solid gold pill (white-on-gold fails AA). -->
<ToggleGroup.Root
	type="single"
	bind:ref={rootEl}
	bind:value={pressed}
	onValueChange={handle}
	aria-label={ariaLabel}
	class="relative inline-flex gap-0.5 rounded-control border border-border bg-card-2 p-0.75"
>
	{#if ind}
		<span
			aria-hidden="true"
			class="pointer-events-none absolute inset-y-0.75 left-0 rounded-control bg-card shadow-[0_1px_2px_rgba(0,0,0,0.06)] dark:bg-control-hover dark:shadow-none {mark} after:absolute after:left-1/2 after:w-4 after:-translate-x-1/2 after:rounded-full after:bg-brand-mark after:content-[''] {glide ? 'transition-[translate,width] motion-normal ease-point' : ''}"
			style="width:{ind.w}px;translate:{ind.x}px 0"
		></span>
	{/if}
	{#each options as o (o.value)}
		<ToggleGroup.Item
			value={o.value}
			accesskey={o.accessKey}
			class="relative cursor-pointer rounded-control border-0 bg-transparent font-normal transition-colors {pad} {value ===
			o.value
				? ind
					? 'text-foreground'
					: `${mark} text-foreground bg-card shadow-[0_1px_2px_rgba(0,0,0,0.06)] dark:bg-control-hover dark:shadow-none after:absolute after:left-1/2 after:w-4 after:-translate-x-1/2 after:rounded-full after:bg-brand-mark after:content-['']`
				: 'text-text-muted hover:bg-control hover:text-foreground'} focus-visible:z-10"
		>
			{#if akParts(o.label, o.accessKey)}{@const [a, k, b] = akParts(o.label, o.accessKey)!}{a}<u class="ak">{k}</u>{b}{:else}{o.label}{/if}
		</ToggleGroup.Item>
	{/each}
</ToggleGroup.Root>
