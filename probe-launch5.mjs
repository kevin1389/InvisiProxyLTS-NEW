// v5: click "Grand Theft Auto: Vice City" in the proxied playobsidian sidebar
// (the user's real click path), catch the popup tab, and watch the launch
// page: canvases, crossOriginIsolated/SharedArrayBuffer (emulator needs),
// big asset download progress (huge game files trickling), failures.
import { chromium } from 'playwright';

const base = process.argv[2];
if (!base) {
	console.error('usage: node probe-launch5.mjs <base-url>');
	process.exit(1);
}
const url = base.endsWith('/') ? base : base + '/';
const log = (...a) => console.log(...a);

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const context = await browser.newContext();
const page = await context.newPage();

const popups = [];
context.on('popup', (p) => {
	popups.push(p);
	log('[popup]', p.url().slice(0, 130));
	p.on('console', (m) => {
		if (m.type() === 'error') log('[popup console]', m.text().slice(0, 160));
	});
	p.on('pageerror', (e) => log('[popup pageerror]', String(e).slice(0, 160)));
	p.on('requestfailed', (r) =>
		log('[popup failed]', r.failure()?.errorText, r.url().slice(0, 110))
	);
	p.on('response', (r) => {
		if (r.status() >= 400) log(`[popup ${r.status()}]`, r.url().slice(0, 120));
	});
});

const proxyFrame = async (p) => {
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

	await page.locator('#search-input').fill('https://playobsidian.com/store');
	await page.locator('#search-input').press('Enter');
	await page.waitForURL(/\/s($|\?)/, { timeout: 30000 }).catch(() => {});
	let frame = await proxyFrame(page);
	await frame
		.waitForFunction(() => document.body && document.body.innerText.length > 100, null, { timeout: 60000 })
		.catch(() => {});
	log('[store] loaded');

	// The user's actual click: the sidebar "Currently Playing" game entry.
	const candidates = await frame
		.evaluate(() =>
			[...document.querySelectorAll('*')]
				.filter(
					(el) =>
						/Grand Theft Auto|Vice City/i.test(el.textContent || '') &&
						el.children.length <= 2 &&
						el.textContent.trim().length < 60
				)
				.map((el) => ({
					tag: el.tagName,
					text: el.textContent.trim().slice(0, 50),
					cls: (el.className || '').toString().slice(0, 60),
				}))
				.slice(0, 8)
		)
		.catch(() => []);
	log('[sidebar candidates]', JSON.stringify(candidates));

	let clicked = false;
	for (const text of ['Grand Theft Auto: Vice City', 'Vice City', 'Grand Theft Auto']) {
		if (clicked) break;
		const loc = frame.getByText(text, { exact: false }).last();
		if (await loc.count()) {
			await loc.click({ timeout: 8000 }).then(() => (clicked = true)).catch((e) => log('[click err]', String(e).slice(0, 120)));
		}
	}
	log('[clicked]', clicked);
	await page.waitForTimeout(12000);

	// The game opens in a new proxied tab; fall back to same-tab navigation.
	let target = popups.length ? popups[popups.length - 1] : page;
	if (target !== page) await target.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
	let gameFrame = await proxyFrame(target);
	if (!gameFrame) {
		log('[no popup frame] checking same tab');
		target = page;
		gameFrame = await proxyFrame(page);
	}
	log('[game frame]', (gameFrame?.url() || 'none').slice(0, 160));

	if (!gameFrame) throw new Error('no game frame appeared');

	const t0 = Date.now();
	for (let i = 1; i <= 10; i++) {
		await target.waitForTimeout(15000);
		gameFrame = (await proxyFrame(target)) || gameFrame;
		const data = await gameFrame
			.evaluate(() => {
				const res = performance.getEntriesByType('resource');
				const total = res.reduce((s, r) => s + (r.transferSize || r.encodedBodySize || 0), 0);
				const pending = res.filter((r) => r.responseEnd === 0);
				const big = res
					.filter((r) => (r.transferSize || 0) > 200000)
					.map((r) => `${(r.transferSize / 1048576).toFixed(1)}MB`);
				return {
					url: location.href.slice(0, 150),
					title: document.title.slice(0, 50),
					text: (document.body?.innerText || '').slice(0, 150),
					canvases: document.querySelectorAll('canvas').length,
					iframes: document.querySelectorAll('iframe').length,
					sab: typeof SharedArrayBuffer,
					coi: window.crossOriginIsolated,
					resources: res.length,
					pending: pending.length,
					totalMB: (total / 1048576).toFixed(1),
					bigCount: big.length,
				};
			})
			.catch((e) => ({ error: String(e).slice(0, 140) }));
		log(`[t+${((Date.now() - t0) / 1000).toFixed(0)}s]`, JSON.stringify(data));
		if (i === 4 || i === 10) await target.screenshot({ path: `g5-${i}.png` }).catch(() => {});
	}
} catch (e) {
	log('[fatal]', String(e).slice(0, 300));
} finally {
	await browser.close();
}
log('[done]');
