// v7: full-fidelity console/network capture through the LIVE proxy.
// Reproduces: store page -> click GTA VC -> launch page (black for user).
// Dumps EVERY console message (untruncated), every >=400 response with its
// content-type, every failed request, and the frame tree. Diagnosis tool for:
//   - 404 on `https%3A%2F%2Fplayobsidian.com%2Fjsd%2Fmain.js` (encoded URL as path)
//   - "Refused to execute script ... MIME type ('text/plain')"
import { chromium } from 'playwright';

const base = process.argv[2];
if (!base) {
	console.error('usage: node probe-launch7.mjs <base-url>');
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
			text: m.text(),
			src: (loc.url || '').slice(0, 160),
			line: loc.lineNumber,
		})
	);
});
page.on('pageerror', (e) =>
	consoleRows.push(JSON.stringify({ type: 'pageerror', text: String(e).slice(0, 400) }))
);
page.on('response', (r) => {
	if (r.status() >= 400)
		badResponses.push(
			`${r.status()} ct=${r.headers()['content-type'] || '-'} ${r.url().slice(0, 200)}`
		);
});
page.on('requestfailed', (r) =>
	failed.push(`${r.failure()?.errorText} ${r.url().slice(0, 200)}`)
);
page.on('websocket', (ws) => {
	const short = ws.url().replace(/^https?:\/\//, '').slice(0, 100);
	wsEvents.push(`open ${short}`);
	ws.on('close', () => wsEvents.push(`close ${short}`));
	ws.on('socketerror', (e) => wsEvents.push(`error ${short} ${String(e).slice(0, 90)}`));
});

const proxyFrame = async () => {
	for (let i = 0; i < 40; i++) {
		const f = page.frame
			? page.frames().find((x) => x !== page.mainFrame() && x.url().includes('/scram/'))
			: null;
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

	await page.locator('#search-input').fill('https://playobsidian.com/store');
	await page.locator('#search-input').press('Enter');
	await page.waitForURL(/\/s($|\?)/, { timeout: 30000 }).catch(() => {});
	let frame = await proxyFrame();
	if (!frame) throw new Error('proxy frame never appeared');
	await frame
		.waitForFunction(() => document.body && document.body.innerText.length > 100, null, {
			timeout: 60000,
		})
		.catch(() => {});
	log('[store] loaded');

	const launchLinks = await frame
		.evaluate(() =>
			[...document.querySelectorAll('a')]
				.map((a) => ({ href: a.href, text: (a.innerText || '').slice(0, 60) }))
				.filter((a) => a.href.includes('/launch/'))
		)
		.catch(() => []);
	const pick = launchLinks.find((l) => /gta|vice/i.test(l.text)) || launchLinks[0];
	log('[click]', JSON.stringify(pick));

	const link = frame.locator(`a[href="${pick.href}"]`).first();
	if (await link.count()) await link.click({ timeout: 15000 });

	// Watch the launch page for 75s, sampling frame state.
	for (let i = 1; i <= 5; i++) {
		await page.waitForTimeout(15000);
		frame = (await proxyFrame()) || frame;
		const state = await frame
			.evaluate(() => ({
				url: location.href.slice(0, 170),
				text: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 120),
				canvases: document.querySelectorAll('canvas').length,
				iframes: document.querySelectorAll('iframe').length,
				resources: performance.getEntriesByType('resource').length,
				pending: performance.getEntriesByType('resource').filter((r) => !r.responseEnd).length,
			}))
			.catch((e) => ({ error: String(e).slice(0, 120) }));
		log(`[t+${i * 15}s]`, JSON.stringify(state));
	}
	await page.screenshot({ path: 'l7-final.png' }).catch(() => {});
} catch (e) {
	log('[fatal]', String(e).slice(0, 300));
} finally {
	log('=== CONSOLE (' + consoleRows.length + ') ===');
	for (const row of consoleRows.slice(-90)) log(row);
	log('=== BAD RESPONSES (' + badResponses.length + ') ===');
	for (const row of badResponses.slice(-40)) log(row);
	log('=== FAILED (' + failed.length + ') ===');
	for (const row of failed.slice(-20)) log(row);
	log('=== WS ===');
	for (const row of wsEvents.slice(-20)) log(row);
	await browser.close();
}
log('[done]');
