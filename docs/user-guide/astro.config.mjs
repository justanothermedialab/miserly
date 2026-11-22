// The user guide's website (Starlight). The pages live in pages/ and are also built into the
// one offline file the Windows zip ships (build_html.py), so they stay plain Markdown: each has
// a title and a sidebar order in its front matter, and links between pages are written as
// `x.md` or `x.md#heading` (they also work on GitHub), which the plugin below turns into this
// site's addresses.
import fs from 'node:fs';
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import { satteri } from '@astrojs/markdown-satteri';

const base = '/docs';

/** The sidebar, from each page's front matter (`title`, `sidebar: label, order`), the same fields
 *  build_html.py reads. Listed here because Starlight's own list would nest the pages under a
 *  "pages" heading, as they sit outside src/content/docs. */
const sidebar = fs
	.readdirSync('pages')
	.filter((f) => f.endsWith('.md'))
	.map((f) => {
		const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(fs.readFileSync(`pages/${f}`, 'utf8'))?.[1] ?? '';
		const field = (k) => new RegExp(`^[ \\t]*${k}:[ \\t]*(\\S.*?)[ \\t]*$`, 'm').exec(front)?.[1];
		const slug = f.replace(/\.md$/, '');
		return { order: Number(field('order')), label: field('label') ?? field('title'), slug: slug === 'index' ? '' : slug };
	})
	.sort((a, b) => a.order - b.order)
	.map(({ label, slug }) => ({ label, slug }));

/** `x.md#y` -> `/docs/x/#y`; `index.md` -> `/docs/`. Leaves every other link alone. */
const pageLinks = {
	name: 'guide-page-links',
	link(node, ctx) {
		const m = /^([\w-]+)\.md(#[\w-]+)?$/.exec(node.url);
		if (m) ctx.setProperty(node, 'url', `${base}/${m[1] === 'index' ? '' : `${m[1]}/`}${m[2] ?? ''}`);
	},
};

export default defineConfig({
	base,
	trailingSlash: 'always',
	markdown: { processor: satteri({ mdastPlugins: [pageLinks] }) },
	integrations: [
		starlight({
			title: 'Miserly guide',
			sidebar,
		}),
	],
});
