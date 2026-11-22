/**
 * cell-locked.test.ts — a cell that can't be edited says why inline (the shell skill: never a
 * `title` tooltip). A transfer whose other half the viewer can't see edits only its notes; a
 * click on any other cell, on its empty space or its text, sets the editor's notice.
 */
import { describe, expect, it } from 'vitest';
import { CellEditor, type CellField, type GridRow } from '../../src/lib/register/grid.svelte';

type Row = GridRow & { hidden: boolean };
const base = { payeeName: null, categoryId: null, categoryName: null, amountPaise: 0, updatedAt: '' };
const WHY = "The other half of this transfer is in an account you can't see";

function editor(rows: Row[]) {
	return new CellEditor<Row>({
		rows: () => rows,
		serverRow: (id: string) => rows.find((r) => r.id === id),
		editable: () => true,
		fields: (r: Row): CellField[] => (r.hidden ? ['notes'] : ['date', 'notes']),
		action: () => '?/editTx',
		catName: () => '',
		reveal: () => {},
		locked: (r: Row) => (r.hidden ? WHY : undefined)
	} as never);
}

// A click whose target is inside the cell: `inLink` = it lands in a link or button there.
const td = {};
const clickInside = (inLink: boolean) =>
	({ currentTarget: td, target: { closest: () => (inLink ? {} : null) } }) as unknown as MouseEvent;

describe('CellEditor: a locked cell says why', () => {
	it('opening a locked cell sets the notice and opens nothing; an editable cell clears it', async () => {
		const hidden: Row = { ...base, id: 'h', date: '2026-01-01', notes: null, hidden: true };
		const ed = editor([hidden]);
		await ed.open(hidden as never, 'date');
		expect(ed.notice?.text).toBe(WHY);
		expect(ed.cell).toBeNull();
		await ed.open(hidden as never, 'notes');
		expect(ed.notice).toBeNull();
		expect(ed.cell).toEqual({ id: 'h', field: 'notes' });
	});

	it('a click on a locked cell’s text explains too; a link inside keeps its own click', () => {
		const hidden: Row = { ...base, id: 'h', date: '2026-01-01', notes: null, hidden: true };
		const ed = editor([hidden]);
		ed.click(clickInside(true), hidden as never, 'date');
		expect(ed.notice).toBeNull();
		ed.click(clickInside(false), hidden as never, 'date');
		expect(ed.notice?.text).toBe(WHY);
	});

	it('an ordinary row never sets a notice', async () => {
		const plain: Row = { ...base, id: 'p', date: '2026-01-01', notes: null, hidden: false };
		const ed = editor([plain]);
		await ed.open(plain as never, 'date');
		expect(ed.notice).toBeNull();
		expect(ed.cell).toEqual({ id: 'p', field: 'date' });
	});
});
