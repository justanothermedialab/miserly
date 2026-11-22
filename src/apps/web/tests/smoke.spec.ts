import { expect, test } from '@playwright/test';
import { SEED_USERS } from './fixtures';

// The home page now requires auth (M4) — an admin already exists in the seeded
// e2e db (tests/global-setup.ts), so an unauthenticated visit to `/` is
// redirected to `/signin` rather than showing the app.
test('home page redirects unauthenticated visitors to sign-in', async ({ page }) => {
	const response = await page.goto('/');
	expect(response?.ok()).toBeTruthy();
	expect(page.url()).toContain('/signin');
});

test('the seeded admin can sign in and reach the landing page', async ({ page }) => {
	await page.goto('/signin');
	await page.getByLabel('Username').fill(SEED_USERS.alice.username);
	await page.getByLabel('Password').fill(SEED_USERS.alice.password);
	await page.getByRole('button', { name: 'Sign in' }).click();
	await page.waitForLoadState('networkidle');

	expect(page.url()).not.toContain('/signin');
	// The authenticated shell (sidebar brand + the viewer's username in the footer)
	// is present once signed in. The footer username sits next to an "admin" role
	// badge in the same span, so match it as a substring, not exact.
	await expect(page.getByText('Miserly').first()).toBeVisible();
	await expect(page.getByText(SEED_USERS.alice.username).first()).toBeVisible();
});
