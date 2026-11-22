/**
 * /sections — retired (S1 RD7): the sidebar lists the held sections and
 * their accounts, and All accounts (/accounts) lists every account, so the old section index
 * was redundant. Old links land on All accounts.
 */
import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = () => {
	throw redirect(308, '/accounts');
};
