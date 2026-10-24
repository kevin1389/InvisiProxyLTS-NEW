// v9: watch the frame/iframe LIFECYCLE with timestamps. The game container
// (playobsidian.com/cdn/assets/html/<id>/1/index.html) died with ERR_ABORTED
// in v8. Did the iframe appear and get torn down, or never load? Also dump
// the frame's iframe srcs + full launch URL (with query) as it settles.
import { chromium } from 'playwright';

const base = process.argv[2];
const launchUrl =
	process.argv[3] || 'https://playobsidian.com/launch/0eb9ae41-8ccd-4eea-b7b6-0e47e791a0e3';
if (!base) {
	console.error('usage: node probe-launch9.mjs <base-url> [launchUrl]');
	process.exit(1);
}
const url = base.endsWith('/') ? base : base + '/';
const log = (...a) => console.log(...a);
const t0 = Date.now();
const stamp = () => `[+${((Date.now() - t0) / 1000).toFixed(1)}s]`;

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const page = await (await browser.newContext()).newPage();

page.on('frameattached', (f) => log(stamp(), '[frame attached]', (f.url() || 'about:blank').slice(0, 120)));
page.on('framedetached', (f) => log(stamp(), '[frame detached]', (f.url() || 'about:blank').slice(0, 120)));
page.on('framenavigated', (f) =>
	log(stamp(), '[frame navigated]', f === page.mainFrame() ? '(main)' : '', (f.url() || '').slice(0, 150))
);
page.on('request', (r) => {
	if (r.url().includes('/cdn/assets/') || r.url().includes('/launch/'))
		log(stamp(), '[req]', r.resourceType(), r.url().slice(0, 150));
});
page.on('requestfailed', (r) =>
	log(stamp(), '[reqfailed]', r.failure()?.errorText, r.url().slice(0, 150))
);
page.on('response', (r) => {
	if (r.url().includes('/cdn/assets/'))
		log(stamp(), '[resp]', r.status(), r.headers()['content-type'] || '-', r.url().slice(0, 130));
});
page.on('websocket', (ws) => {
	const short = ws.url().replace(/^https?:\/\//, '').slice(0, 80);
	ws.on('close', () => log(stamp(), '[ws close]', short));
	ws.on('socketerror', (e) => log(stamp(), '[ws error]', short, String(e).slice(0, 80)));
});

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
	log(stamp(), '[ready]');

	await page.locator('#search-input').fill(launchUrl);
	await page.locator('#search-input').press('Enter');
	await page.waitForURL(/\/s($|\?)/, { timeout: 30000 }).catch(() => {});

	for (let i = 1; i <= 8; i++) {
		await page.waitForTimeout(12000);
		const frame = (await proxyFrame()) || null;
		const state = frame
			? await frame
					.evaluate(() => ({
						url: location.href.slice(0, 230),
						iframes: [...document.querySelectorAll('iframe')].map(
							(x) => (x.src || x.getAttribute('src') || '(no-src)').slice(0, 160)
						),
						canvases: document.querySelectorAll('canvas').length,
						text: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 90),
					}))
					.catch((e) => ({ error: String(e).slice(0, 120) }))
			: { note: 'no proxy frame' };
		log(stamp(), `[poll ${i}]`, JSON.stringify(state));
	}
	await page.screenshot({ path: 'l9-final.png' }).catch(() => {});
} catch (e) {
	log('[fatal]', String(e).slice(0, 300));
} finally {
	await browser.close();
}
log('[done]');
