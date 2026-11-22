import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rowLink } from '$lib/row-link';

// UX-REVIEW P3: a click anywhere on a row follows the row's link; the row's own controls and
// a text selection keep their clicks.
let table: HTMLTableElement;
let action: { destroy(): void };
let followed: string[];
beforeEach(() => {
	document.body.innerHTML = `<table class="data-table"><tbody>
		<tr id="one"><td id="date">14 Sep</td><td><a id="acct" href="/accounts/a">SBI</a></td><td><a id="tx" data-row-link href="/accounts/a?tx=1">Swiggy</a></td><td><button id="btn">Edit</button></td></tr>
		<tr id="plain"><td id="nolink">Total</td></tr>
		<tr id="first"><td id="cell">Rent</td><td><a id="only" href="/sections/bank">Bank</a></td></tr>
	</tbody></table>`;
	table = document.querySelector('table')!;
	action = rowLink(table);
	followed = [];
	for (const a of document.querySelectorAll('a')) {
		a.addEventListener('click', (e) => {
			e.preventDefault();
			followed.push(a.id);
		});
	}
});
afterEach(() => {
	action.destroy();
	document.body.innerHTML = '';
	vi.restoreAllMocks();
});
const click = (id: string, init: MouseEventInit = {}) =>
	document.getElementById(id)!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...init }));

describe('rowLink', () => {
	it('marks the table for the pointer cursor', () => {
		expect(table.dataset.rowlink).toBe('');
	});
	it('follows the data-row-link link from a click on a plain cell', () => {
		click('date');
		expect(followed).toEqual(['tx']);
	});
	it('falls back to the first link in the row', () => {
		click('cell');
		expect(followed).toEqual(['only']);
	});
	it('leaves a click on another link or a control alone', () => {
		click('acct');
		click('btn');
		expect(followed).toEqual(['acct']);
	});
	it('does nothing on a row without a link, a right click or after a text selection', () => {
		click('nolink');
		click('date', { button: 2 });
		vi.spyOn(window, 'getSelection').mockReturnValue({ toString: () => 'Swig' } as Selection);
		click('date');
		expect(followed).toEqual([]);
	});
});
