import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { parse, type DefaultTreeAdapterTypes } from 'parse5';
import { serve, testClientIp } from '../helpers/http.ts';

const load = <T>(path: string): Promise<T> =>
	import(pathToFileURL(join(process.cwd(), path)).href);
const { createSiteHandler } = await load<
	typeof import('../../src/server/handler.ts')
>('src/server/handler.ts');
const { config, serverUrl } =
	await load<typeof import('../../src/config.ts')>('src/config.ts');
const { getPathAliases, getAltPrefix } = await load<
	typeof import('../../src/obfuscation/paths.ts')
>('src/obfuscation/paths.ts');
const { loadRoutes } = await load<typeof import('../../src/server/routes.ts')>(
	'src/server/routes.ts'
);
const { pages, externalPages } = loadRoutes();
assert.equal(pages[''], 'index.html');
const manifestFile = getPathAliases()['files/manifest.json'] || 'manifest.json';
assert.equal(pages[manifestFile], manifestFile);
assert.equal('routes.json' in pages || 'GAMES.md' in pages, false);
const base = serverUrl.pathname;
const app = await serve(
	createSiteHandler({
		wispRedirect: '/relay-unavailable',
		clientIp: testClientIp,
	})
);
const decode = (buffer: Buffer) =>
	buffer[0] === 0x1f && buffer[1] === 0x8b
		? gunzipSync(buffer).toString()
		: buffer.toString();
const nodes = (
	root: DefaultTreeAdapterTypes.Node
): DefaultTreeAdapterTypes.Element[] => [
	...('tagName' in root ? [root] : []),
	...('childNodes' in root ? root.childNodes.flatMap(nodes) : []),
];
const references = new Map<string, Set<string>>();
const recordReference = (value: string, from: string) => {
	if (!value || value.startsWith('#')) return;
	const target = new URL(value, app.origin + from);
	if (target.origin !== app.origin) return;
	const key = target.pathname + target.search;
	if (!references.has(key)) references.set(key, new Set());
	references.get(key)!.add(from);
};
try {
	for (const [name, file] of Object.entries(pages)) {
		const suffix =
			config.disguiseFiles && file.endsWith('.html') ? '.ico' : '';
		const response = await app.inject(`${base + name + suffix}?cache=test`);
		assert.equal(
			response.statusCode,
			200,
			`${name}: ${response.body.slice(0, 120)}`
		);
		const expected = await readFile(join('views/dist', file));
		assert.deepEqual(response.rawPayload, expected, name);
		if (file.endsWith('.css')) {
			for (const match of decode(expected).matchAll(
				/url\(\s*["']?([^\s"')]+)["']?\s*\)/g
			))
				recordReference(match[1], base + name);
		}
		if (file.endsWith('manifest.json')) {
			const manifest = JSON.parse(decode(expected));
			for (const icon of manifest.icons || [])
				recordReference(icon.src, base + name);
			if (manifest.start_url)
				recordReference(manifest.start_url, base + name);
		}
		if (file.endsWith('sitemap.xml') && config.usingSEO) {
			for (const match of decode(expected).matchAll(
				/<loc>([^<]+)<\/loc>/g
			))
				recordReference(
					base + new URL(match[1]).pathname.replace(/^\//, ''),
					base + name
				);
		}
		if (file.endsWith('.html')) {
			const html = decode(expected);
			assert.doesNotMatch(
				html,
				/\/\*\s*InvisiProxy obfuscated\s*\*\//i,
				file
			);
			assert.ok(html.toLowerCase().startsWith('<!doctype html>'), file);
			const elements = nodes(parse(html));
			const ids = new Set(
				elements.flatMap((node) =>
					node.attrs
						.filter((attr) => attr.name === 'id')
						.map((attr) => attr.value)
				)
			);
			for (const node of elements)
				for (const attr of node.attrs)
					if (['href', 'src', 'poster'].includes(attr.name)) {
						if (
							attr.name === 'href' &&
							attr.value.startsWith('#') &&
							attr.value.length > 1
						)
							assert.ok(
								ids.has(
									decodeURIComponent(attr.value.slice(1))
								),
								`${file}: missing anchor ${attr.value}`
							);
						recordReference(attr.value, base + name);
					}
			for (const node of elements) {
				if (node.tagName === 'style') {
					const css = node.childNodes
						.map((child) => ('value' in child ? child.value : ''))
						.join('');
					for (const match of css.matchAll(
						/url\(\s*["']?([^\s"')]+)["']?\s*\)/g
					))
						recordReference(match[1], base + name);
				}
				if (
					node.tagName === 'meta' &&
					node.attrs.some((attr) =>
						[
							'og:image',
							'twitter:image',
							'msapplication-TileImage',
						].includes(attr.value)
					)
				) {
					const content = node.attrs.find(
						(attr) => attr.name === 'content'
					);
					if (content) recordReference(content.value, base + name);
				}
			}
			assert.ok(
				elements.some(
					(node) => node.tagName === 'title' && node.childNodes.length
				),
				file
			);
			assert.ok(
				elements.some((node) => node.tagName === 'body'),
				file
			);
			assert.ok(!html.includes('PRIVATE_TEST_MARKER'), file);
			assert.ok(!html.includes('private/test-links.txt'), file);
		}
	}
	for (const [target, sources] of references) {
		assert.ok(
			target.startsWith(base),
			`${target} escapes the configured base path (${[...sources].join(', ')})`
		);
		const pathname = new URL(target, app.origin).pathname;
		const relative = pathname.slice(base.length).replace(/\.ico$/, '');
		const page = pages[relative];
		const request =
			config.disguiseFiles && page?.endsWith('.html') && pathname !== base
				? pathname + '.ico'
				: target;
		const response = await app.inject(request);
		if (/\.css$/.test(pathname)) {
			for (const match of response.body.matchAll(
				/url\(\s*["']?([^\s"')]+)["']?\s*\)/g
			))
				recordReference(match[1], pathname);
		}
		assert.ok(
			[200, 302].includes(response.statusCode),
			`${target}: HTTP ${response.statusCode} (linked from ${[...sources].join(', ')})`
		);
	}
	const root = await app.inject(base);
	assert.equal(root.statusCode, 200, 'root');
	assert.equal(
		root.headers['cache-control'],
		'no-cache',
		'documents revalidate so stale obfuscation aliases cannot linger'
	);
	assert.deepEqual(
		root.rawPayload,
		await readFile(
			join(
				'views/dist',
				config.disguiseFiles
					? 'pages/misc/deobf/entry-point.html'
					: 'index.html'
			)
		),
		'root page'
	);
	for (const name of ['index', 'login'])
		assert.equal(
			(
				await app.inject(
					base + name + (config.disguiseFiles ? '.ico' : '')
				)
			).statusCode,
			404,
			`${name} is not a route`
		);

	const linksName = getPathAliases().links || 'links';
	if (config.disguiseFiles) {
		const loader = await app.inject(base + linksName);
		assert.equal(loader.statusCode, 200);
		assert.deepEqual(
			loader.rawPayload,
			await readFile('views/dist/pages/misc/deobf/loader.html')
		);
	}
	assert.equal(
		pages[getPathAliases().browsing || 'browsing'],
		'pages/proxnav/scramjet.html'
	);
	assert.equal(
		(getPathAliases().browsing || 'browsing') in externalPages,
		false
	);
	for (const [name, target] of Object.entries(externalPages)) {
		const response = await app.inject(base + name);
		assert.equal(response.statusCode, 302, name);
		assert.equal(
			response.headers.location,
			typeof target === 'string' ? target : target.default
		);
	}
	for (const [name, target] of Object.entries(externalPages.github)) {
		const response = await app.inject(`${base}github/${name}`);
		assert.equal(response.statusCode, 302, `github/${name}`);
		assert.equal(response.headers.location, target);
	}
	assert.equal((await app.inject(`${base}github/not-real`)).statusCode, 404);
	const wisp = await app.inject(getAltPrefix('wisp', base));
	assert.equal(wisp.statusCode, 302);
	assert.equal(wisp.headers.location, '/relay-unavailable');

	for (const name of ['sw.js', 'sw-blacklist.js']) {
		const response = await app.inject(
			base + (getPathAliases()[`files/${name}`] || name)
		);
		assert.equal(response.statusCode, 200);
		assert.equal(response.headers['service-worker-allowed'], base);
		assert.equal(response.headers['cache-control'], 'no-cache', name);
		assert.match(response.headers['content-type'] ?? '', /javascript/);
		assert.doesNotMatch(
			response.body,
			/(?:from\s*|import\s*\(?\s*)['"']build:invisiproxy/
		);
	}
	for (const [prefix, name] of [
		['scram', 'scramjet.wasm'],
		['scram', 'controller.api.js'],
		['libcurl', 'index.mjs'],
		['epoxy', 'index.mjs'],
	]) {
		const response = await app.inject(
			getAltPrefix(prefix, base) +
				(getPathAliases()[`files/${name}`] || name)
		);
		assert.equal(response.statusCode, 200, `${prefix}/${name}`);
		assert.ok(response.rawPayload.length > 0);
		for (const encoding of ['br', 'gzip']) {
			const compressed = await app.inject({
				url:
					getAltPrefix(prefix, base) +
					(getPathAliases()[`files/${name}`] || name),
				headers: { 'accept-encoding': encoding },
			});
			assert.equal(compressed.statusCode, 200);
			assert.equal(compressed.headers['content-encoding'], encoding);
			assert.match(String(compressed.headers.vary), /Accept-Encoding/i);
			assert.deepEqual(
				encoding === 'br'
					? brotliDecompressSync(compressed.rawPayload)
					: gunzipSync(compressed.rawPayload),
				response.rawPayload,
				`${prefix}/${name}: ${encoding} preserves runtime bytes`
			);
			assert.ok(
				compressed.rawPayload.length < response.rawPayload.length
			);
		}
	}
	// Misses inside static/proxy directories must fail honestly: the
	// anti-detection favicon document cannot execute as a script or resolve
	// as an asset, and it must never be cached.
	for (const url of [
		`${base}assets/js/definitely-missing-${Date.now()}.js`,
		`${getAltPrefix('scram', base)}network/frame123/abc456/${encodeURIComponent(
			'https://example.com/main.js'
		)}`,
	]) {
		const missing = await app.inject(url);
		assert.equal(missing.statusCode, 404, url);
		assert.doesNotMatch(
			String(missing.headers['content-type']),
			/image\/vnd\.microsoft\.icon/i,
			url
		);
		assert.equal(missing.headers['cache-control'], 'no-store', url);
		assert.equal(missing.body, 'Not Found', url);
	}
	// Script and worker requests must never receive the anti-detection
	// documents (loader HTML or the favicon page): browsers refuse to
	// execute them and report strict MIME type errors.
	for (const [url, dest] of [
		[`${base}missing-root-script-${Date.now()}.js`, 'script'],
		[`${base}missing-root-module-${Date.now()}.mjs`, 'script'],
		[`${base}missing-plain-${Date.now()}`, 'worker'],
	] as const) {
		const res = await app.inject({
			url,
			headers: { 'sec-fetch-dest': dest },
		});
		assert.equal(res.statusCode, 404, url);
		assert.doesNotMatch(
			String(res.headers['content-type']),
			/text\/html|image\/vnd\.microsoft\.icon/i,
			url
		);
		assert.equal(res.headers['cache-control'], 'no-store', url);
	}
	// Even an existing page must never be handed to a script destination:
	// the page layer can only answer with HTML documents or redirects, and
	// both are refused by the browser's strict MIME check.
	const rootScript = await app.inject({
		url: base,
		headers: { 'sec-fetch-dest': 'script' },
	});
	assert.equal(rootScript.statusCode, 404, 'page as script destination');
	assert.doesNotMatch(
		String(rootScript.headers['content-type']),
		/text\/html|image\/vnd\.microsoft\.icon/i,
		'page as script destination'
	);
	assert.equal(rootScript.headers['cache-control'], 'no-store');
	// Directory roots inside proxy dirs stay with the dir handler instead
	// of falling back to the page layer's loader or favicon document.
	const scramRoot = getAltPrefix('scram', base);
	for (const url of [scramRoot, scramRoot.slice(0, -1)]) {
		const res = await app.inject(url);
		assert.equal(res.statusCode, 404, url);
		assert.doesNotMatch(
			String(res.headers['content-type']),
			/text\/html|image\/vnd\.microsoft\.icon/i,
			url
		);
		assert.equal(res.headers['cache-control'], 'no-store', url);
	}
	for (const name of [
		'common.js',
		'csel.js',
		'card.js',
		'link.js',
		'loader.js',
		'register-sw.js',
		'faq-search.js',
	]) {
		const response = await app.inject(
			`${base}assets/js/${getPathAliases()[`files/${name}`] || name}`
		);
		assert.equal(response.statusCode, 200, name);
		assert.ok(response.body.trim(), name);
		assert.doesNotMatch(
			response.body,
			/\/\*\s*InvisiProxy obfuscated\s*\*\//i,
			name
		);
	}
	assert.equal(
		(
			await app.inject(
				`${base}assets/css/${getPathAliases()['files/style.css'] || 'style.css'}`
			)
		).statusCode,
		200
	);
	const { siteFiles } = await load<
		typeof import('../../src/build/sources.ts')
	>('src/build/sources.ts');
	for (const file of siteFiles().filter(
		(file) => file.kind === 'vendor-script' || file.target.endsWith('.wasm')
	)) {
		const built = await readFile(join('views/dist', file.target));
		const original = await readFile(file.source);
		if (file.kind === 'vendor-script' && !config.usingSEO) {
			assert.notDeepEqual(
				built,
				original,
				`${file.target} passes through Merp`
			);
			assert.doesNotMatch(
				built.toString(),
				/\/\*\s*InvisiProxy obfuscated\s*\*\//i
			);
		} else
			assert.deepEqual(
				built,
				original,
				`${file.target} keeps its binary format`
			);
	}

	for (const path of [
		'missing.txt',
		'private/test-links.txt',
		'config.json',
		'.obfuscation.json',
		'assets/../.obfuscation.json',
		'src/config.ts',
		'assets/%2e%2e/%2e%2e/private/test-links.txt',
	]) {
		const response = await app.inject(base + path);
		assert.equal(response.statusCode, 404, path);
		assert.ok(!response.body.includes('PRIVATE_TEST_MARKER'));
	}
	const disguisedError = await app.inject(
		`${base}not-real${config.disguiseFiles ? '.ico' : ''}`
	);
	assert.equal(disguisedError.statusCode, 404);
	assert.ok(decode(disguisedError.rawPayload).includes('<html'));
	const hiddenHistory = await app.inject({
		url: base + linksName + (config.disguiseFiles ? '.ico' : ''),
		headers: { cookie: 'HistoryHide=true', 'sec-fetch-dest': 'document' },
	});
	assert.equal(hiddenHistory.statusCode, 404);
	const api = await app.inject({
		method: 'POST',
		url: `${base}api/link`,
		headers: { cookie: 'HistoryHide=true', 'sec-fetch-dest': 'empty' },
	});
	assert.equal(api.statusCode, 200);
	assert.equal(api.headers['cache-control'], 'no-store');
	assert.deepEqual(Object.keys(api.json()), ['link']);
	assert.ok(
		['https://first.example/', 'https://second.example/'].includes(
			api.json().link
		)
	);
	assert.equal(
		(await app.inject({ method: 'POST', url: `${base}api/link` }))
			.statusCode,
		429
	);
	await writeFile(config.mirrorLinksFile, 'https://restocked.example/');
	const restocked = await app.inject({
		method: 'POST',
		url: `${base}api/link`,
		remoteAddress: '192.0.2.2',
	});
	assert.equal(restocked.json().link, 'https://restocked.example/');
	const directories = await readdir('views/dist', { withFileTypes: true });
	const translated =
		Object.keys(
			JSON.parse(await readFile('views/dist/locales.json', 'utf8'))
				.locales
		).length > 1;
	assert.deepEqual(
		directories
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort(),
		[
			'assets',
			'epoxy',
			'libcurl',
			...(translated ? ['locales'] : []),
			'pages',
			'scram',
		]
	);
	const files = await readdir('views/dist', { recursive: true });
	assert.ok(!files.includes('pages/surf.html'));

	assert.ok(
		!files.some(
			(file) =>
				file.includes('test-links') || file.includes('config.json')
		)
	);
	assert.equal((await app.inject(`${base}favicon.ico`)).rawPayload.length, 0);
	console.log(
		`Built documents, ${references.size} internal link/asset references, routes, redirects, service workers, history status and private links passed.`
	);
} finally {
	await app.close();
}
