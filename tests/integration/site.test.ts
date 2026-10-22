import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { fixture, run, buildFixture } from '../helpers/fixture.ts';

for (const usingSEO of [true, false])
	for (const disguiseFiles of [true, false]) {
		test(`production build and HTTP routes: SEO=${usingSEO}, disguise=${disguiseFiles}`, {
			timeout: 180000,
		}, async (t) => {
			const root = await fixture(
				t,
				{
					usingSEO,
					disguiseFiles,
					minifyScripts: usingSEO,
					pathname: usingSEO ? '/' : '/school/',
				},
				true
			);
			await buildFixture(root);
			await run(root, [
				fileURLToPath(
					new URL('../fixtures/http-probe.ts', import.meta.url)
				),
			]);
		});
	}

test('SEO builds give each language its own indexable URLs', {
	timeout: 180000,
}, async (t) => {
	const { writeFile } = await import('node:fs/promises');
	const root = await fixture(
		t,
		{ usingSEO: true, disguiseFiles: false, geoLanguage: true },
		true
	);
	await writeFile(
		join(root, 'src/locales/fr.yaml'),
		[
			'language:',
			'  name: Français',
			'  countries: [FR]',
			'faq:',
			'  meta:',
			'    title: FAQ InvisiProxy',
			'',
		].join('\n')
	);
	await buildFixture(root);
	for (const probe of ['locale-probe.ts', 'http-probe.ts'])
		await run(root, [
			fileURLToPath(new URL(`../fixtures/${probe}`, import.meta.url)),
		]);
});

test('a production rebuild removes stale artifacts and publishes complete documents', {
	timeout: 240000,
}, async (t) => {
	const { writeFile, access, readFile } = await import('node:fs/promises');
	const { join } = await import('node:path');
	const assert = (await import('node:assert/strict')).default;
	const root = await fixture(
		t,
		{ usingSEO: true, disguiseFiles: false },
		true
	);
	await buildFixture(root);
	await writeFile(join(root, 'views/dist/stale.txt'), 'old build');
	await buildFixture(root);
	await assert.rejects(access(join(root, 'views/dist/stale.txt')), {
		code: 'ENOENT',
	});
	await assert.rejects(access(join(root, 'views/dist-new')), {
		code: 'ENOENT',
	});
	assert.match(
		await readFile(join(root, 'views/dist/index.html'), 'utf8'),
		/^<!doctype html>/i
	);
	await run(root, [
		fileURLToPath(new URL('../fixtures/http-probe.ts', import.meta.url)),
	]);
});

test('the built server runs on plain node and relays Wisp', {
	timeout: 120000,
}, async (t) => {
	const root = await fixture(
		t,
		{ usingSEO: true, disguiseFiles: true, pathname: '/school/' },
		true
	);
	await buildFixture(root);
	const server = fork(join(root, 'dist/server.js'), [], {
		cwd: root,
		env: { ...process.env, PORT: '18081', INVISIPROXY_VITE_DEV: '' },
		stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
	});
	const exited = new Promise((resolve) => server.once('exit', resolve));
	t.after(() => server.kill('SIGKILL'));
	await new Promise((resolve, reject) => {
		server.once('message', resolve);
		server.once('exit', () => reject(new Error('Server exited early')));
	});
	const page = await fetch('http://127.0.0.1:18081/school/');
	assert.equal(page.status, 200);
	assert.match(await page.text(), /^<!doctype html>/i);
	const missing = await fetch('http://127.0.0.1:18081/school/not-real.ico');
	assert.equal(missing.status, 404);

	const socket = new WebSocket('ws://127.0.0.1:18081/school/wisp/');
	socket.binaryType = 'arraybuffer';
	const frame = await new Promise<ArrayBuffer>((resolve, reject) => {
		socket.onmessage = (event) => resolve(event.data);
		socket.onerror = () => reject(new Error('Wisp connection failed'));
	});
	assert.ok(frame.byteLength > 0, 'Wisp sends its opening frame');
	socket.close();

	server.kill('SIGTERM');
	await exited;
});
