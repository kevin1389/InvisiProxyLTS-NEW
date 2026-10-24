// v6: load the actual /launch/<slug> page through the live proxy via the
// frame omnibox, then sample resource timing: how big are the game assets,
// how much has downloaded, is anything pending. If a giant game image is
// trickling through the Funnel, that's the black screen.
import { chromium } from 'playwright';

const base = process.argv[2];
const launchUrl = process.argv[3] || 'https://playobsidian.com/launch/0eb9ae41-8ccd-4eea-b7b6-0e47e791a0e3';
if (!base) {
	console.error('usage: node probe-launch6.mjs <base-url> [launchUrl]');
	process.exit(1);
}
const url = base.endsWith('/') ? base : base + '/';
const log = (...a) => console.log(...a);

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const page = await (await browser.newContext()).newPage();

const bad = [];
const failed = [];
page.on('response', (r) => {
	if (r.status() >= 400) bad.push(`${r.status()} ${r.url().slice(0, 120)}`);
});
page.on('requestfailed', (r) =>
	failed.push(`${r.failure()?.errorText} ${r.url().slice(0, 120)}`)
);

const proxyFrame = async () => {
	for (let i = 0; i < 40; i++) {
		const f = page.frames().find((x) => x !== page.mainFrame() && x.url().includes('/scram/'));
		if (f) return f;
		await page.waitForTimeout(500);
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

	// Drive the frame omnibox (same input the user types into) to the launch page.
	await page.locator('#search-input').fill(launchUrl);
	await page.locator('#search-input').press('Enter');
	await page.waitForURL(/\/s($|\?)/, { timeout: 30000 }).catch(() => {});
	let frame = await proxyFrame();
	if (!frame) throw new Error('proxy frame never appeared');
	log('[frame]', (frame.url() || '').slice(0, 150));

	const t0 = Date.now();
	let firstData = null;
	for (let i = 1; i <= 10; i++) {
		await page.waitForTimeout(15000);
		frame = (await proxyFrame()) || frame;
		const data = await frame
			.evaluate(() => {
				const res = performance.getEntriesByType('resource');
				const rows = res.map((r) => ({
					name: r.name.replace(/^https?:\/\/[^/]+/, '').slice(-90),
					// Bytes received so far (decodedBodySize is what arrived).
					got: r.transferSize || r.encodedBodySize || 0,
					done: r.responseEnd > 0,
				}));
				const pending = rows.filter((r) => !r.done);
				const biggest = rows.sort((a, b) => b.got - a.got).slice(0, 5);
				return {
					url: location.href.slice(0, 140),
					title: document.title.slice(0, 50),
					text: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 200),
					canvases: document.querySelectorAll('canvas').length,
					iframes: document.querySelectorAll('iframe').length,
					coi: window.crossOriginIsolated,
					sab: typeof SharedArrayBuffer,
					resources: res.length,
					pendingCount: pending.length,
					pendingTop: pending.slice(0, 5),
					biggest,
				};
			})
			.catch((e) => ({ error: String(e).slice(0, 150) }));
		const secs = ((Date.now() - t0) / 1000).toFixed(0);
		log(`[t+${secs}s]`, JSON.stringify(data));
		if (!firstData && data && data.resources > 2) firstData = data;
		if (i === 3 || i === 10) await page.screenshot({ path: `l6-${i}.png` }).catch(() => {});
	}
} catch (e) {
	log('[fatal]', String(e).slice(0, 300));
} finally {
	log('[bad]', JSON.stringify(bad.slice(-12), null, 1));
	log('[failed]', JSON.stringify(failed.slice(-8), null, 1));
	await browser.close();
}
log('[done]');
