import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [
		tailwindcss(),
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},

			// M4 packaging seam: adapter-node bundles ONE Node server, which both
			// deployment modes (D3) wrap — Electron on 127.0.0.1 (desktop) and a
			// Docker image (self-hosted). See docs/tech-stack.md.
			adapter: adapter()
		})
	]
});
