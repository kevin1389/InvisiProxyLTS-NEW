import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import test from 'node:test';
import {
	builtLocales,
	defaultLocale,
	type Locale,
	loadLocales,
	localeManifest,
	localePath,
	localizeSitemap,
} from '../../src/build/locales.ts';
import { buildValues } from '../../src/build/values.ts';
import {
	acceptedLanguages,
	type Languages,
	pickLanguage,
} from '../../src/server/language.ts';
import {
	languageTag,
	type Messages,
	pageUrl,
	route,
	setSiteValues,
	translate,
} from '../../src/site.ts';

function flatten(messages: Messages, prefix = ''): Record<string, string> {
	return Object.fromEntries(
		Object.entries(messages).flatMap(([key, value]) => {
			const path = prefix ? `${prefix}.${key}` : key;
			return typeof value === 'string'
				? [[path, value]]
				: Object.entries(flatten(value, path));
		})
	);
}

const markers = (text: string) =>
	[...text.matchAll(/\{\w+\}|<\/?\w+\/?>/g)].map(([marker]) => marker).sort();

test('every language file matches the keys, placeholders and tags in en.yaml', () => {
	const [english, ...others] = loadLocales();
	assert.equal(english.code, defaultLocale);
	const reference = flatten(english.messages);
	for (const locale of others) {
		const file = `src/locales/${locale.code}.yaml`;
		assert.notEqual(locale.name, english.name, `${file}: language.name`);
		for (const [key, text] of Object.entries(flatten(locale.messages))) {
			assert.ok(key in reference, `${file}: "${key}" is not in en.yaml`);
			assert.deepEqual(
				markers(text),
				markers(reference[key]),
				`${file}: "${key}" must keep the same {placeholders} and <tags>`
			);
		}
	}
});

test('every key used by the pages exists in en.yaml', () => {
	const reference = flatten(loadLocales()[0].messages);
	const clientDir = new URL('../../src/client/', import.meta.url);
	const missing: string[] = [];
	for (const file of readdirSync(clientDir, {
		recursive: true,
		encoding: 'utf8',
	})) {
		if (!file.endsWith('.tsx')) continue;
		const source = readFileSync(new URL(file, clientDir), 'utf8');
		const keys = source.matchAll(
			/translate\(\s*'([^']+)'|<Translation\s+id="([^"]+)"/g
		);
		for (const [, key = '', id = ''] of keys)
			if (!((key || id) in reference))
				missing.push(`${file}: ${key || id}`);
	}
	assert.deepEqual(missing, []);
});

test('singleLanguage builds only the chosen language', () => {
	const locale = (code: string): Locale => ({
		code,
		name: code,
		countries: [],
		maskedTerms: [],
		messages: {},
	});
	const locales = [locale('en'), locale('fr')];
	assert.deepEqual(builtLocales(locales, { singleLanguage: false }), locales);
	assert.deepEqual(builtLocales(locales, { singleLanguage: true }), [
		locales[0],
	]);
	assert.deepEqual(
		builtLocales(locales, { singleLanguage: true, language: 'FR' }),
		[locales[1]]
	);
	assert.throws(
		() => builtLocales(locales, { singleLanguage: true, language: 'de' }),
		/de\.yaml/
	);
	assert.equal(localePath('fr', 'index.html', 'fr'), 'index.html');
	assert.equal(localePath('en', 'index.html', 'fr'), 'locales/en/index.html');
	assert.equal(localeManifest([locales[1]]).default, 'fr');
});

test('translate fills placeholders and falls back to English', () => {
	setSiteValues({
		...buildValues,
		locale: 'fr',
		messages: { greeting: 'Salut {name}' },
		fallbackMessages: { greeting: 'Hello {name}', farewell: 'Bye' },
	});
	assert.equal(translate('greeting', { name: 'Ana' }), 'Salut Ana');
	assert.equal(translate('farewell'), 'Bye');
	assert.throws(() => translate('missing.key'), /missing\.key/);
});

test('Accept-Language is read in order of preference', () => {
	assert.deepEqual(acceptedLanguages('fr-CA,fr;q=0.9,en;q=0.8,*;q=0.5'), [
		'fr-ca',
		'fr',
		'en',
	]);
	assert.deepEqual(acceptedLanguages('fr;q=0.2, en'), ['en', 'fr']);
	assert.deepEqual(acceptedLanguages(undefined), []);
});

test('the Language cookie wins, then Accept-Language, then the country', () => {
	const languages: Languages = {
		default: 'en',
		codes: ['en', 'fr'],
		countries: { FR: 'fr' },
	};
	const request = (headers: Record<string, string>) =>
		({ headers }) as unknown as IncomingMessage;
	const pick = (headers: Record<string, string>, useCountry = true) =>
		pickLanguage(request(headers), languages, useCountry);

	assert.equal(
		pick({ cookie: 'a=1; Language=fr', 'accept-language': 'en' }),
		'fr'
	);
	assert.equal(
		pick({ cookie: 'Language=xx', 'accept-language': 'fr-CA' }),
		'fr'
	);
	assert.equal(pick({ cookie: 'Language=%E0' }), 'en');
	assert.equal(pick({ 'accept-language': 'de,fr;q=0.5' }), 'fr');
	assert.equal(
		pick({ 'accept-language': 'en-US', 'cf-ipcountry': 'FR' }),
		'en'
	);
	assert.equal(pick({ 'accept-language': 'de', 'cf-ipcountry': 'fr' }), 'fr');
	assert.equal(
		pick({ 'accept-language': 'de', 'cf-ipcountry': 'FR' }, false),
		'en'
	);
	assert.equal(pick({}), 'en');
});

test('in SEO mode other languages get their own page URLs', () => {
	const pages = (locale: string, usingSEO = true) =>
		setSiteValues({
			...buildValues,
			usingSEO,
			basePath: '/',
			aliases: {},
			cacheBust: {},
			locale,
			locales: [
				{ code: 'en', name: 'English' },
				{ code: 'fr', name: 'Français' },
			],
			pageNames: ['', 'questions'],
		});
	pages('fr');
	assert.equal(route('/'), '/fr/');
	assert.equal(route('/questions'), '/fr/questions');
	assert.equal(route('questions'), '/fr/questions');
	assert.equal(route('/patreon'), '/patreon');
	assert.equal(route('/assets/js/common.js'), '/assets/js/common.js');
	assert.equal(pageUrl('questions'), 'https://invisiproxy.com/fr/questions');
	assert.equal(pageUrl('', 'en'), 'https://invisiproxy.com/');
	pages('en');
	assert.equal(route('/questions'), '/questions');
	pages('fr', false);
	assert.equal(route('/questions'), '/questions');
	assert.equal(pageUrl('questions'), 'https://invisiproxy.com/questions');
	assert.equal(languageTag('en'), 'en-US');
	assert.equal(languageTag('fr'), 'fr-FR');
	assert.equal(languageTag('pt-br'), 'pt-BR');
});

test('the sitemap lists every language of each page', () => {
	const xml = [
		'<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
		'    <url>',
		'        <loc>https://invisiproxy.com/</loc>',
		'        <priority>1.00</priority>',
		'    </url>',
		'    <url>',
		'        <loc>https://invisiproxy.com/questions</loc>',
		'    </url>',
		'</urlset>',
	].join('\n');
	assert.equal(localizeSitemap(xml, ['en']), xml);
	const sitemap = localizeSitemap(xml, ['en', 'fr']);
	assert.match(sitemap, /xmlns:xhtml="http:\/\/www\.w3\.org\/1999\/xhtml"/);
	assert.deepEqual(
		[...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(([, loc]) => loc),
		[
			'https://invisiproxy.com/',
			'https://invisiproxy.com/fr/',
			'https://invisiproxy.com/questions',
			'https://invisiproxy.com/fr/questions',
		]
	);
	const links = (hreflang: string, href: string) =>
		sitemap.split(
			`<xhtml:link rel="alternate" hreflang="${hreflang}" href="${href}"/>`
		).length - 1;
	assert.equal(links('fr', 'https://invisiproxy.com/fr/questions'), 2);
	assert.equal(links('en', 'https://invisiproxy.com/questions'), 2);
	assert.equal(links('x-default', 'https://invisiproxy.com/'), 2);
	assert.equal(sitemap.split('<priority>1.00</priority>').length - 1, 2);
});
