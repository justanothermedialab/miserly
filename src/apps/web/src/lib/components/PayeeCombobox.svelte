<!--
	PayeeCombobox — the ONE payee input (DL-20; replaces the native <datalist>, whose
	popup is OS-drawn and un-themeable). ARIA 1.2 combobox with list autocomplete:
	free text is allowed (a new payee is created on save), ↑/↓ move through the
	matches, Esc closes the list. As in Actual, typing highlights the best match (an exact
	name, then names starting with it, then the most used: `options` come most used first)
	and Tab or Enter takes it, so "Swigg" + Tab is Swiggy, not a new payee "Swigg"
	(ACTUAL-PARITY #2). A typed name that isn't an exact match also gets a "Create payee"
	item at the top, one ↑ away. When nothing is highlighted Enter falls through, so the
	surrounding form still submits.
	The list floats on Bits positioning anchored to the input (fixed strategy, not portaled,
	so it stays inside a host dialog): it flips up on the last register row and shrinks to
	the room available instead of being clipped by the scroll pane. Focus never
	leaves the input; keys are handled there. The list is out of the Tab order (tabindex -1):
	Chrome makes a scrolling list keyboard-focusable, and Tab landed on it as it closed.
	): the accounts come as their own lines under a heading per section
	("Transfer: Bank", "Transfer: Mutual funds"; the payees under "Payees"), each carrying its
	account id. Picking one puts "Transfer → HDFC" in the field and its id in `transferAccountId`
	(posted under `transferAccountName` in a form), so two accounts of one name are never confused;
	typing in the field clears the id.
-->
<script lang="ts">
	import { flyoutMotion } from '$lib/motion';
	import { Popover } from 'bits-ui';
	import { tick } from 'svelte';
	import { cn, selectFromStart } from '$lib/utils';
	import type { PayeeOption } from '$lib/transfer-targets';
	import { TEXT_LIMITS } from '$lib/text-limits';

	let {
		value = $bindable(''),
		options,
		name = undefined,
		id = undefined,
		placeholder = undefined,
		required = false,
		'aria-label': ariaLabel = undefined,
		class: className = '',
		inputRef = $bindable(null),
		transferAccountId = $bindable(''),
		transferAccountName = undefined,
		openOnFocus = true,
		onchange = undefined,
		onpick = undefined,
		onkeydown = undefined,
		onblur = undefined
	}: {
		value?: string;
		/** Payees as plain names; the accounts to transfer to as grouped lines with their id. */
		options: readonly (string | PayeeOption)[];
		name?: string;
		id?: string;
		placeholder?: string;
		required?: boolean;
		'aria-label'?: string;
		class?: string;
		inputRef?: HTMLInputElement | null;
		/** The account id of the transfer line picked ('' for a payee or typed text). */
		transferAccountId?: string;
		/** Posts `transferAccountId` in a form under this name. */
		transferAccountName?: string;
		/** The list opens when the field gets focus (a register cell, Actual); false: only on a click
		 *  or typing (a dialog, where a list opened by Tab covered the next fields and took the
		 *  click meant for them). */
		openOnFocus?: boolean;
		/** A payee was picked from the list, or the field lost focus (native `change`). */
		onchange?: (v: string) => void;
		/** A payee was clicked in the list (a register cell saves it at once, as a category click does);
		 *  `accountId` is the transfer line's account. */
		onpick?: (v: string, accountId: string) => void;
		onkeydown?: (e: KeyboardEvent) => void;
		onblur?: () => void;
	} = $props();

	const uid = $props.id();
	const listId = `payee-list-${uid}`;
	let open = $state(false);
	let pointerDown = false;
	let active = $state(-1);

	type Item = { label: string; value: string; group?: string; accountId?: string; create?: true };
	const items = $derived(options.map((o): Item => (typeof o === 'string' ? { label: o, value: o } : o)));
	// With transfer lines the payees get a heading of their own (Actual's "Payees").
	const grouped = $derived(items.some((i) => i.group));
	function rank(label: string, q: string): number {
		const l = label.toLowerCase();
		if (l === q) return 0;
		if (l.startsWith(q)) return 1;
		if (l.split(/[\s&/(-]+/u).some((w) => w.startsWith(q))) return 2;
		return 3;
	}
	const typed = $derived(value.trim());
	// The list opens on focus showing every payee (Actual); typing filters it.
	let filtering = $state(false);
	const payeeItems = $derived(items.filter((i) => !i.accountId));
	const transferItems = $derived(items.filter((i) => i.accountId));
	const matches = $derived.by((): Item[] => {
		const q = filtering ? typed.toLowerCase() : '';
		if (q === '') return filtering ? [...payeeItems.slice(0, 8), ...transferItems] : [...payeeItems, ...transferItems];
		// Payees: exact, then starts with, then a word starting with it, then anywhere; ties keep the
		// caller's order (most used first). Capped at 8. Then every account matching, under its
		// section's heading in the sidebar's order, by its name or by "Transfer → name".
		const hit = (i: Item) => rank(i.label, q) < 3 || i.label.toLowerCase().includes(q) || i.value.toLowerCase().startsWith(q);
		const payees = payeeItems
			.map((o, i) => ({ o, i, r: rank(o.label, q) }))
			.filter((x) => x.r < 3 || x.o.label.toLowerCase().includes(q))
			.sort((a, b) => a.r - b.r || a.i - b.i)
			.slice(0, 8)
			.map((x) => x.o);
		const found = [...payees, ...transferItems.filter(hit)];
		const exact = found.some((f) => f.value.toLowerCase() === q);
		return exact ? found : [{ label: typed, value: typed, create: true }, ...found];
	});

	function choose(item: Item) {
		value = item.create ? typed : item.value;
		transferAccountId = item.accountId ?? '';
		open = false;
		active = -1;
		// Still in the field: "Transfer → HDFC (Mutual funds)" shows from its start.
		void tick().then(() => {
			if (inputRef && document.activeElement === inputRef) selectFromStart(inputRef);
		});
		onchange?.(value);
	}

	// Headings between items: "Payees", then one per section of accounts (the list keeps its order).
	const rows = $derived.by(() => {
		const out: ({ heading: string } | { m: Item; i: number })[] = [];
		let last: string | undefined;
		matches.forEach((m, i) => {
			const g = m.create ? undefined : (m.group ?? (grouped ? 'Payees' : undefined));
			if (g && g !== last) out.push({ heading: g });
			last = g;
			out.push({ m, i });
		});
		return out;
	});

	// Keys the list consumes (move, pick, close) stop here; everything else is
	// forwarded so the host form keeps its Enter-to-save / Esc-to-cancel.
	function keydown(e: KeyboardEvent) {
		if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			e.preventDefault();
			e.stopPropagation();
			open = true;
			active =
				e.key === 'ArrowDown' ? Math.min(active + 1, matches.length - 1) : Math.max(active - 1, -1);
			return;
		}
		if (e.key === 'Enter' && open && matches[active] !== undefined) {
			e.preventDefault();
			e.stopPropagation();
			choose(matches[active]!);
			// A host listening for keys (a register cell) goes on as for any Enter; a form host
			// doesn't get it, so picking never submits the form too.
			onkeydown?.(e);
			return;
		}
		// Tab takes the highlighted name and carries on to the next field.
		if (e.key === 'Tab' && open && matches[active] !== undefined) choose(matches[active]!);
		if (e.key === 'Escape' && open && matches.length > 0) {
			e.preventDefault();
			e.stopPropagation();
			open = false;
			active = -1;
			return;
		}
		onkeydown?.(e);
	}
</script>

<span data-slot="payee-combobox" class={cn('relative inline-flex w-full min-w-0', className)}>
	{#if transferAccountName}<input type="hidden" name={transferAccountName} value={transferAccountId} />{/if}
	<input
		bind:this={inputRef}
		{id}
		{name}
		{placeholder}
		{required}
		maxlength={TEXT_LIMITS.payee}
		type="text"
		role="combobox"
		autocomplete="off"
		aria-label={ariaLabel}
		aria-autocomplete="list"
		aria-expanded={open && matches.length > 0}
		aria-controls={listId}
		aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
		bind:value
		oninput={() => {
			transferAccountId = ''; // typed text names its account by text (the server checks it)
			open = true;
			filtering = true;
			// The best match is highlighted (after the "Create payee" item when there is one).
			active = typed === '' ? -1 : matches[0]?.create ? (matches.length > 1 ? 1 : 0) : 0;
		}}
		onfocus={() => {
			// Open with the whole list and nothing highlighted, so Enter and Tab still go on as
			// they did (a pick needs an arrow or a click; typing highlights the best match).
			filtering = false;
			active = -1;
			open = openOnFocus || pointerDown;
			pointerDown = false;
		}}
		onmousedown={() => {
			pointerDown = true;
			if (document.activeElement === inputRef && !open) {
				filtering = false;
				active = -1;
				open = true;
			}
		}}
		onblur={() => {
			open = false;
			onchange?.(value);
			onblur?.();
		}}
		onkeydown={keydown}
		class="h-8 w-full min-w-0 truncate rounded-control border border-input border-b-border-strong bg-surface px-2.5 text-body outline-none transition-colors placeholder:text-text-muted focus:border-b-brand focus:shadow-[inset_0_-1px_0_var(--accent)]"
	/>
	<Popover.Root
		open={open && matches.length > 0}
		onOpenChange={(o) => {
			if (!o) {
				open = false;
				active = -1;
			}
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
			class="z-[60] w-(--bits-popover-anchor-width) min-w-50 outline-none {flyoutMotion}"
		>
			<!-- A press anywhere on the list (its scrollbar, the padding) keeps focus in the field. -->
			<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
			<ul
				id={listId}
				role="listbox"
				tabindex="-1"
				aria-label="Payees"
				onmousedown={(e) => e.preventDefault()}
				class="max-h-[min(16rem,var(--bits-popover-content-available-height))] overflow-auto rounded-overlay border border-border bg-popover p-1 text-popover-foreground shadow-[var(--shadow-pop)]"
			>
				{#each rows as row, k (k)}
					{#if 'heading' in row}
						<li role="presentation" class="px-2 pt-2 pb-0.5 text-caption font-normal text-text-muted">{row.heading}</li>
					{:else}
						{@const m = row.m}
						<!-- Pointer pick uses mousedown so the input's blur doesn't close the list first. -->
						<li
							id={`${listId}-${row.i}`}
							role="option"
							aria-selected={row.i === active}
							class="cursor-default truncate rounded-control px-2 py-1.5 text-body {row.i === active ? 'bg-control-hover' : 'hover:bg-control-hover'}"
							onmousedown={(e) => {
								e.preventDefault();
								choose(m);
								onpick?.(value, transferAccountId);
							}}
						>
							{#if m.create}<span class="text-text-muted">Create payee</span> “{m.label}”{:else}{m.label}{/if}
						</li>
					{/if}
				{/each}
			</ul>
		</Popover.Content>
	</Popover.Root>
</span>
