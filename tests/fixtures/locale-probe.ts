import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { serve } from '../helpers/http.ts';

// Run against an SEO build that has src/locales/fr.yaml and geoLanguage on.
const { createSiteHandler } = await import(
	pathToFileURL(join(process.cwd(), 'src/server/handler.ts')).href
);
const app = await serve(createSiteHandler());
const get = (url: string, headers: Record<string, string> = {}) =>
	app.inject({ url, headers });
const origin = 'https://invisiproxy.com';
const lang = (html: string) => /<html\b[^>]*\slang="([^"]+)"/.exec(html)?.[1];

try {
	// Crawlers send no Accept-Language and stay on English, wherever they are.
	for (const headers of [{}, { 'cf-ipcountry': 'FR' }] as Record<
		string,
		string
	>[]) {
		const home = await get('/', headers);
		assert.equal(home.statusCode, 200);
		assert.equal(lang(home.body), 'en');
	}
	const home = await get('/');
	assert.match(home.body, new RegExp(`rel="canonical" href="${origin}/"`));
	assert.match(home.body, new RegExp(`hreflang="fr" href="${origin}/fr/"`));
	assert.match(
		home.body,
		new RegExp(`hreflang="x-default" href="${origin}/"`)
	);
	assert.match(home.body, /property="og:locale" content="en_US"/);
	assert.match(home.body, /property="og:locale:alternate" content="fr_FR"/);
	assert.match(home.body, /"@type": "FAQPage"/);

	// Visitors who prefer French are sent to the French URL.
	for (const [url, headers, location] of [
		['/', { 'accept-language': 'fr-CA,en;q=0.5' }, '/fr/'],
		['/questions?q=1', { cookie: 'Language=fr' }, '/fr/questions?q=1'],
		['/', { 'accept-language': 'de', 'cf-ipcountry': 'FR' }, '/fr/'],
	] as const) {
		const response = await get(url, headers);
		assert.equal(response.statusCode, 302, url);
		assert.equal(response.headers.location, location, url);
		assert.match(String(response.headers.vary), /Accept-Language/);
	}
	const chosen = await get('/questions', {
		cookie: 'Language=en',
		'accept-language': 'fr',
	});
	assert.equal(chosen.statusCode, 200);
	assert.equal(lang(chosen.body), 'en');

	// French pages live under /fr/, whatever the browser asks for.
	for (const url of ['/fr', '/fr/', '/fr/questions', '/fr/browsing']) {
		const response = await get(url, { 'accept-language': 'en' });
		assert.equal(response.statusCode, 200, url);
		assert.equal(lang(response.body), 'fr', url);
		assert.equal(response.headers.vary, undefined, url);
	}
	const french = (await get('/fr/questions')).body;
	assert.match(french, /<title>FAQ InvisiProxy<\/title>/);
	assert.match(
		french,
		new RegExp(`rel="canonical" href="${origin}/fr/questions"`)
	);
	assert.match(french, /href="\/fr\/credits"/);
	const frenchHome = (await get('/fr/')).body;
	assert.match(frenchHome, /"inLanguage": "fr-FR"/);
	assert.doesNotMatch(frenchHome, /"@type": "FAQPage"/);

	// Only pages are translated; anything else under /fr/ does not exist.
	for (const url of ['/fr/sitemap.xml', '/fr/patreon', '/fr/missing'])
		assert.equal((await get(url)).statusCode, 404, url);

	const sitemap = (await get('/sitemap.xml')).body;
	assert.match(sitemap, new RegExp(`<loc>${origin}/fr/questions</loc>`));
	assert.match(
		sitemap,
		new RegExp(
			`<xhtml:link rel="alternate" hreflang="fr" href="${origin}/fr/questions"/>`
		)
	);
} finally {
	await app.close();
}
