// v8: drive the frame omnibox straight to a real /launch/<id> page through the
// LIVE proxy (store anchors don't render in headless), then watch the launch
// page for 90s: full console, every >=400 with content-type, every failed
// request, frame resource timing (what's loading / stuck), screenshot.
import { chromium } from 'playwright';

const base = process.argv[2];
const launchUrl = process.argv[3] || 'https://playobsidian.com/launch/0eb9ae41-8ccd-4eea-b7b6-0e47e791a0e3';
if (!base) {
	console.error('usage: node probe-launch8.mjs <base-url> [launchUrl]');
	process.exit(1);
}
const url = base.endsWith('/') ? base : base + '/';
const log = (...a) => console.log(...a);

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const page = await (await browser.newContext()).newPage();

const consoleRows = [];
const badResponses = [];
const failed = [];
const wsEvents = [];

page.on('console', (m) => {
	const loc = m.location();
	consoleRows.push(
		JSON.stringify({
			type: m.type(),
			text: m.text().slice(0, 300),
			src: (loc.url || '').slice(0, 140),
		})
	);
});
page.on('pageerror', (e) =>
	consoleRows.push(JSON.stringify({ type: 'pageerror', text: String(e).slice(0, 300) }))
);
page.on('response', (r) => {
	if (r.status() >= 400)
		badResponses.push(
			`${r.status()} ct=${r.headers()['content-type'] || '-'} ${r.url().slice(0, 180)}`
		);
});
page.on('requestfailed', (r) =>
	failed.push(`${r.failure()?.errorText} ${r.url().slice(0, 180)}`)
);
page.on('websocket', (ws) => {
	const short = ws.url().replace(/^https?:\/\//, '').slice(0, 90);
	let frames = 0;
	ws.on('framereceived', () => frames++);
	ws.on('framesent', () => frames++);
	wsEvents.push(`open ${short}`);
	ws.on('close', () => wsEvents.push(`close ${short} frames=${frames}`));
	ws.on('socketerror', (e) => wsEvents.push(`error ${short} ${String(e).slice(0, 80)}`));
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
	log('[ready]');

	// Drive the frame omnibox straight to the game launch page.
	await page.locator('#search-input').fill(launchUrl);
	await page.locator('#search-input').press('Enter');
	await page.waitForURL(/\/s($|\?)/, { timeout: 30000 }).catch(() => {});
	let frame = await proxyFrame();
	if (!frame) throw new Error('proxy frame never appeared');
	log('[frame]', (frame.url() || '').slice(0, 160));

	const t0 = Date.now();
	for (let i = 1; i <= 6; i++) {
		await page.waitForTimeout(15000);
		frame = (await proxyFrame()) || frame;
		const state = await frame
			.evaluate(() => {
				const res = performance.getEntriesByType('resource');
				return {
					url: location.href.slice(0, 160),
					text: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 110),
					canvases: document.querySelectorAll('canvas').length,
					iframes: document.querySelectorAll('iframe').length,
					resources: res.length,
					pending: res.filter((r) => !r.responseEnd).length,
					biggest: res
						.map((r) => ({
							n: r.name.replace(/^https?:\/\/[^/]+/, '').slice(-70),
							got: r.transferSize || r.encodedBodySize || 0,
						}))
						.sort((a, b) => b.got - a.got)
						.slice(0, 4),
					sab: typeof SharedArrayBuffer,
					coi: window.crossOriginIsolated,
				};
			})
			.catch((e) => ({ error: String(e).slice(0, 140) }));
		log(`[t+${((Date.now() - t0) / 1000).toFixed(0)}s]`, JSON.stringify(state));
		if (i === 3 || i === 6) await page.screenshot({ path: `l8-${i}.png` }).catch(() => {});
	}
} catch (e) {
	log('[fatal]', String(e).slice(0, 300));
} finally {
	log('=== CONSOLE (' + consoleRows.length + ') ===');
	for (const row of consoleRows.slice(-80)) log(row);
	log('=== BAD RESPONSES (' + badResponses.length + ') ===');
	for (const row of badResponses.slice(-30)) log(row);
	log('=== FAILED (' + failed.length + ') ===');
	for (const row of failed.slice(-15)) log(row);
	log('=== WS ===');
	for (const row of wsEvents.slice(-16)) log(row);
	await browser.close();
}
log('[done]');
