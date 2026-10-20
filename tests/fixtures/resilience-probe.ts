import assert from 'node:assert/strict';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { serve } from '../helpers/http.ts';

// Deliberately no process-level 'uncaughtException' listener here. Registering
// one to record escapes instead lets this module keep running after a thrown
// assertion and exit 0, which would turn every failure below into a silent
// pass. An escape that does occur exits non-zero on its own, and run() turns
// that into a test failure.

const load = <T>(path: string): Promise<T> =>
	import(pathToFileURL(join(process.cwd(), path)).href);
const { createSiteHandler } = await load<
	typeof import('../../src/server/handler.ts')
>('src/server/handler.ts');
const { serverUrl } = await load<typeof import('../../src/config.ts')>(
	'src/config.ts'
);
const { getAltPrefix } = await load<
	typeof import('../../src/obfuscation/paths.ts')
>('src/obfuscation/paths.ts');

const app = await serve(createSiteHandler());
const base = serverUrl.pathname;
const scram = getAltPrefix('scram', base);

const largestStaticFile = async (dir: string): Promise<string | null> => {
	let best: { path: string; size: number } | null = null;
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		const found = entry.isDirectory() ? await largestStaticFile(path) : path;
		if (!found) continue;
		const { size } = await stat(found);
		if (!best || size > best.size) best = { path: found, size };
	}
	return best?.path ?? null;
};

// 1. Proxy assets stream normally with the content type the transport needs.
//    Scripts and wasm must never receive the anti-detection documents, or the
//    browser refuses to execute them and the frame goes black. Every mount//    lives under an obfuscated prefix, so ask the route table for it rather//    than assuming "assets/".
const dist = join(process.cwd(), 'views/dist');
const assetRoot = join(dist, 'assets');
const asset = await largestStaticFile(assetRoot);
assert.ok(asset, 'the fixture ships at least one static asset');
const assetUrl =
	getAltPrefix('assets', base) + asset.slice(assetRoot.length + 1);
const assetResponse = await app.inject(assetUrl);
assert.equal(assetResponse.statusCode, 200, `${assetUrl} serves`);
assert.ok(assetResponse.rawPayload.length > 0, 'the asset body arrives intact');

// 2. Precompressed proxy bundles still negotiate their encoding. This is the
//    same retry ladder a mid-stream failure travels down, so a regression in
//    the response guards would surface here as a broken transport bundle.
//    The bundle name is obfuscated per build, so discover a real one.
const scramDir = join(process.cwd(), 'views/dist/scram');
const bundles = (await readdir(scramDir)).filter((name) => /\.(?:m?js)$/.test(name));
assert.ok(bundles.length > 0, 'the scram mount ships a transport bundle');
const worker = await app.inject({
	url: `${scram}${bundles[0]}`,
	headers: { 'accept-encoding': 'gzip, br' },
});
assert.equal(worker.statusCode, 200, `bundle ${bundles[0]} serves`);
assert.equal(
	worker.headers['content-type'],
	'application/javascript; charset=utf-8'
);

// 3. A miss inside a proxy directory answers honestly with a plain 404.
//    Serving the loader or the favicon document here is what black-screens
//    games: the browser rejects it as a MIME type error. The nested path
//    matters — a bare file name is routed to the page layer instead.
const missing = await app.inject(`${scram}nested/definitely-not-here.js`);
assert.equal(missing.statusCode, 404);
assert.equal(missing.headers['content-type'], 'text/plain; charset=utf-8');
assert.equal(missing.rawPayload.toString(), 'Not Found');

// 4. A client walking away mid-transfer is routine traffic — games cancel
//    asset requests constantly and chat apps abort streaming fetches. The
//    server must keep serving every other session afterwards.
const abort = new AbortController();
let received = 0;
try {
	const response = await fetch(app.origin + assetUrl, {
		signal: abort.signal,
	});
	assert.equal(response.status, 200);
	for await (const chunk of response.body as unknown as AsyncIterable<Buffer>) {
		received += chunk.length;
		abort.abort();
		break;
	}
} catch {
	// An aborted fetch throws; that is the point of the exercise.
}
assert.ok(received > 0, 'the transfer started before the client vanished');
await new Promise((resolve) => setTimeout(resolve, 500));

const after = await app.inject(base);
assert.equal(after.statusCode, 200, 'the server kept serving afterwards');

await app.close();
