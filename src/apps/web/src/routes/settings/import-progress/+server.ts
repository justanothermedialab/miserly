/**
 * How far the viewer's import has got: Import's button reads "Importing 3,200 of 9,989" while
 * the import runs. Only the viewer's own; null when none is running.
 */
import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { importProgress } from '$lib/server/import/actual-import';

export const GET: RequestHandler = async ({ locals }) => {
	const user = locals.user;
	if (!user) throw error(401, 'Not signed in');
	return json(importProgress(user.id));
};
