/**
 * swatches.test.ts: category colours from the swatch set (F2 RD6, DECISIONS-S4 D4).
 * ============================================================================
 * The helpers (a swatch maps to its theme token, a custom colour passes through, the next
 * swatch is the least used), a new category without a colour gets a swatch, and migration
 * 0008 moves only the colours still at their seed value.
 * ============================================================================
 */
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { createDb } from '../src/lib/server/db/client';
import { migrationFiles, splitStatements } from '../src/lib/server/db/migrate';
import type { Db } from '../src/lib/server/db/client';
import * as schema from '../src/lib/server/db/schema';
import { createGroup, createCategory } from '../src/lib/server/categories';
import { SWATCHES, colourCss, nextSwatch, rankCss, RANK_SLOTS, swatchOf } from '../src/lib/swatches';

const DIR = resolve(__dirname, '../drizzle');

let handle: Db | undefined;
afterEach(() => {
	handle?.sqlite.close();
	handle = undefined;
});

/** A db migrated through the file named `upTo` (inclusive), or through all files. */
function db(upTo?: string): Db {
	const h = createDb(':memory:');
	handle = h;
	for (const f of migrationFiles(DIR)) {
		for (const stmt of splitStatements(readFileSync(resolve(DIR, f), 'utf8'))) h.sqlite.exec(stmt);
		if (upTo && f.startsWith(upTo)) break;
	}
	return h;
}

describe('swatches: helpers', () => {
	it('has ten distinct swatches, none red, green or gold', () => {
		expect(SWATCHES).toHaveLength(10);
		expect(new Set(SWATCHES.map((s) => s.hex)).size).toBe(10);
		for (const banned of ['#e34948', '#008300', '#1baf7a', '#eda100', '#b8923f']) {
			expect(swatchOf(banned)).toBeUndefined();
		}
	});

	it('maps a swatch to its theme token and passes a custom colour through', () => {
		expect(colourCss('#0F8FA8')).toBe('var(--cat-1)');
		expect(colourCss('#5c6bc0')).toBe('var(--cat-10)');
		expect(colourCss('#123456')).toBe('#123456');
		expect(colourCss(null)).toBeNull();
	});

	it('picks the first unused swatch, then the least used', () => {
		expect(nextSwatch([])).toBe(SWATCHES[0]!.hex);
		expect(nextSwatch([SWATCHES[0]!.hex, null, '#123456'])).toBe(SWATCHES[1]!.hex);
		const all = SWATCHES.map((s) => s.hex);
		expect(nextSwatch([...all, SWATCHES[0]!.hex])).toBe(SWATCHES[1]!.hex);
	});
});

describe('swatches: by rank', () => {
	it('gives the seven biggest seven different slots, every slot once in ten', () => {
		const seven = Array.from({ length: 7 }, (_, i) => rankCss(i));
		expect(new Set(seven).size).toBe(7);
		expect([...RANK_SLOTS].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
		expect(rankCss(0)).toBe('var(--cat-1)');
		expect(rankCss(10)).toBe(rankCss(0));
	});
});

describe('swatches: categories', () => {
	it('gives a new category without a colour the next swatch, and keeps a chosen one', async () => {
		const h = db();
		const g = await createGroup(h.db, { name: 'Essentials', kind: 'spending' });
		const a = await createCategory(h.db, { groupId: g.id, name: 'Rent' });
		const b = await createCategory(h.db, { groupId: g.id, name: 'Food' });
		const c = await createCategory(h.db, { groupId: g.id, name: 'Fuel', colour: '#c2389a' });
		expect(swatchOf(a.colour)).toBeDefined();
		expect(swatchOf(b.colour)).toBeDefined();
		expect(b.colour).not.toBe(a.colour);
		expect(c.colour).toBe('#c2389a');
	});

	it('migration 0008 moves seed-valued colours to swatches and leaves picked ones alone', () => {
		const h = db('0007');
		h.db.insert(schema.categoryGroups).values({ id: 'g', name: 'G', kind: 'spending', sortOrder: 0 }).run();
		const rows = [
			{ id: 'rent', colour: '#E5484D' },
			{ id: 'groc', colour: '#46A758' },
			{ id: 'gold', colour: '#B08C3D' },
			{ id: 'mine', colour: '#e5484d' }, // lower case: picked by hand, not the seed value
			{ id: 'none', colour: null }
		];
		// Raw SQL: the file stops at 0007, before columns the current schema has (0012's counts_as_return).
		const put = h.sqlite.prepare('INSERT INTO categories (id, group_id, name, sort_order, colour) VALUES (?, ?, ?, ?, ?)');
		rows.forEach((r, i) => put.run(r.id, 'g', r.id, i, r.colour));
		const f = migrationFiles(DIR).find((x) => x.startsWith('0008'))!;
		for (const stmt of splitStatements(readFileSync(resolve(DIR, f), 'utf8'))) h.sqlite.exec(stmt);
		const colour = (id: string) =>
			h.db.select({ c: schema.categories.colour }).from(schema.categories).where(eq(schema.categories.id, id)).get()!.c;
		expect(colour('rent')).toBe('#0f8fa8');
		expect(colour('groc')).toBe('#e87ba4');
		expect(colour('gold')).toBe('#a0612c');
		expect(colour('mine')).toBe('#e5484d');
		expect(colour('none')).toBeNull();
	});
});
