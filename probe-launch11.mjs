// v11: the REAL user flow through the LIVE proxy: open the game's store page,
// click its Play button (client-side router push -> /launch/<id> stays), then
// watch whether the game container iframe boots (canvas, wasm, ROM streaming).
import { chromium } from 'playwright';

const base = process.argv[2];
const gameUrl = process.argv[3] || 'https://playobsidian.com/store/0eb9ae41-8ccd-4eea-b7b6-0e47e791a0e3';
if (!base) {
	console.error('usage: node probe-launch11.mjs <base-url> [game-store-url]');
	process.exit(1);
}
const url = base.endsWith('/') ? base : base + '/';
const log = (...a) => console.log(...a);
const t0 = Date.now();
const stamp = () => `[+${((Date.now() - t0) / 1000).toFixed(1)}s]`;

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const page = await (await browser.newContext()).newPage();

page.on('framenavigated', (f) => {
	const u = f.url() || '';
	if (u.includes('/scram/') || f === page.mainFrame())
		log(stamp(), '[nav]', f === page.mainFrame() ? '(main)' : 'frame', u.slice(-110));
});
page.on('requestfailed', (r) =>
	log(stamp(), '[reqfailed]', r.failure()?.errorText, r.url().slice(-120))
);
page.on('response', (r) => {
	if (r.url().includes('/cdn/assets/html/'))
		log(stamp(), '[container resp]', r.status(), r.headers()['content-type'] || '-');
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

	await page.locator('#search-input').fill(gameUrl);
	await page.locator('#search-input').press('Enter');
	await page.waitForURL(/\/s($|\?)/, { timeout: 30000 }).catch(() => {});
	let frame = await proxyFrame();
	if (!frame) throw new Error('proxy frame never appeared');
	await frame
		.waitForFunction(() => document.body && document.body.innerText.length > 150, null, {
			timeout: 60000,
		})
		.catch(() => {});
	log(stamp(), '[game store page]', (frame.url() || '').slice(-90));

	// What can we click? List buttons + anchors with play-ish text.
	const controls = await frame
		.evaluate(() => ({
			buttons: [...document.querySelectorAll('button')]
				.map((b) => b.innerText.trim().slice(0, 30))
				.filter(Boolean)
				.slice(0, 25),
			launchAnchors: [...document.querySelectorAll('a')]
				.filter((a) => a.href.includes('/launch/'))
				.map((a) => a.href.slice(-46)),
		}))
		.catch(() => ({}));
	log('[controls]', JSON.stringify(controls));

	const play = frame
		.locator('button')
		.filter({ hasText: /play|start|launch/i })
		.first();
	if (await play.count()) {
		log(stamp(), '[clicking Play]', JSON.stringify(await play.innerText().catch(() => '')));
		await play.click({ timeout: 10000 }).catch((e) => log('[click err]', String(e).slice(0, 120)));
	} else {
		log('[no Play button found]');
	}

	for (let i = 1; i <= 7; i++) {
		await page.waitForTimeout(12000);
		frame = (await proxyFrame()) || frame;
		const state = await frame
			.evaluate(() => {
				const res = performance.getEntriesByType('resource');
				return {
					url: location.href.slice(-90),
					canvases: document.querySelectorAll('canvas').length,
					iframes: [...document.querySelectorAll('iframe')].map((x) =>
						(x.src || '(no-src)').slice(-70)
					),
					text: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 70),
					resources: res.length,
					pending: res.filter((r) => !r.responseEnd).length,
					biggest: res
						.map((r) => ({ n: r.name.slice(-55), got: r.transferSize || r.encodedBodySize || 0 }))
						.sort((a, b) => b.got - a.got)
						.slice(0, 3),
				};
			})
			.catch((e) => ({ error: String(e).slice(0, 120) }));
		log(stamp(), `[poll ${i}]`, JSON.stringify(state));
		if (i === 4 || i === 7) await page.screenshot({ path: `v11-${i}.png` }).catch(() => {});
	}
} catch (e) {
	log('[fatal]', String(e).slice(0, 300));
} finally {
	await browser.close();
}
log('[done]');
