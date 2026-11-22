/**
 * packaged.smoke.spec.ts — the BUILT artifact renders in a real browser (M12).
 * ============================================================================
 * The webServer for this run is `node build/index.js` (playwright.config.ts) —
 * the exact adapter-node entry both packaging modes wrap. This proves, through
 * installed Edge, that the shipped server: signs a user in (a real form POST,
 * so the ORIGIN/CSRF wiring works in-browser, not just via fetch), renders the
 * M7 dashboard, and serves every CSS/JS/font asset without a 4xx (adapter-node
 * base paths are exactly what packaging can break). A screenshot is captured.
 * ============================================================================
 */
import { expect, test } from '@playwright/test';
import { SEED_USERS } from './fixtures';

test('the built server signs in, renders the dashboard, and serves all assets', async ({ page }) => {
	const assetFailures: string[] = [];
	page.on('response', (res) => {
		const kind = res.request().resourceType();
		if (['stylesheet', 'script', 'font', 'image'].includes(kind) && res.status() >= 400) {
			assetFailures.push(`${res.status()} ${res.url()}`);
		}
	});

	await page.goto('/signin');
	await page.getByLabel('Username').fill(SEED_USERS.alice.username);
	await page.getByLabel('Password').fill(SEED_USERS.alice.password);
	await page.getByRole('button', { name: 'Sign in' }).click();
	await page.waitForLoadState('networkidle');

	// Real form POST succeeded → left /signin and reached the dashboard. The
	// restyled dashboard titles the page via the top-bar breadcrumb (not an <h1>),
	// so assert a stable dashboard content marker (the D2 Allocation card).
	expect(page.url()).not.toContain('/signin');
	await expect(page.getByText('Allocation').first()).toBeVisible();

	// Packaging regression guard: no broken asset requests under the built server.
	expect(assetFailures, `asset requests failed:\n${assetFailures.join('\n')}`).toHaveLength(0);

	await page.screenshot({ path: 'test-results/packaged-dashboard.png', fullPage: true });
});
