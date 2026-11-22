/**
 * privacy.spec.ts — THE M4 MILESTONE ACCEPTANCE TEST.
 * ============================================================================
 * Asserts the P0 privacy invariant (architecture §12 / security.md) at the
 * SERVER boundary — response status and the final navigated URL after a
 * server redirect — never just DOM visibility. Seed data comes from
 * `tests/global-setup.ts` via `tests/fixtures.ts`.
 * ============================================================================
 */
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { SEED_USERS, SEED_ACCOUNTS } from './fixtures';

async function signIn(page: Page, username: string, password: string): Promise<void> {
	await page.goto('/signin');
	await page.getByLabel('Username').fill(username);
	await page.getByLabel('Password').fill(password);
	await page.getByRole('button', { name: 'Sign in' }).click();
	await page.waitForLoadState('networkidle');
}

test.describe('privacy: server-side account visibility scoping', () => {
	test('unauthenticated GET /accounts/:id redirects to /signin with the deep-link preserved', async ({
		page,
	}) => {
		const target = `/accounts/${SEED_ACCOUNTS.alicePrivate}`;
		const response = await page.goto(target);
		expect(response?.status()).toBe(200); // the /signin page, after the server redirect was followed
		expect(page.url()).toContain('/signin');
		expect(page.url()).toContain(`redirectTo=${encodeURIComponent(target)}`);
	});

	test('a member (bob) can see an account they are a MEMBER of — 200', async ({ page }) => {
		await signIn(page, SEED_USERS.bob.username, SEED_USERS.bob.password);

		const response = await page.goto(`/accounts/${SEED_ACCOUNTS.aliceShared}`);
		expect(response?.status()).toBe(200);
		// The account name now appears in both the sidebar nav and the register
		// heading (post-restyle chrome), so scope the assertion to the register's
		// own <h1> — a member reaching the register IS the visibility proof.
		await expect(page.getByRole('heading', { name: /Alice Shared/ })).toBeVisible();
	});

	test('a member (bob) gets 404 for an account they cannot see — IDENTICAL to a bogus id (no existence leak)', async ({
		page,
	}) => {
		await signIn(page, SEED_USERS.bob.username, SEED_USERS.bob.password);

		const privateResponse = await page.goto(`/accounts/${SEED_ACCOUNTS.alicePrivate}`);
		expect(privateResponse?.status()).toBe(404);
		const privateBody = await page.locator('body').innerText();

		const bogusResponse = await page.goto('/accounts/this-id-does-not-exist-at-all');
		expect(bogusResponse?.status()).toBe(404);
		const bogusBody = await page.locator('body').innerText();

		expect(privateBody).toBe(bogusBody);
	});

	test('the admin (alice) is NOT privileged: 404 for an account they neither own nor are a member of', async ({
		page,
	}) => {
		await signIn(page, SEED_USERS.alice.username, SEED_USERS.alice.password);

		const response = await page.goto(`/accounts/${SEED_ACCOUNTS.bobOwn}`);
		expect(response?.status()).toBe(404);
	});
});

test.describe('smoke-checked: first-run and forced-change gates redirect correctly', () => {
	test('/setup redirects to / once an admin exists', async ({ page }) => {
		const response = await page.goto('/setup');
		expect(response?.status()).toBe(200);
		expect(page.url()).not.toContain('/setup');
	});

	test('signing in with a wrong password shows a generic error, not an enumeration hint', async ({
		page,
	}) => {
		await page.goto('/signin');
		await page.getByLabel('Username').fill(SEED_USERS.alice.username);
		await page.getByLabel('Password').fill('definitely-the-wrong-password');
		await page.getByRole('button', { name: 'Sign in' }).click();
		await expect(page.getByText('Invalid username or password')).toBeVisible();

		await page.goto('/signin');
		await page.getByLabel('Username').fill('a-username-that-does-not-exist');
		await page.getByLabel('Password').fill('whatever-password');
		await page.getByRole('button', { name: 'Sign in' }).click();
		await expect(page.getByText('Invalid username or password')).toBeVisible();
	});
});
