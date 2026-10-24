// Final probe: through the user's LIVE proxy (Funnel -> prod server -> wisp),
// from inside a proxied frame, fetch a large file and a Range request —
// exactly what emulator/game loads do. Small pages all pass; this tests the
// one thing that hasn't been tested: big sustained transfers.
import { chromium } from 'playwright';

const base = process.argv[2];
if (!base) {
	console.error('usage: node probe-big.mjs <base-url>');
	process.exit(1);
}
const url = base.endsWith('/') ? base : base + '/';
const log = (...a) => console.log(...a);

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const page = await (await browser.newContext()).newPage();
page.on('websocket', (ws) =>
	ws.on('socketerror', (e) => log('[ws error]', String(e).slice(0, 110)))
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
	log('[store in frame] ready');

	// 1. Range request (emulator ROMs stream this way) — expect 206 + 1MB.
	const range = await frame
		.evaluate(async () => {
			try {
				const res = await fetch('https://speed.cloudflare.com/__down?bytes=50000000', {
					headers: { Range: 'bytes=0-1048575' },
				});
				const buf = await res.arrayBuffer();
				return { status: res.status, got: buf.byteLength, contentRange: res.headers.get('content-range') };
			} catch (e) {
				return { error: String(e).slice(0, 150) };
			}
		})
		.catch((e) => ({ error: String(e).slice(0, 150) }));
	log('[range 1MB of 50MB]', JSON.stringify(range));

	// 2. Sustained large transfer: stream 30MB, tracking progress over time.
	const big = await frame
		.evaluate(async () => {
			const t0 = Date.now();
			try {
				const res = await fetch('https://speed.cloudflare.com/__down?bytes=30000000');
				if (!res.ok) return { status: res.status };
				const reader = res.body.getReader();
				let got = 0;
				const marks = [];
				let lastMark = 0;
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					got += value.length;
					const secs = (Date.now() - t0) / 1000;
					if (secs - lastMark >= 5) {
						marks.push(`${secs.toFixed(0)}s:${(got / 1048576).toFixed(1)}MB`);
						lastMark = secs;
					}
					if (secs > 90) {
						marks.push('TIMEOUT-STOP');
						try {
							await reader.cancel();
						} catch {}
						break;
					}
				}
				const secs = (Date.now() - t0) / 1000;
				return {
					status: res.status,
					totalMB: (got / 1048576).toFixed(1),
					seconds: secs.toFixed(1),
					mbps: (got / 1048576 / secs).toFixed(2),
					marks,
				};
			} catch (e) {
				return { error: String(e).slice(0, 150), after: ((Date.now() - t0) / 1000).toFixed(1) + 's' };
			}
		})
		.catch((e) => ({ error: String(e).slice(0, 150) }));
	log('[big 30MB]', JSON.stringify(big));

	// 3. Small file as a control.
	const small = await frame
		.evaluate(async () => {
			try {
				const t0 = Date.now();
				const res = await fetch('https://speed.cloudflare.com/__down?bytes=1048576');
				const buf = await res.arrayBuffer();
				return { status: res.status, bytes: buf.byteLength, ms: Date.now() - t0 };
			} catch (e) {
				return { error: String(e).slice(0, 150) };
			}
		})
		.catch((e) => ({ error: String(e).slice(0, 150) }));
	log('[control 1MB]', JSON.stringify(small));
} catch (e) {
	log('[fatal]', String(e).slice(0, 300));
} finally {
	await browser.close();
}
log('[done]');
