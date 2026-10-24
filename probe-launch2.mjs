// v3: the store is a React SPA (links navigate via JS), so pull real launch
// URLs out of the page's data/scripts, then load a launch URL directly
// inside the proxied frame and watch what it renders.
import { chromium } from 'playwright';

const base = process.argv[2];
if (!base) {
	console.error('usage: node probe-launch2.mjs <url> [launchUrlOverride]');
	process.exit(1);
}
const url = base.endsWith('/') ? base : base + '/';
const launchOverride = process.argv[3];
const log = (...a) => console.log(...a);

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const page = await (await browser.newContext()).newPage();

const bad = [];
const failed = [];
page.on('response', (r) => {
	if (r.status() >= 400) bad.push(`${r.status()} ${r.url().slice(0, 130)}`);
});
page.on('requestfailed', (r) =>
	failed.push(`${r.failure()?.errorText} ${r.url().slice(0, 130)}`)
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

	await page.locator('#search-input').fill('https://playobsidian.com/store');
	await page.locator('#search-input').press('Enter');
	await page.waitForURL(/\/s($|\?)/, { timeout: 30000 }).catch(() => {});
	let frame = await proxyFrame();
	await frame
		.waitForFunction(() => document.body && document.body.innerText.length > 100, null, { timeout: 60000 })
		.catch(() => {});
	log('[store] loaded');

	// Harvest launch URLs from DOM anchors, data attributes, inline scripts,
	// and the Next.js payload if present.
	const harvested = await frame.evaluate(() => {
		const out = new Set();
		const scan = (text) => {
			for (const m of String(text).matchAll(/\/launch\/[A-Za-z0-9_-]+/g)) out.add(m[0]);
		};
		for (const a of document.querySelectorAll('a[href]')) scan(a.getAttribute('href'));
		for (const el of document.querySelectorAll('[data-href],[data-url]'))
			scan(el.getAttribute('data-href') || el.getAttribute('data-url'));
		for (const s of document.scripts) if (s.textContent) scan(s.textContent);
		const nd = document.getElementById('__NEXT_DATA__');
		if (nd?.textContent) scan(nd.textContent);
		return [...out];
	}).catch(() => []);
	log('[harvested launch paths]', JSON.stringify(harvested.slice(0, 12), null, 1));

	let launchPath = launchOverride || harvested[0];
	if (!launchPath) {
		// Fall back: click the first game card to trigger SPA navigation and
		// watch where the frame URL goes.
		log('[no launch paths in store data] clicking a game card instead');
		const card = frame.locator('a').filter({ hasText: /play|view|launch/i }).first();
		if (await card.count()) await card.click({ timeout: 10000 }).catch(() => {});
		await page.waitForTimeout(15000);
		frame = (await proxyFrame()) || frame;
		log('[after card click] frame url:', (frame?.url() || '').slice(0, 160));
		launchPath = new URL(frame?.url() || '').pathname.replace(/^\/scram\/network\/[^/]+\/[^/]+\//, '');
		try {
			launchPath = decodeURIComponent(launchPath);
		} catch {}
	}
	if (!launchPath) {
		log('[abort] still nothing to load');
		throw new Error('no launch target');
	}
	const target = launchPath.startsWith('http') ? launchPath : `https://playobsidian.com${launchPath}`;
	log('[loading launch target]', target);

	// Drive the frame to the launch URL via the omnibox (same as the user's UI).
	await page.locator('#omnibox-url, #url-input, input[type="url"]').first().waitFor({ timeout: 10000 }).catch(() => {});
	const box = page.locator('#omnibox-url, #url-input, input[type="url"]').first();
	if (await box.count()) {
		await box.fill(target);
		await box.press('Enter');
	} else {
		await page.evaluate((t) => {
			const key = Object.keys(localStorage).find((k) => k.endsWith('-frame-url'));
			if (key) localStorage.setItem(key, 'sj:' + t);
		}, target);
		await page.reload({ waitUntil: 'domcontentloaded' });
		await page.waitForTimeout(5000);
	}
	const t0 = Date.now();
	for (let i = 1; i <= 8; i++) {
		await page.waitForTimeout(15000);
		frame = (await proxyFrame()) || frame;
		const data = await frame
			.evaluate(() => {
				const res = performance.getEntriesByType('resource');
				return {
					url: location.href.slice(0, 160),
					readyState: document.readyState,
					title: document.title.slice(0, 60),
					textPreview: (document.body?.innerText || '').slice(0, 220),
					canvases: document.querySelectorAll('canvas').length,
					iframes: document.querySelectorAll('iframe').length,
					iframeSrcs: [...document.querySelectorAll('iframe')].map((f) =>
						(f.getAttribute('src') || '').slice(0, 110)
					),
					resources: res.length,
					pending: res.filter((r) => r.responseEnd === 0).length,
					cloudflareChallenge: document.body?.innerHTML.includes('challenge-platform') || false,
				};
			})
			.catch((e) => ({ error: String(e).slice(0, 140) }));
		log(`[launch t+${((Date.now() - t0) / 1000).toFixed(0)}s]`, JSON.stringify(data));
		if (i === 2 || i === 8)
			await page.screenshot({ path: `launch2-${i}.png` }).catch(() => {});
	}
} catch (e) {
	log('[fatal]', String(e).slice(0, 300));
} finally {
	log('[bad responses]', JSON.stringify(bad.slice(-18), null, 1));
	log('[failed requests]', JSON.stringify(failed.slice(-12), null, 1));
	await browser.close();
}
log('[done]');
