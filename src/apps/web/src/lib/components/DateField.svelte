<!--
	DateField — the ONE date input (DL-20; replaces native type="date", whose popup is
	OS-drawn and shows the locale's dd-mm-yyyy). Shows the app format (`6 Aug 2026`),
	accepts typed day-first dates (`6/8`, `6 aug`, ISO), and opens a themed Bits
	calendar from the icon button (or Alt+Down in the field; the button is not a Tab stop, so
	Tab goes from the date straight to the next field, as Actual's). The form value is a hidden ISO `YYYY-MM-DD` input
	carrying `name`, so server actions are unchanged.
-->
<script lang="ts">
	import { flyoutMotion } from '$lib/motion';
	import Tooltip from '$lib/components/Tooltip.svelte';
	import { Popover, Calendar } from 'bits-ui';
	import { CalendarDate } from '@internationalized/date';
	import { CalendarDays, ChevronLeft, ChevronRight } from '@lucide/svelte';
	import { formatDate, parseDate } from '$lib/dates';
	import { cn } from '$lib/utils';

	let {
		value = $bindable(''),
		name = undefined,
		id = undefined,
		required = false,
		disabled = false,
		'aria-label': ariaLabel = undefined,
		'aria-invalid': ariaInvalid = undefined,
		'aria-describedby': ariaDescribedby = undefined,
		class: className = '',
		inputRef = $bindable(null),
		onchange = undefined,
		onkeydown = undefined,
		onblur = undefined
	}: {
		value?: string;
		name?: string;
		id?: string;
		required?: boolean;
		disabled?: boolean;
		'aria-label'?: string;
		'aria-invalid'?: boolean | 'true' | 'false';
		'aria-describedby'?: string;
		class?: string;
		inputRef?: HTMLInputElement | null;
		onchange?: (iso: string) => void;
		onkeydown?: (e: KeyboardEvent) => void;
		/** Fires when focus leaves the field (not when it moves to the calendar button). */
		onblur?: () => void;
	} = $props();

	let text = $state('');
	let focused = $state(false);
	let invalid = $state(false);
	let open = $state(false);
	let hidden = $state<HTMLInputElement | null>(null);
	let root = $state<HTMLElement | null>(null);

	// Mirror the bound ISO value into the visible text unless the user is typing.
	$effect(() => {
		const v = value;
		if (!focused) {
			text = v ? formatDate(v) : '';
			invalid = false;
		}
	});

	function set(iso: string) {
		value = iso;
		// Keep the hidden input in step synchronously: an Enter keypress submits the
		// form before Svelte's next DOM flush.
		if (hidden) hidden.value = iso;
		onchange?.(iso);
	}

	function commit() {
		const t = text.trim();
		if (t === '') {
			invalid = required;
			if (value !== '') set('');
			return;
		}
		const iso = parseDate(t);
		if (iso) {
			invalid = false;
			text = formatDate(iso);
			if (iso !== value) set(iso);
		} else {
			invalid = true;
		}
	}

	const calValue = $derived.by(() => {
		const m = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value ?? '');
		return m ? new CalendarDate(Number(m[1]), Number(m[2]), Number(m[3])) : undefined;
	});

	function pick(d: CalendarDate | undefined) {
		if (!d) return;
		const iso = d.toString();
		text = formatDate(iso);
		invalid = false;
		set(iso);
		open = false;
		inputRef?.focus();
	}
</script>

<span
	bind:this={root}
	data-slot="date-field"
	class={cn(
		'relative inline-flex h-8 w-40 min-w-0 items-center rounded-control border border-input border-b-border-strong bg-surface text-body transition-colors focus-within:border-b-brand focus-within:shadow-[inset_0_-1px_0_var(--accent)]',
		(invalid || ariaInvalid === true || ariaInvalid === 'true') && 'border-b-neg shadow-[inset_0_-1px_0_var(--neg)]',
		disabled && 'pointer-events-none opacity-50',
		className
	)}
>
	<input
		bind:this={inputRef}
		{id}
		type="text"
		inputmode="text"
		autocomplete="off"
		spellcheck="false"
		placeholder="e.g. 6 Aug 2026"
		aria-label={ariaLabel}
		aria-invalid={invalid || ariaInvalid === true || ariaInvalid === 'true' ? 'true' : undefined}
		aria-describedby={ariaDescribedby}
		{required}
		{disabled}
		bind:value={text}
		onfocus={() => (focused = true)}
		onblur={(e) => {
			focused = false;
			commit();
			if (!root?.contains(e.relatedTarget as Node | null)) onblur?.();
		}}
		onkeydown={(e) => {
			if (e.key === 'Enter' || e.key === 'Tab') commit();
			if (e.key === 'ArrowDown' && e.altKey) {
				e.preventDefault();
				open = true;
			}
			onkeydown?.(e);
		}}
		class="num h-full w-full min-w-0 bg-transparent pr-8 pl-2.5 outline-none placeholder:text-text-muted"
	/>
	{#if name}<input bind:this={hidden} type="hidden" {name} {value} />{/if}
	<Popover.Root bind:open>
		<Tooltip label="Choose date" shortcut="Alt+Down">
			{#snippet child({ props })}
				<Popover.Trigger
					{...props}
					{disabled}
					tabindex={-1}
					aria-label="Choose date"
					class="absolute right-0.5 grid size-7 place-items-center rounded-control text-text-muted hover:bg-control-hover hover:text-text"
				>
					<CalendarDays size={16} />
				</Popover.Trigger>
			{/snippet}
		</Tooltip>
		<Popover.Portal>
			<!-- Stay inside the window (collision padding) and hide while the field is scrolled
			     out of view, instead of flipping over the title strip (hunt H-cal-A). -->
			<Popover.Content
				sideOffset={4}
				align="end"
				collisionPadding={8}
				hideWhenDetached
				class="z-[60] rounded-overlay border border-border bg-popover p-3 text-popover-foreground shadow-[var(--shadow-pop)] outline-none {flyoutMotion}"
			>
				<Calendar.Root
					type="single"
					value={calValue}
					placeholder={calValue}
					onValueChange={(v) => pick(v as CalendarDate | undefined)}
					locale="en-GB"
					weekdayFormat="short"
					fixedWeeks
					initialFocus
				>
					{#snippet children({ months, weekdays })}
						<Calendar.Header class="mb-2 flex items-center justify-between gap-2">
							<Calendar.PrevButton
								aria-label="Previous month"
								class="grid size-8 place-items-center rounded-control text-text-muted hover:bg-control-hover hover:text-text"
								><ChevronLeft size={16} /></Calendar.PrevButton
							>
							<Calendar.Heading class="text-body font-semibold" />
							<Calendar.NextButton
								aria-label="Next month"
								class="grid size-8 place-items-center rounded-control text-text-muted hover:bg-control-hover hover:text-text"
								><ChevronRight size={16} /></Calendar.NextButton
							>
						</Calendar.Header>
						{#each months as month (month.value.toString())}
							<Calendar.Grid class="border-collapse select-none">
								<Calendar.GridHead>
									<Calendar.GridRow class="flex">
										{#each weekdays as d (d)}
											<Calendar.HeadCell class="w-8 text-center text-caption font-normal text-text-muted"
												>{d.slice(0, 2)}</Calendar.HeadCell
											>
										{/each}
									</Calendar.GridRow>
								</Calendar.GridHead>
								<Calendar.GridBody>
									{#each month.weeks as week, wi (wi)}
										<Calendar.GridRow class="flex">
											{#each week as date (date.toString())}
												<Calendar.Cell {date} month={month.value} class="p-0">
													<Calendar.Day
														class="grid size-8 place-items-center rounded-control text-body hover:bg-control-hover data-[outside-month]:text-text-muted data-[today]:font-semibold data-[today]:text-brand-ink data-[selected]:bg-primary data-[selected]:text-primary-foreground data-[selected]:data-[today]:text-primary-foreground data-[disabled]:opacity-40"
													/>
												</Calendar.Cell>
											{/each}
										</Calendar.GridRow>
									{/each}
								</Calendar.GridBody>
							</Calendar.Grid>
						{/each}
					{/snippet}
				</Calendar.Root>
			</Popover.Content>
		</Popover.Portal>
	</Popover.Root>
</span>
