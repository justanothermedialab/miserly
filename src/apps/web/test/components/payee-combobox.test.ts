import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import PayeeCombobox from '$lib/components/PayeeCombobox.svelte';
import { transferOptions } from '$lib/transfer-targets';

// The payee list now floats on Bits positioning; the keyboard contract must not change.
afterEach(cleanup);

const options = ['Big Bazaar', 'Bescom', 'Swiggy', 'Zomato'];

describe('PayeeCombobox', () => {
	it('opens on typing, picks with ArrowDown + Enter, keeps focus on the input', async () => {
		let picked = '';
		const { getByRole, queryByRole } = render(PayeeCombobox, {
			options,
			'aria-label': 'Payee',
			onchange: (v: string) => (picked = v)
		});
		const input = getByRole('combobox') as HTMLInputElement;
		input.focus();
		await fireEvent.input(input, { target: { value: 'b' } });
		expect(queryByRole('listbox')).not.toBeNull();
		expect(document.activeElement).toBe(input);
		// Typing highlights the best match (ACTUAL-PARITY #2); the arrows move from there.
		await fireEvent.keyDown(input, { key: 'ArrowDown' });
		await fireEvent.keyDown(input, { key: 'ArrowUp' });
		await fireEvent.keyDown(input, { key: 'Enter' });
		expect(picked).toBe('Big Bazaar');
		expect(input.value).toBe('Big Bazaar');
		expect(queryByRole('listbox')).toBeNull();
	});

	it('Escape closes the list without reaching the host form', async () => {
		let hostKeys = 0;
		const { getByRole, queryByRole } = render(PayeeCombobox, {
			options,
			onkeydown: () => hostKeys++
		});
		const input = getByRole('combobox') as HTMLInputElement;
		input.focus();
		await fireEvent.input(input, { target: { value: 's' } });
		await fireEvent.keyDown(input, { key: 'Escape' });
		expect(queryByRole('listbox')).toBeNull();
		expect(hostKeys).toBe(0);
		// With the list closed, Escape goes to the host (register row cancel).
		await fireEvent.keyDown(input, { key: 'Escape' });
		expect(hostKeys).toBe(1);
	});

	it('picks with the pointer', async () => {
		const { getByRole, getAllByRole } = render(PayeeCombobox, { options });
		const input = getByRole('combobox') as HTMLInputElement;
		input.focus();
		await fireEvent.input(input, { target: { value: 'z' } });
		// The first item is "Create payee “z”"; the match follows it.
		await fireEvent.mouseDown(getAllByRole('option')[1]!);
		expect(input.value).toBe('Zomato');
	});

	// ACTUAL-PARITY #2: "Swigg" + Tab is Swiggy, not a new payee "Swigg".
	it('Tab takes the highlighted match and still reaches the host', async () => {
		const keys: string[] = [];
		const { getByRole } = render(PayeeCombobox, {
			options: ['Swiggy', 'Swiggy Dineout', 'Bescom'],
			onkeydown: (e: KeyboardEvent) => keys.push(e.key)
		});
		const input = getByRole('combobox') as HTMLInputElement;
		input.focus();
		await fireEvent.input(input, { target: { value: 'Swigg' } });
		await fireEvent.keyDown(input, { key: 'Tab' });
		expect(input.value).toBe('Swiggy');
		expect(keys).toEqual(['Tab']);
	});

	it('ranks an exact name, then a prefix, then the caller order (most used first)', async () => {
		const { getByRole, getAllByRole } = render(PayeeCombobox, {
			options: ['Swiggy Dineout', 'Instamart by Swiggy', 'Swiggy']
		});
		const input = getByRole('combobox') as HTMLInputElement;
		input.focus();
		await fireEvent.input(input, { target: { value: 'swiggy' } });
		expect(getAllByRole('option').map((o) => o.textContent?.trim())).toEqual([
			'Swiggy',
			'Swiggy Dineout',
			'Instamart by Swiggy'
		]);
	});

	// The accounts sit under a heading per section, each line its own id.
	it('lists two accounts of one name under their own headings and posts the picked one\'s id', async () => {
		const opts = [
			'HDFC Credit Card bill',
			...transferOptions([
				{ id: 'fund-1', name: 'HDFC', label: 'HDFC', type: 'mutualFunds', currency: 'INR' },
				{ id: 'bank-1', name: 'HDFC', label: 'HDFC', type: 'bank', currency: 'INR' },
				{ id: 'bank-2', name: 'SBI', label: 'SBI', type: 'bank', currency: 'INR' }
			])
		];
		let pickedId = '';
		const { getByRole, getAllByRole, container } = render(PayeeCombobox, {
			options: opts,
			transferAccountName: 'transferAccountId',
			onpick: (_v: string, id: string) => (pickedId = id)
		});
		const input = getByRole('combobox') as HTMLInputElement;
		input.focus();
		await fireEvent.input(input, { target: { value: 'HDFC' } });
		const list = getByRole('listbox');
		const lines = [...list.querySelectorAll('li')].map((li) => li.textContent?.trim());
		expect(lines).toEqual([
			'Create payee “HDFC”',
			'Payees',
			'HDFC Credit Card bill',
			'Transfer: Bank accounts',
			'HDFC',
			'Transfer: Mutual funds',
			'HDFC'
		]);
		// The bank's line, not the fund's: the field reads "Transfer → HDFC", the form posts the id.
		await fireEvent.mouseDown(getAllByRole('option')[2]!);
		expect(input.value).toBe('Transfer → HDFC');
		expect(pickedId).toBe('bank-1');
		const hidden = container.querySelector('input[name="transferAccountId"]') as HTMLInputElement;
		expect(hidden.value).toBe('bank-1');
		// Typing again drops the id: typed text names its account by text (the server checks it).
		await fireEvent.input(input, { target: { value: 'Transfer → HDF' } });
		expect(hidden.value).toBe('');
	});

	it('keeps a new name through the Create item', async () => {
		const { getByRole } = render(PayeeCombobox, { options: ['Swiggy'] });
		const input = getByRole('combobox') as HTMLInputElement;
		input.focus();
		await fireEvent.input(input, { target: { value: 'Swi' } });
		await fireEvent.keyDown(input, { key: 'ArrowUp' });
		await fireEvent.keyDown(input, { key: 'Tab' });
		expect(input.value).toBe('Swi');
	});
});
