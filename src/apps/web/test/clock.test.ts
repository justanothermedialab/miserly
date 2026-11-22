import { describe, expect, it } from 'vitest';
import { compareDates, systemClock } from '@miserly/core';
import { appClock, withTimeZone } from '$lib/server/clock';

// In hosted mode the server ran "today" on its own (UTC) calendar. Each request now runs
// in the viewer's zone, read from the miserly_tz cookie in hooks.server.ts.
describe('appClock', () => {
	it("reads today in the request's zone, across awaits", async () => {
		const east = await withTimeZone('Pacific/Kiritimati', async () => {
			await Promise.resolve();
			return appClock().today();
		});
		const west = withTimeZone('Etc/GMT+12', () => appClock().today());
		expect(compareDates(east, west)).toBe(1);
	});

	it("falls back to the server's own zone with no cookie or a junk one", () => {
		const server = systemClock().today();
		expect(withTimeZone(undefined, () => appClock().today()).equals(server)).toBe(true);
		expect(withTimeZone('Not/AZone', () => appClock().today()).equals(server)).toBe(true);
		expect(appClock().today().equals(server)).toBe(true);
	});
});
