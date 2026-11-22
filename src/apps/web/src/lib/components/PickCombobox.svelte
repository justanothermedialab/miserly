<!--
	PickCombobox — a field you type into to pick one item from a fixed list (a category, an
	account), as Actual's category cell: focus shows the whole list with the current item
	highlighted, typing filters it and highlights the best match, Tab or Enter takes the
	highlighted item, a click on an item takes it. Typing that matches nothing reverts on Tab or
	blur (a category can't be invented here; Categories creates them). Letters always go into the
	field, so typing on it can never reach a page or app key (ACTUAL-PARITY #3, #11).
	The value is the item's id, posted under `name` from a hidden input. The list floats like
	PayeeCombobox's (fixed strategy, not portaled, so it stays inside a host dialog).
-->
<script lang="ts" module>
	import { flyoutMotion } from '$lib/motion';
	/** `picked`: what the field shows once the item is taken, when it differs from the list's line
	 *  ("HDFC" under its Mutual funds heading, "HDFC (Mutual funds)" in the field). */
	export type PickOption = { value: string; label: string; group?: string; picked?: string };
	/** How an item was taken: by key (the host may move on) or by a click. */
	export type PickHow = 'Enter' | 'Tab' | 'click';
</script>

<script lang="ts">
	import { Popover } from 'bits-ui';
	import { ChevronDown } from '@lucide/svelte';
	import { tick } from 'svelte';
	import { cn, selectFromStart } from '$lib/utils';

	let {
		value = $bindable(''),
		options,
		name = undefined,
		id = undefined,
		placeholder = undefined,
		'aria-label': ariaLabel = undefined,
		class: className = '',
		inputClass = '',
		inputRef = $bindable(null),
		openOnFocus = true,
		onpick = undefined,
		onkeydown = undefined,
		onblur = undefined
	}: {
		value?: string;
		options: PickOption[];
		name?: string;
		id?: string;
		placeholder?: string;
		'aria-label'?: string;
		class?: string;
		inputClass?: string;
		inputRef?: HTMLInputElement | null;
		/** The list opens when the field gets focus (a register cell, Actual); false: only on a click
		 *  or typing (a dialog, where a list opened by Tab covered the next fields and took the
		 *  click meant for them). */
		openOnFocus?: boolean;
		/** An item was taken (Enter, Tab or a click); `value` is already updated. */
		onpick?: (v: string, how: PickHow) => void;
		/** Keys the list didn't consume, and Tab after it picked (the host moves focus). */
		onkeydown?: (e: KeyboardEvent) => void;
		onblur?: () => void;
	} = $props();

	const uid = $props.id();
	const listId = `pick-list-${uid}`;
	let open = $state(false);
	let pointerDown = false;
	let active = $state(-1);
	let focused = $state(false);
	// What the field shows: the current item's label, or what is being typed.
	let text = $state('');
	let dirty = $state(false);

	const shown = (o: PickOption) => o.picked ?? o.label;
	const labelOf = (v: string) => {
		const o = options.find((x) => x.value === v);
		return o ? shown(o) : '';
	};
	// Not typing: the field follows the value (a payee's remembered category fills it in).
	$effect(() => {
		const l = labelOf(value);
		if (!focused || !dirty) text = l;
	});

	function rank(label: string, q: string): number {
		const l = label.toLowerCase();
		if (l === q) return 0;
		if (l.startsWith(q)) return 1;
		if (l.split(/[\s&/(-]+/u).some((w) => w.startsWith(q))) return 2;
		return 3;
	}
	const matches = $derived.by(() => {
		const q = text.trim().toLowerCase();
		if (!dirty || q === '') return options;
		return options
			.map((o, i) => ({ o, i, r: rank(o.label, q) }))
			.filter((x) => x.r < 3 || x.o.label.toLowerCase().includes(q))
			.sort((a, b) => a.r - b.r || a.i - b.i)
			.map((x) => x.o);
	});

	function take(o: PickOption, how: PickHow) {
		value = o.value;
		text = shown(o);
		dirty = false;
		open = false;
		active = -1;
		// Still in the field (a click): its start in view, not the end of a long label.
		void tick().then(() => {
			if (inputRef && document.activeElement === inputRef) selectFromStart(inputRef);
		});
		onpick?.(o.value, how);
	}
	function revert() {
		text = labelOf(value);
		dirty = false;
		open = false;
		active = -1;
	}

	function showAll() {
		dirty = false;
		text = labelOf(value);
		open = true;
		active = options.findIndex((o) => o.value === value);
	}

	function keydown(e: KeyboardEvent) {
		if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			e.preventDefault();
			e.stopPropagation();
			if (!open) {
				showAll();
				return;
			}
			active =
				e.key === 'ArrowDown' ? Math.min(active + 1, matches.length - 1) : Math.max(active - 1, 0);
			return;
		}
		// Enter on the list as it opened (nothing typed) is the host's: save the row, or go down.
		if (e.key === 'Enter' && open && !dirty) {
			open = false;
			onkeydown?.(e);
			return;
		}
		if (e.key === 'Enter' && open && matches[active] !== undefined) {
			e.preventDefault();
			e.stopPropagation();
			take(matches[active]!, 'Enter');
			return;
		}
		if (e.key === 'Tab') {
			// Tab takes the highlighted item (typed text that matched nothing reverts), then
			// carries on to the host, which moves focus (Actual's category cell).
			if (dirty && matches[active] !== undefined) take(matches[active]!, 'Tab');
			else if (dirty && text.trim() === '' && options.some((o) => o.value === '')) take(options.find((o) => o.value === '')!, 'Tab');
			else revert();
			onkeydown?.(e);
			return;
		}
		if (e.key === 'Escape' && open && dirty) {
			// First Esc drops what was typed; the next one is the host's (cancel the edit).
			e.preventDefault();
			e.stopPropagation();
			revert();
			return;
		}
		if (e.key === 'Escape' && open) {
			// An open list closes first; the next Esc is the host's (an entry row's Esc discarded
			// the whole row when the list had just opened on focus).
			e.preventDefault();
			e.stopPropagation();
			open = false;
			return;
		}
		onkeydown?.(e);
	}

	// Keep the highlighted item in view as the arrows move it.
	$effect(() => {
		if (!open || active < 0) return;
		document.getElementById(`${listId}-${active}`)?.scrollIntoView?.({ block: 'nearest' });
	});

	// Group headings between items (the list is in group order; a filtered list keeps it).
	const rows = $derived.by(() => {
		const out: ({ heading: string } | { o: PickOption; i: number })[] = [];
		let last: string | undefined;
		matches.forEach((o, i) => {
			if (o.group && o.group !== last) out.push({ heading: o.group });
			last = o.group;
			out.push({ o, i });
		});
		return out;
	});
</script>

<span data-slot="pick-combobox" class={cn('relative inline-flex w-full min-w-0', className)}>
	{#if name}<input type="hidden" {name} {value} />{/if}
	<input
		bind:this={inputRef}
		{id}
		{placeholder}
		type="text"
		role="combobox"
		autocomplete="off"
		spellcheck="false"
		aria-label={ariaLabel}
		aria-autocomplete="list"
		aria-expanded={open && matches.length > 0}
		aria-controls={listId}
		aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
		bind:value={text}
		oninput={() => {
			dirty = true;
			open = true;
			active = matches.length > 0 ? 0 : -1;
		}}
		onfocus={(e) => {
			focused = true;
			if (openOnFocus || pointerDown) showAll();
			pointerDown = false;
			selectFromStart(e.currentTarget as HTMLInputElement);
		}}
		onmousedown={() => {
			pointerDown = true;
			// A click on the focused field brings the full list back.
			if (focused && !open) showAll();
		}}
		onblur={() => {
			focused = false;
			// Clicking away keeps an exact match typed in full; anything else reverts.
			const exact = dirty ? options.find((o) => [o.label, shown(o)].some((l) => l.toLowerCase() === text.trim().toLowerCase())) : undefined;
			if (exact) {
				value = exact.value;
				text = shown(exact);
				dirty = false;
				open = false;
			} else revert();
			onblur?.();
		}}
		onkeydown={keydown}
		class={cn(
			'h-8 w-full min-w-0 truncate rounded-control border border-input border-b-border-strong bg-surface pr-7 pl-2.5 text-body outline-none transition-colors placeholder:text-text-muted focus:border-b-brand focus:shadow-[inset_0_-1px_0_var(--accent)]',
			inputClass
		)}
	/>
	<ChevronDown size={14} aria-hidden="true" class="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-text-muted" />
	<Popover.Root
		open={open && matches.length > 0}
		onOpenChange={(o) => {
			if (!o) open = false;
		}}
	>
		<Popover.Content
			customAnchor={inputRef}
			strategy="fixed"
			side="bottom"
			align="start"
			sideOffset={4}
			collisionPadding={8}
			trapFocus={false}
			onOpenAutoFocus={(e) => e.preventDefault()}
			onCloseAutoFocus={(e) => e.preventDefault()}
			onInteractOutside={(e) => {
				// The field itself is outside the list: a click on it is the field's, not a close.
				if (e.target === inputRef) e.preventDefault();
			}}
			class="z-[60] w-(--bits-popover-anchor-width) min-w-50 outline-none {flyoutMotion}"
		>
			<!-- A press anywhere on the list (its scrollbar, a heading, the padding) keeps focus in the
			     field: the field's blur reverted the pick and closed the editor. -->
			<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
			<ul
				id={listId}
				role="listbox"
				tabindex="-1"
				aria-label={ariaLabel}
				onmousedown={(e) => e.preventDefault()}
				class="max-h-[min(18rem,var(--bits-popover-content-available-height))] overflow-auto rounded-overlay border border-border bg-popover p-1 text-popover-foreground shadow-[var(--shadow-pop)]"
			>
				{#each rows as row, k (k)}
					{#if 'heading' in row}
						<li role="presentation" class="px-2 pt-2 pb-0.5 text-caption font-normal text-text-muted">{row.heading}</li>
					{:else}
						<!-- Pointer pick uses mousedown so the input's blur doesn't revert it first. -->
						<li
							id={`${listId}-${row.i}`}
							role="option"
							aria-selected={row.i === active}
							class="cursor-default truncate rounded-control px-2 py-1.5 text-body {row.i === active ? 'bg-control-hover' : 'hover:bg-control-hover'}"
							onmousedown={(e) => {
								e.preventDefault();
								take(row.o, 'click');
							}}
						>
							{row.o.label}
						</li>
					{/if}
				{/each}
			</ul>
		</Popover.Content>
	</Popover.Root>
</span>
