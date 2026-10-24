// v4: follow the user's REAL flow — search the store for the game, click it
// (it opens in a new proxied tab), then watch the launch page: canvases,
// workers, SharedArrayBuffer / crossOriginIsolated (emulator needs),
// request failures, and console errors. Works against live or local preview.
import { chromium } from 'playwright';

const base = process.argv[2];
if (!base) {
	console.error('usage: node probe-launch4.mjs <base-url> [game-title]');
	process.exit(1);
}
const url = base.endsWith('/') ? base : base + '/';
const gameTitle = process.argv[3] || 'Vice';
const log = (...a) => console.log(...a);

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const context = await browser.newContext();
const page = await context.newPage();

const tabs = [];
context.on('popup', (p) => {
	tabs.push(p);
	log('[new tab]', p.url().slice(0, 120));
	const wire = (what) => {
		p.on('console', (m) => {
			if (m.type() === 'error') log(`[${what} console]`, m.text().slice(0, 170));
		});
		p.on('pageerror', (e) => log(`[${what} pageerror]`, String(e).slice(0, 170)));
		p.on('requestfailed', (r) =>
			log(`[${what} failed]`, r.failure()?.errorText, r.url().slice(0, 120))
		);
		p.on('response', (r) => {
			if (r.status() >= 400) log(`[${what} ${r.status()}]`, r.url().slice(0, 130));
		});
	};
	wire('tab');
});

const proxyFrame = async (p = page) => {
	for (let i = 0; i < 40; i++) {
		const f = p.frames().find((x) => x !== p.mainFrame() && x.url().includes('/scram/'));
		if (f) return f;
		await p.waitForTimeout(500);
	}
	return null;
};

try {
	await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
	await page.waitForTimeout(4000);
	await page.goto(url + 'scramjet', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
	await page.locator('#search-input').waitFor({ timeout: 25000 });
	await page.waitForFunction(() => window.$invisiScramjet?.ready === true, null, { timeout: 30000 });
	log('[ready]');

	// Store, then search for the game like the user would.
	await page.locator('#search-input').fill('https://playobsidian.com/store');
	await page.locator('#search-input').press('Enter');
	await page.waitForURL(/\/s($|\?)/, { timeout: 30000 }).catch(() => {});
	let frame = await proxyFrame();
	await frame
		.waitForFunction(() => document.body && document.body.innerText.length > 100, null, { timeout: 60000 })
		.catch(() => {});
	log('[store] loaded');

	const storeSearch = frame
		.locator('input[placeholder*="Search" i], input[type="search"]')
		.first();
	if (await storeSearch.count()) {
		await storeSearch.fill(gameTitle).catch(() => {});
		await frame.keyboard.press('Enter').catch(() => {});
		await page.waitForTimeout(8000);
		frame = (await proxyFrame()) || frame;
		log('[store] searched:', gameTitle);
	}
	const hits = await frame
		.evaluate((title) =>
			[...document.querySelectorAll('a,button,[role="button"],div[class*="card" i]')]
				.map((el) => ({
					tag: el.tagName,
					text: (el.innerText || '').trim().slice(0, 70),
					href: el.getAttribute('href') || '',
				}))
				.filter((e) => e.text && new RegExp(title, 'i').test(e.text))
				.slice(0, 10)
		, gameTitle)
		.catch(() => []);
	log('[game hits]', JSON.stringify(hits, null, 1));

	if (!hits.length) {
		log('[abort] game not found in store');
		throw new Error('game not found');
	}

	// Click the most specific hit (prefer the one whose text is shortest — a title).
	const hit = hits.sort((a, b) => a.text.length - b.text.length)[0];
	log('[clicking]', JSON.stringify(hit));
	const clickable = frame
		.locator(`a:has-text("${gameTitle}"), button:has-text("${gameTitle}")`)
		.first();
	if (await clickable.count()) await clickable.click({ timeout: 10000 }).catch((e) => log('[click]', String(e).slice(0, 120)));
	else
		await frame
			.evaluate((t) => {
				const el = [...document.querySelectorAll('a,button,[role="button"],div')].find(
					(x) => x.innerText && x.innerText.trim().startsWith(t) && x.onclick !== null
				);
				(el || document.body).click();
			}, gameTitle)
			.catch(() => {});
	await page.waitForTimeout(10000);

	// The game usually opens in a NEW proxied tab; fall back to same-tab frame.
	let target = page;
	if (tabs.length) {
		target = tabs[tabs.length - 1];
		await target.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
	}
	let gameFrame = await proxyFrame(target);
	if (!gameFrame) {
		log('[no new frame] checking same tab');
		gameFrame = (await proxyFrame()) || frame;
	}
	log('[game frame url]', (gameFrame?.url() || '').slice(0, 160));

	const t0 = Date.now();
	for (let i = 1; i <= 8; i++) {
		await target.waitForTimeout(15000);
		gameFrame = (await proxyFrame(target)) || gameFrame;
		const data = await gameFrame
			.evaluate(() => {
				const res = performance.getEntriesByType('resource');
				const big = res
					.filter((r) => (r.transferSize || r.encodedBodySize || 0) > 300000)
					.map((r) => `${((r.transferSize || 0) / 1048576).toFixed(1)}MB ${r.name.slice(-70)}`);
				return {
					url: location.href.slice(0, 150),
					title: document.title.slice(0, 50),
					textPreview: (document.body?.innerText || '').slice(0, 180),
					canvases: document.querySelectorAll('canvas').length,
					iframes: document.querySelectorAll('iframe').length,
					workers: [...document.querySelectorAll('script')].length,
					sharedArrayBuffer: typeof SharedArrayBuffer,
					crossOriginIsolated: window.crossOriginIsolated,
					secureContext: window.isSecureContext,
					resources: res.length,
					pending: res.filter((r) => r.responseEnd === 0).length,
					bigAssets: big.slice(0, 6),
				};
			})
			.catch((e) => ({ error: String(e).slice(0, 150) }));
		log(`[game t+${((Date.now() - t0) / 1000).toFixed(0)}s]`, JSON.stringify(data));
		if (i === 4 || i === 8) await target.screenshot({ path: `game-${i}.png` }).catch(() => {});
	}
} catch (e) {
	log('[fatal]', String(e).slice(0, 300));
} finally {
	await browser.close();
}
log('[done]');
