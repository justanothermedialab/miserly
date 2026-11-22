import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import PickCombobox from '$lib/components/PickCombobox.svelte';

// ACTUAL-PARITY #3: Category (and Quick Add's accounts) are typed into: a few letters and Tab.
afterEach(cleanup);

const options = [
	{ value: '', label: 'Uncategorized' },
	{ value: 'c1', label: 'Groceries', group: 'Food' },
	{ value: 'c2', label: 'Eating Out', group: 'Food' },
	{ value: 'c3', label: 'Rent', group: 'Home' }
];

describe('PickCombobox', () => {
	it('focus shows every item; typing filters and Tab takes the best match', async () => {
		const picks: string[] = [];
		const keys: string[] = [];
		const { getByRole, getAllByRole, container } = render(PickCombobox, {
			options,
			name: 'category',
			'aria-label': 'Category',
			onpick: (v: string) => picks.push(v),
			onkeydown: (e: KeyboardEvent) => keys.push(e.key)
		});
		const input = getByRole('combobox') as HTMLInputElement;
		await fireEvent.focus(input);
		expect(getAllByRole('option')).toHaveLength(4);
		await fireEvent.input(input, { target: { value: 'eat' } });
		expect(getAllByRole('option').map((o) => o.textContent?.trim())).toEqual(['Eating Out']);
		await fireEvent.keyDown(input, { key: 'Tab' });
		expect(picks).toEqual(['c2']);
		expect(keys).toEqual(['Tab']);
		expect(input.value).toBe('Eating Out');
		expect((container.querySelector('input[type=hidden]') as HTMLInputElement).value).toBe('c2');
	});

	it('a list line can read shorter than the field once picked ("HDFC" under its heading)', async () => {
		const accounts = [
			{ value: 'b', label: 'HDFC', picked: 'HDFC (Bank accounts)', group: 'Bank accounts' },
			{ value: 'm', label: 'HDFC', picked: 'HDFC (Mutual funds)', group: 'Mutual funds' }
		];
		const { getByRole, getAllByRole } = render(PickCombobox, { options: accounts, value: 'b' });
		const input = getByRole('combobox') as HTMLInputElement;
		expect(input.value).toBe('HDFC (Bank accounts)');
		await fireEvent.focus(input); // opens on the current item
		expect(getAllByRole('option').map((o) => o.textContent?.trim())).toEqual(['HDFC', 'HDFC']);
		input.focus();
		await fireEvent.mouseDown(getAllByRole('option')[1]!);
		expect(input.value).toBe('HDFC (Mutual funds)');
		// Selected from the end back to the start, so a narrow field shows "HDFC (Mu", not "(Mutual funds)".
		await tick();
		expect([input.selectionStart, input.selectionEnd, input.selectionDirection]).toEqual([0, 19, 'backward']);
	});

	it('letters stay in the field (never reach a page key)', async () => {
		const keys: string[] = [];
		const { getByRole } = render(PickCombobox, { options, onkeydown: (e: KeyboardEvent) => keys.push(e.key) });
		const input = getByRole('combobox') as HTMLInputElement;
		await fireEvent.focus(input);
		const down = new KeyboardEvent('keydown', { key: 'n', bubbles: true });
		input.dispatchEvent(down);
		expect(input.tagName).toBe('INPUT');
		expect(input.getAttribute('role')).toBe('combobox');
	});

	it('typed text that matches nothing reverts on Tab', async () => {
		const { getByRole } = render(PickCombobox, { options, value: 'c3' });
		const input = getByRole('combobox') as HTMLInputElement;
		await fireEvent.focus(input);
		await fireEvent.input(input, { target: { value: 'zzz' } });
		await fireEvent.keyDown(input, { key: 'Tab' });
		expect(input.value).toBe('Rent');
	});

	it('Enter takes the highlighted item; a click takes the one clicked', async () => {
		const picks: [string, string][] = [];
		const { getByRole, getAllByRole } = render(PickCombobox, {
			options,
			onpick: (v: string, how: string) => picks.push([v, how])
		});
		const input = getByRole('combobox') as HTMLInputElement;
		await fireEvent.focus(input);
		await fireEvent.input(input, { target: { value: 'r' } });
		await fireEvent.keyDown(input, { key: 'Enter' });
		expect(picks[0]).toEqual(['c3', 'Enter']);
		await fireEvent.focus(input);
		await fireEvent.mouseDown(getAllByRole('option')[1]!);
		expect(picks[1]).toEqual(['c1', 'click']);
	});
});
