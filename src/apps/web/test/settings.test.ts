/**
 * settings.test.ts — M11 settings store (SET1 per-user prefs + H1 Circle name).
 * ============================================================================
 * Proves: `getUserPrefs` resolves locale-derived defaults for a user with no
 * stored row (South-Asian locale -> indian, US locale -> western, no hint ->
 * western); `setUserPrefs` upserts and round-trips a PARTIAL patch (unpatched
 * fields keep their prior value); an invalid enum throws rather than silently
 * storing garbage; `getCircleName`/`setCircleName` set a name and a blank
 * value clears it (H1: optional free text, never required).
 * ============================================================================
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createDb } from '../src/lib/server/db/client';
import { allStatements } from '../src/lib/server/db/migrate';
import type { Db } from '../src/lib/server/db/client';
import * as schema from '../src/lib/server/db/schema';
import { getUserPrefs, setUserPrefs, getCircleName, setCircleName } from '../src/lib/server/settings';

let handle: Db | undefined;
afterEach(() => {
	handle?.sqlite.close();
	handle = undefined;
});

function seed(): Db {
	const h = createDb(':memory:');
	handle = h;
	for (const stmt of allStatements()) h.sqlite.exec(stmt);
	h.db
		.insert(schema.users)
		.values([{ id: 'u1', username: 'u1', displayName: 'User One', role: 'admin' }])
		.run();
	return h;
}

describe('getUserPrefs — first-run defaults for an unset user', () => {
	it('an INR base defaults to indian even on an en-US device (SET1 RD2 amended, REL-12)', async () => {
		const h = seed();
		expect((await getUserPrefs(h.db, 'u1', 'en-US,en;q=0.9')).numberSystem).toBe('indian');
		expect((await getUserPrefs(h.db, 'u1', null, 'INR')).numberSystem).toBe('indian');
	});

	it('a South-Asian Accept-Language (en-IN) resolves to indian', async () => {
		const h = seed();
		const prefs = await getUserPrefs(h.db, 'u1', 'en-IN,en;q=0.9');
		expect(prefs.numberSystem).toBe('indian');
		expect(prefs.compact).toBe(true); // SET1 RD5
		expect(prefs.foreignGrouping).toBe('preference');
		expect(prefs.theme).toBe('system');
	});

	it('a non-INR base falls back to the locale: en-US resolves to western', async () => {
		const h = seed();
		const prefs = await getUserPrefs(h.db, 'u1', 'en-US,en;q=0.9', 'USD');
		expect(prefs.numberSystem).toBe('western');
	});

	it('a non-INR base with no hint at all falls back to western', async () => {
		const h = seed();
		const prefs = await getUserPrefs(h.db, 'u1', null, 'USD');
		expect(prefs.numberSystem).toBe('western');
	});
});

describe('setUserPrefs — upsert + partial round-trip', () => {
	it('a first write materializes a full row from defaults + the patch', async () => {
		const h = seed();
		const saved = await setUserPrefs(h.db, 'u1', { numberSystem: 'indian' }, 'en-US');
		expect(saved.numberSystem).toBe('indian');
		// Untouched fields fall back to the defaults, not undefined (compact on, SET1 RD5).
		expect(saved.compact).toBe(true);
		expect(saved.foreignGrouping).toBe('preference');
		expect(saved.theme).toBe('system');

		const reread = await getUserPrefs(h.db, 'u1');
		expect(reread).toEqual(saved);
	});

	it('a second, partial patch only overwrites the given fields', async () => {
		const h = seed();
		await setUserPrefs(h.db, 'u1', { numberSystem: 'indian', compact: true, theme: 'dark' });
		const patched = await setUserPrefs(h.db, 'u1', { compact: false });

		expect(patched.compact).toBe(false); // the patched field
		expect(patched.numberSystem).toBe('indian'); // preserved from the first write
		expect(patched.theme).toBe('dark'); // preserved from the first write

		const reread = await getUserPrefs(h.db, 'u1');
		expect(reread).toEqual(patched);
	});

	it('rejects an invalid numberSystem rather than storing it', async () => {
		const h = seed();
		await expect(
			setUserPrefs(h.db, 'u1', { numberSystem: 'lunar' as never }),
		).rejects.toThrow();
	});

	it('rejects an invalid foreignGrouping', async () => {
		const h = seed();
		await expect(
			setUserPrefs(h.db, 'u1', { foreignGrouping: 'bogus' as never }),
		).rejects.toThrow();
	});

	it('saves the Black theme (OLED)', async () => {
		const h = seed();
		const saved = await setUserPrefs(h.db, 'u1', { theme: 'black' });
		expect(saved.theme).toBe('black');
		expect((await getUserPrefs(h.db, 'u1')).theme).toBe('black');
	});

	it('rejects an invalid theme', async () => {
		const h = seed();
		await expect(setUserPrefs(h.db, 'u1', { theme: 'rainbow' as never })).rejects.toThrow();
	});
});

describe('Circle name (H1) — instance-wide, admin-managed', () => {
	it('is null until ever set', async () => {
		const h = seed();
		expect(await getCircleName(h.db)).toBeNull();
	});

	it('setCircleName stores a trimmed name; getCircleName reads it back', async () => {
		const h = seed();
		await setCircleName(h.db, '  The Home Circle  ');
		expect(await getCircleName(h.db)).toBe('The Home Circle');
	});

	it('setting it again replaces the previous value', async () => {
		const h = seed();
		await setCircleName(h.db, 'First name');
		await setCircleName(h.db, 'Second name');
		expect(await getCircleName(h.db)).toBe('Second name');
	});

	it('a blank/whitespace-only value clears the name back to null', async () => {
		const h = seed();
		await setCircleName(h.db, 'Something');
		expect(await getCircleName(h.db)).toBe('Something');
		await setCircleName(h.db, '   ');
		expect(await getCircleName(h.db)).toBeNull();
	});
});
