// v10: GROUND TRUTH — the real playobsidian.com in a clean headless browser,
// no proxy. Store page -> click Play on GTA VC -> watch the launch page.
// If the real site ALSO redirects to /store and drops the game iframe, the
// behavior is the site's own (not caused by the proxy). If it boots the game
// (canvas appears, container stays attached), the proxy breaks something.
import { chromium } from 'playwright';

const log = (...a) => console.log(...a);
const t0 = Date.now();
const stamp = () => `[+${((Date.now() - t0) / 1000).toFixed(1)}s]`;

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const page = await (await browser.newContext()).newPage();

page.on('framenavigated', (f) =>
	log(stamp(), '[nav]', f === page.mainFrame() ? '(main)' : 'frame', (f.url() || '').slice(0, 130))
);
page.on('requestfailed', (r) =>
	log(stamp(), '[reqfailed]', r.failure()?.errorText, r.url().slice(0, 130))
);
page.on('response', (r) => {
	if (r.url().includes('/cdn/assets/'))
		log(stamp(), '[resp]', r.status(), r.headers()['content-type'] || '-', r.url().slice(0, 120));
});

try {
	await page.goto('https://playobsidian.com/store', { waitUntil: 'domcontentloaded', timeout: 60000 });
	await page.waitForTimeout(6000);

	// What interactive elements does the store page offer?
	const elems = await page.evaluate(() => ({
		launchAnchors: [...document.querySelectorAll('a')]
			.filter((a) => a.href.includes('/launch/'))
			.map((a) => ({ href: a.href.slice(-50), text: a.innerText.trim().slice(0, 40) })),
		links: [...document.querySelectorAll('a')].slice(0, 25).map((a) => a.getAttribute('href')),
		buttons: [...document.querySelectorAll('button')].slice(0, 20).map((b) => b.innerText.trim().slice(0, 30)),
	}));
	log('[store elements]', JSON.stringify(elems, null, 1));

	// Click into GTA VC the way a user would.
	const pick = page.locator('a[href*="/launch/"]').first();
	if (await pick.count()) {
		log('[clicking]', await pick.getAttribute('href'));
		await pick.click({ timeout: 10000 }).catch((e) => log('[click err]', String(e).slice(0, 100)));
	} else {
		log('[no launch anchor] — deep-linking instead');
		await page
			.goto('https://playobsidian.com/launch/0eb9ae41-8ccd-4eea-b7b6-0e47e791a0e3', {
				waitUntil: 'domcontentloaded',
				timeout: 60000,
			})
			.catch(() => {});
	}

	for (let i = 1; i <= 5; i++) {
		await page.waitForTimeout(9000);
		const state = await page
			.evaluate(() => ({
				url: location.href.slice(0, 120),
				canvases: document.querySelectorAll('canvas').length,
				iframes: [...document.querySelectorAll('iframe')].map((x) =>
					(x.src || '(no-src)').slice(0, 110)
				),
				text: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 80),
			}))
			.catch((e) => ({ error: String(e).slice(0, 100) }));
		log(stamp(), `[poll ${i}]`, JSON.stringify(state));
	}
	await page.screenshot({ path: 'v10-real.png' }).catch(() => {});
} catch (e) {
	log('[fatal]', String(e).slice(0, 300));
} finally {
	await browser.close();
}
log('[done]');
