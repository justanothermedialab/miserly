/**
 * CSV export of the rows on screen (ACTUAL-PARITY #10): a register or All transactions, with its
 * search and filters, made in the page from the rows it already holds, so it carries only what
 * the viewer can see (P0) and needs no server route. UTF-8 with a byte-order mark and CRLF, so
 * Excel opens ₹ and names correctly; text that a spreadsheet would read as a formula (= + - @)
 * is prefixed with an apostrophe. Amounts are plain numbers (no symbol, no grouping).
 */

function cell(v: string | number | null | undefined): string {
	if (v === null || v === undefined) return '';
	if (typeof v === 'number') return String(v);
	const safe = /^[=+\-@\t\r]/u.test(v) ? `'${v}` : v;
	return /[",\r\n]/u.test(safe) ? `"${safe.replace(/"/gu, '""')}"` : safe;
}

export function toCsv(rows: readonly (readonly (string | number | null | undefined)[])[]): string {
	return '﻿' + rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

/** Paise as a plain decimal ("-450.00" → -450). */
export const rupees = (paise: number): number => Math.round(paise) / 100;

export function downloadCsv(filename: string, rows: readonly (readonly (string | number | null | undefined)[])[]) {
	const url = URL.createObjectURL(new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8' }));
	const a = document.createElement('a');
	a.href = url;
	a.download = filename.replace(/[\\/:*?"<>|]+/gu, ' ').trim();
	document.body.append(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}
