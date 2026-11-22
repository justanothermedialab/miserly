/**
 * list-pages.ts: how long lists load. All transactions, a register and the
 * Inbox send their first page with the page and the rest by pages as the person scrolls (each
 * list's `rows` endpoint, keyed on `(date, sequence)`), so a page's size doesn't grow with the
 * history: about 0.5 KB of data a row, and the drawn rows 3 to 5 KB of HTML each, so a first page
 * of 100 rows with 30 drawn keeps a page under 500 KB (measured: 498 to 628 KB with 200 and
 * 60).
 */

/** Rows in a page's first load: a few screens' worth (the server draws about one of them). */
export const FIRST_PAGE = 100;
/** Rows in each page a scroll asks for. */
export const LIST_PAGE = 200;
/** The most rows one page request returns: what a search, sort or export over a whole list asks
 *  for, page after page. */
export const MAX_PAGE = 2000;
/** The most rows a page's first load takes (`?n=`, kept for a link that asks for more). */
export const MAX_FIRST = 400;

const sized = (raw: string | null, fallback: number, max: number): number => {
	const n = Number(raw);
	return Number.isInteger(n) && n > 0 ? Math.min(n, max) : fallback;
};

/** A first load's size: `?n=`, capped. */
export function firstPageSize(url: URL): number {
	return sized(url.searchParams.get('n'), FIRST_PAGE, MAX_FIRST);
}

/** A page request's size: `?limit=`, capped. */
export function pageSize(url: URL): number {
	return sized(url.searchParams.get('limit'), LIST_PAGE, MAX_PAGE);
}
