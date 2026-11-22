<!--
	S5 RD8: an account's optional details (rate, maturity date, credit limit, folio, ...), the same
	fields in Add account and Edit account. Each posts as `info_<key>`; a blank one isn't stored, so
	clearing a field in Edit account removes it.
-->
<script lang="ts">
	import type { InfoField } from '$lib/modules';
	import * as Select from '$lib/components/ui/select';
	import { Input } from '$lib/components/ui/input';
	import DateField from '$lib/components/DateField.svelte';
	import { TEXT_LIMITS } from '$lib/text-limits';

	let {
		fields,
		values = {},
		errors = {},
		withCcy
	}: {
		fields: readonly InfoField[];
		/** The stored values to start from (Edit account); empty in Add account. */
		values?: Record<string, string>;
		errors?: Record<string, string>;
		/** Names the account's currency on an amount field's label, "Credit limit (₹)". */
		withCcy: (label: string) => string;
	} = $props();

	// The select fields' picks (Bits Select binds a value); text and date fields post as typed.
	// svelte-ignore state_referenced_locally
	let picked = $state<Record<string, string>>({ ...values });

	const labelCls = 'text-caption font-normal text-text-muted';
	const errCls = 'text-caption text-neg';
	const inv = (key: string) =>
		errors[key] ? { 'aria-invalid': 'true' as const, 'aria-describedby': `err-${key}` } : {};
</script>

{#if fields.length > 0}
	<p class="mt-1 {labelCls}">Details (optional)</p>
	<div class="grid grid-cols-2 gap-3">
		{#each fields as f (f.key)}
			<div class="flex flex-col gap-1">
				<label for={`acc-info-${f.key}`} class={labelCls}>{f.type === 'number' ? withCcy(f.label) : f.label}</label>
				{#if f.type === 'select'}
					<Select.Root type="single" name={`info_${f.key}`} bind:value={picked[f.key]}>
						<Select.Trigger id={`acc-info-${f.key}`} class="w-full">{picked[f.key] || 'Select…'}</Select.Trigger>
						<Select.Content>
							<!-- A blank choice, so a picked value can be cleared again. -->
							{#if picked[f.key]}<Select.Item value="" label="None" />{/if}
							{#each f.options ?? [] as opt (opt)}<Select.Item value={opt} label={opt} />{/each}
						</Select.Content>
					</Select.Root>
				{:else if f.type === 'date'}
					<DateField id={`acc-info-${f.key}`} name={`info_${f.key}`} value={values[f.key] ?? ''} class="w-full" />
				{:else}
					<Input
						id={`acc-info-${f.key}`}
						name={`info_${f.key}`}
						value={values[f.key] ?? ''}
						maxlength={TEXT_LIMITS.details}
						inputmode={f.type === 'number' ? 'decimal' : 'text'}
						class="w-full"
						{...inv(`info_${f.key}`)}
					/>
				{/if}
				{#if errors[`info_${f.key}`]}<span id={`err-info_${f.key}`} class={errCls}>{errors[`info_${f.key}`]}</span>{/if}
			</div>
		{/each}
	</div>
{/if}
