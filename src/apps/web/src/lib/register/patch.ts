/**
 * patch.ts: a list patched from a save's answer. A save used to reload the
 * page, every row of it (2.6 MB on All transactions at 5,000 rows); it now answers with only what
 * changed, and the list takes it in here. The result must equal what a reload would show
 * (`save-answer.integration.test.ts` holds it to that).
 */

/**
 * A register's rows (ledger order, ascending) with a save's tail: the rows dated before `from`
 * stay, the answer's rows (every row from `from` on, each with its running balance) follow.
 */
export function withTail<R extends { readonly date: string }>(rows: readonly R[], tail: { readonly from: string; readonly rows: readonly R[] }): R[] {
	return [...rows.filter((r) => r.date < tail.from), ...tail.rows];
}

/**
 * All transactions' rows (newest first) with a save's answer: each answered row replaces its old
 * self or, new, joins the list; then newest first again, a row keeping its place among its date's.
 */
export function withAnswer<R extends { readonly id: string; readonly date: string }>(rows: readonly R[], answer: readonly R[]): R[] {
	const fresh = new Map(answer.map((r) => [r.id, r]));
	const known = new Set(rows.map((r) => r.id));
	return [...answer.filter((r) => !known.has(r.id)), ...rows.map((r) => fresh.get(r.id) ?? r)].sort((x, y) =>
		x.date < y.date ? 1 : x.date > y.date ? -1 : 0
	);
}
