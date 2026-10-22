// Runs the Vite dev server in a fixture, edits each kind of source, and checks
// the served site picks every change up without a manual rebuild.
import assert from 'node:assert/strict';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import {
	type ClientRequest,
	createServer as createHttpServer,
	request,
} from 'node:http';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const root = process.cwd();
const load = <T>(path: string): Promise<T> =>
	import(pathToFileURL(join(root, path)).href);
const { config, serverUrl } =
	await load<typeof import('../../src/config.ts')>('src/config.ts');
const { getPathAliases, getAltPrefix } = await load<
	typeof import('../../src/obfuscation/paths.ts')
>('src/obfuscation/paths.ts');
const { tryReadFile, preloaded404 } = await load<
	typeof import('../../src/server/files.ts')
>('src/server/files.ts');
const wispSource = 'src/server/wisp.ts';
const testBrowser = process.env.INVISIPROXY_TEST_BROWSER === '1';
const targetPort = 18765;
if (testBrowser)
	await writeFile(
		wispSource,
		(await readFile(wispSource, 'utf8'))
			.replace('allowDirectIP: false', 'allowDirectIP: true')
			.replace('allowPrivateIPs: false', 'allowPrivateIPs: true')
			.replace('allowLoopbackIPs: false', 'allowLoopbackIPs: true')
			.replace(
				'ports: [80, 443,',
				`ports: [${targetPort}, 80, 443,`
			)
	);

await mkdir('views/dist', { recursive: true });
await writeFile('views/dist/index.html', 'stale startup page');
await writeFile('views/dist/stale.txt', 'stale startup asset');
await writeFile(
	'views/dist/.obfuscation.json',
	JSON.stringify({
		version: 1,
		seed: 'previous-build',
		aliases: { links: '_0xoldpage' },
		classes: {},
	})
);

const server = await createServer({
	root,
	configLoader: 'native',
	logLevel: 'warn',
});
await server.listen();
const origin = `http://127.0.0.1:${server.config.server.port}`;
const url = (path: string) => {
	const aliases = getPathAliases();
	return (
		origin +
		serverUrl.pathname +
		path
			.split('/')
			.map(
				(part) =>
					aliases[`files/${part}`] ||
					aliases[`prefixes/${part}`] ||
					aliases[part] ||
					part
			)
			.join('/')
	);
};

async function eventually(
	label: string,
	check: () => Promise<boolean>,
	timeout = 30000
) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		if (await check().catch(() => false)) {
			console.log(`ok: ${label}`);
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	assert.fail(`Timed out waiting for: ${label}`);
}
const get = (path: string, method = 'GET') =>
	new Promise<{ status: number; body: string }>((resolve, reject) =>
		request(
			url(path),
			{ method, agent: false, timeout: 5000 },
			(response) => {
				let body = '';
				response.setEncoding('utf8');
				response.on('data', (chunk) => (body += chunk));
				response.on('end', () =>
					resolve({ status: response.statusCode ?? 0, body })
				);
				response.on('close', () => {
					if (!response.complete)
						reject(new Error(`Response for ${path} was cut short`));
				});
			}
		)
			.on('timeout', function (this: ClientRequest) {
				this.destroy(new Error(`Request for ${path} timed out`));
			})
			.on('error', reject)
			.end()
	);
const served = async (path: string, text: string) => {
	const response = await get(path);
	return response.status === 200 && response.body.includes(text);
};
const scriptLogs = async (path: string, text: string) => {
	const response = await get(path);
	if (response.status !== 200) return false;
	const messages: unknown[] = [];
	const document = { getElementById: () => null, addEventListener() {} };
	runInNewContext(response.body, {
		document,
		window: { document },
		console: { log: (message: unknown) => messages.push(message) },
	});
	return messages.includes(text);
};

try {
	const state = JSON.parse(
		await readFile('views/dist/.obfuscation.json', 'utf8')
	);
	assert.notEqual(
		state.seed,
		'previous-build',
		'startup starts a fresh build'
	);
	assert.notEqual(
		state.aliases.links,
		'_0xoldpage',
		'startup drops old aliases'
	);
	if (!config.usingSEO) assert.match(state.aliases.links, /^[A-Za-z]+$/);
	const stylesheet = await get('assets/css/style.css');
	assert.equal(stylesheet.status, 200);
	if (config.usingSEO) {
		assert.deepEqual(state.classes, {});
		assert.ok(stylesheet.body.includes('.fancybutton'));
	} else {
		assert.ok(state.classes.fancybutton);
		assert.ok(stylesheet.body.includes(`.${state.classes.fancybutton}`));
		assert.doesNotMatch(stylesheet.body, /\.fancybutton\b/);
	}
	assert.equal(
		(await get('stale.txt')).status,
		404,
		'startup removes stale assets'
	);
	assert.ok(
		!(await readFile('views/dist/index.html', 'utf8')).includes(
			'stale startup page'
		)
	);
	const root = await fetch(url(''));
	assert.equal(root.status, 200);
	assert.equal(root.headers.get('cache-control'), 'no-store');
	assert.ok(
		(await root.text()).includes(`${serverUrl.pathname}@vite/client`),
		'documents load the Vite client'
	);
	const viteClient = await fetch(
		`${origin}${serverUrl.pathname}@vite/client`
	);
	assert.equal(viteClient.status, 200);
	const envPath = (await viteClient.text()).match(
		/['"]([^'"]+\/env\.mjs)['"]/
	);
	assert.ok(envPath, 'the Vite client imports its environment module');
	const viteEnv = await fetch(new URL(envPath[1], origin));
	assert.equal(
		viteEnv.status,
		200,
		'Vite dependencies bypass the site handler'
	);
	assert.match(viteEnv.headers.get('content-type') || '', /javascript/);
	const socket = new WebSocket(
		origin.replace('http:', 'ws:') +
			getAltPrefix('wisp', serverUrl.pathname)
	);
	try {
		await new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(
				() => reject(new Error('Wisp handshake timed out')),
				10000
			);
			socket.onmessage = () => {
				clearTimeout(timeout);
				resolve();
			};
			socket.onerror = () => {
				clearTimeout(timeout);
				reject(new Error('Wisp connection failed'));
			};
		});
	} finally {
		socket.close();
	}
	if (testBrowser) {
		const target = createHttpServer((_req, res) => {
			res.setHeader('content-type', 'text/html');
			res.end(
				'<!doctype html><h1 id="proxy-smoke">Proxied through Wisp</h1><script>document.documentElement.dataset.proxySmoke="executed";</script>'
			);
		});
		await new Promise<void>((resolve) =>
			target.listen(targetPort, '127.0.0.1', resolve)
		);
		const targetUrl = `http://127.0.0.1:${targetPort}/`;
		const browser = await chromium.launch({
			headless: true,
			args: ['--no-sandbox'],
		});
		try {
			const context = await browser.newContext();
			await context.route('**/*', (request) =>
				new URL(request.request().url()).origin === origin
					? request.continue()
					: request.fulfill({
							status: 200,
							contentType: 'application/javascript',
							body: '',
						})
			);
			await context.addInitScript(() =>
				Object.assign(window, {
					AOS: { init() {}, refresh() {} },
					tippy: () => [],
					loadFull: async () => {},
					tsParticles: { load: async () => ({ destroy() {} }) },
				})
			);
			const page = await context.newPage();
			page.setDefaultTimeout(15000);
			const errors: string[] = [];
			page.on('pageerror', (error) => errors.push(error.message));
			page.on('requestfailed', (request) =>
				errors.push(`${request.url()}: ${request.failure()?.errorText}`)
			);
			if (config.disguiseFiles) await page.goto(url(''));
			for (const transport of ['libcurl', 'epoxy']) {
				await page.goto(url('browsing'));
				await page.waitForFunction(
					() => window.$invisiScramjet?.ready === true
				);
				if (transport === 'epoxy') {
					await page.locator('#settings-panel > summary').click();
					await Promise.all([
						page.waitForEvent('load'),
						page
							.locator('#browsing-transport')
							.selectOption(transport),
					]);
					await page.waitForFunction(
						() => window.$invisiScramjet?.ready === true
					);
				}
				await page.locator('#search-input').fill(targetUrl);
				await page.locator('#search-input').press('Enter');
				await page.waitForURL(new URL(url('s')).href);
				const frame = page.frameLocator('#frame');
				try {
					await frame.locator('#proxy-smoke').waitFor();
					await frame
						.locator('html[data-proxy-smoke="executed"]')
						.waitFor();
				} catch (cause) {
					throw new Error(
						`${transport} proxy navigation failed: ${errors.join('\n')}`,
						{ cause }
					);
				}
				console.log(
					`ok: real ${transport} proxied page and rewritten script`
				);
			}
		} finally {
			await browser.close();
			target.closeAllConnections();
			await new Promise<void>((resolve) => target.close(() => resolve()));
		}
	}

	const page = 'src/client/Document.tsx';
	await writeFile(
		page,
		(await readFile(page, 'utf8')).replace(
			'<Page />',
			'<Page /><i data-probe="fresh-page" />'
		)
	);
	await eventually('page edit', () => served('', 'fresh-page'));

	await appendFile(
		'views/assets/js/link.js',
		'\nconsole.log("probe-script");\n'
	);
	await eventually('script edit', () =>
		scriptLogs('assets/js/link.js', 'probe-script')
	);
	await appendFile(
		'views/assets/css/style.css',
		'\n.probe-style{color:red}\n'
	);
	await eventually('stylesheet edit', () =>
		served('assets/css/style.css', 'probe-style')
	);
	await appendFile('views/assets/txt/alt-blacklist.txt', '\nprobe-static\n');
	await eventually('static file edit', () =>
		served('assets/txt/alt-blacklist.txt', 'probe-static')
	);
	await appendFile(
		'src/client/faq-search.tsx',
		'\nconsole.log("probe-faq");\n'
	);
	await eventually('FAQ search edit', () =>
		scriptLogs('assets/js/faq-search.js', 'probe-faq')
	);

	const api = () => get('api/link', 'POST').then((r) => r.body);
	await api();
	const dispenser = 'src/server/link-dispenser.ts';
	await writeFile(
		dispenser,
		(await readFile(dispenser, 'utf8')).replace(
			'Please wait',
			'Probe: wait'
		)
	);
	await eventually('server code edit', async () =>
		(await api()).includes('Probe: wait')
	);

	const httpServer = server.httpServer;
	await writeFile(
		'views/assets/js/probe-new.js',
		'console.log("probe-new");\n'
	);
	await eventually(
		'new script',
		async () =>
			server.httpServer !== httpServer &&
			Boolean(server.httpServer?.listening) &&
			(await scriptLogs('assets/js/probe-new.js', 'probe-new')),
		180000
	);

	assert.deepEqual(
		tryReadFile('missing', pathToFileURL(`${root}/`)),
		preloaded404()
	);
} finally {
	await server.close();
}
console.log(
	'Development serving, page, script, stylesheet, static, FAQ, server code and new-file updates passed.'
);
