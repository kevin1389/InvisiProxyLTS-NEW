// Reproduce the user's exact path through their LIVE proxy:
// store page renders (works for them in Incognito) -> click into the game
// launch page (black for them) -> watch what the launch page actually does.
// v2: polls for the frame instead of assuming it exists.
import { chromium } from 'playwright';

const base = process.argv[2];
if (!base) {
	console.error('usage: node probe-launch.mjs <url>');
	process.exit(1);
}
const url = base.endsWith('/') ? base : base + '/';
const log = (...a) => console.log(...a);

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const context = await browser.newContext();
const page = await context.newPage();

const consoleErrors = [];
const pageErrors = [];
const failed = [];
const badResponses = [];
const sockets = [];
const popups = [];

page.on('console', (m) => {
	if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 180));
});
page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 200)));
page.on('requestfailed', (r) =>
	failed.push(`${r.failure()?.errorText} ${r.url().slice(0, 130)}`)
);
page.on('response', (r) => {
	if (r.status() >= 400) badResponses.push(`${r.status()} ${r.url().slice(0, 130)}`);
});
page.on('websocket', (ws) => {
	const entry = { url: ws.url().replace(/^https?:\/\//, '').slice(0, 90), frames: 0 };
	sockets.push(entry);
	ws.on('framereceived', () => entry.frames++);
	ws.on('framesent', () => entry.frames++);
	ws.on('socketerror', (e) => log('[ws error]', String(e).slice(0, 110)));
	ws.on('close', () => log('[ws closed]', entry.url, 'frames=', entry.frames));
});
context.on('popup', (p) => {
	popups.push(p);
	log('[popup opened]', p.url().slice(0, 120));
});

const proxyFrame = async () => {
	for (let i = 0; i < 40; i++) {
		const f = page
			.frames()
			.find((x) => x !== page.mainFrame() && x.url().includes('/scram/'));
		if (f) return f;
		await page.waitForTimeout(500);
	}
	return null;
};

const sampleFrame = async (label, frame) => {
	try {
		const data = await frame
			.evaluate(() => {
				const res = performance.getEntriesByType('resource');
				const bytes = res.reduce(
					(sum, r) => sum + (r.transferSize || r.encodedBodySize || 0),
					0
				);
				return {
					url: location.href.slice(0, 150),
					readyState: document.readyState,
					textLen: (document.body?.innerText || '').length,
					textPreview: (document.body?.innerText || '').slice(0, 160),
					canvases: document.querySelectorAll('canvas').length,
					iframes: document.querySelectorAll('iframe').length,
					scripts: document.scripts.length,
					resources: res.length,
					resourceBytes: bytes,
					pending: performance
						.getEntriesByType('resource')
						.filter((r) => r.responseEnd === 0).length,
				};
			})
			.catch((e) => ({ error: String(e).slice(0, 140) }));
		log(`[sample ${label}]`, JSON.stringify(data));
		return data;
	} catch (e) {
		log(`[sample ${label}] error`, String(e).slice(0, 140));
		return null;
	}
};

try {
	await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
	await page.waitForTimeout(4000);
	await page.goto(url + 'scramjet', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
	await page.locator('#search-input').waitFor({ timeout: 25000 });
	await page.waitForFunction(() => window.$invisiScramjet?.ready === true, null, { timeout: 30000 });
	log('[ready]');

	// 1. Store page (the part that works for them).
	await page.locator('#search-input').fill('https://playobsidian.com/store');
	await page.locator('#search-input').press('Enter');
	await page.waitForURL(/\/s($|\?)/, { timeout: 30000 }).catch(() => {});
	const storeFrame = await proxyFrame();
	if (!storeFrame) {
		log('[abort] proxy frame never appeared');
		throw new Error('no proxy frame');
	}
	await storeFrame
		.waitForFunction(() => document.body && document.body.innerText.length > 100, null, {
			timeout: 60000,
		})
		.catch(() => {});
	log('[store] loaded');
	await sampleFrame('store', storeFrame);
	await page.screenshot({ path: 'launch-1-store.png' }).catch(() => {});

	// 2. Find every launch link inside the frame.
	const launchLinks = await storeFrame
		.evaluate(() =>
			[...document.querySelectorAll('a')]
				.map((a) => ({ href: a.href, text: (a.innerText || '').slice(0, 60), target: a.target }))
				.filter((a) => a.href.includes('/launch/'))
		)
		.catch(() => []);
	log('[launch links]', JSON.stringify(launchLinks.slice(0, 8), null, 1));
	if (!launchLinks.length) {
		log('[abort] no launch links found — store structure differs');
	} else {
		const pick =
			launchLinks.find((l) => /gta|vice/i.test(l.text)) || launchLinks[0];
		log('[clicking]', JSON.stringify(pick));

		// 3. Click and watch the launch page for ~105s, sampling every 15s.
		const t0 = Date.now();
		let frame = storeFrame;
		try {
			const link = storeFrame.locator(`a[href="${pick.href}"]`).first();
			if (await link.count()) await link.click({ timeout: 15000 });
			else
				await storeFrame.evaluate((h) => {
					const a = [...document.querySelectorAll('a')].find((x) => x.href === h);
					if (a) a.click();
				}, pick.href);
			log('[clicked]');
		} catch (e) {
			log('[click failed]', String(e).slice(0, 160));
		}

		for (let i = 1; i <= 7; i++) {
			await page.waitForTimeout(15000);
			frame = (await proxyFrame()) || frame;
			const seconds = ((Date.now() - t0) / 1000).toFixed(0);
			await sampleFrame(`t+${seconds}s`, frame);
			if (i === 2 || i === 6)
				await page
					.screenshot({ path: `launch-${i === 2 ? 2 : 3}-launch.png` })
					.catch(() => {});
		}
		// Sample any popups (target=_blank game windows) too.
		for (const popup of popups) {
			const f = popup.frames().find((x) => x !== popup.mainFrame()) || popup.mainFrame();
			const data = await f
				.evaluate(() => ({
					url: location.href.slice(0, 150),
					text: (document.body?.innerText || '').slice(0, 200),
					canvases: document.querySelectorAll('canvas').length,
				}))
				.catch((e) => ({ error: String(e).slice(0, 120) }));
			log('[popup frame]', JSON.stringify(data));
		}
	}
} catch (e) {
	log('[fatal]', String(e).slice(0, 300));
} finally {
	log(
		'[summary]',
		JSON.stringify(
			{
				consoleErrors: consoleErrors.slice(0, 15),
				pageErrors: pageErrors.slice(0, 10),
				failedRequests: failed.slice(0, 15),
				badResponses: badResponses.slice(0, 15),
				webSockets: sockets,
			},
			null,
			1
		)
	);
	await browser.close();
}
log('[done]');
