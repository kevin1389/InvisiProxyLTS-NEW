import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildFixture, fixture, run } from '../helpers/fixture.ts';

// A client disconnecting mid-download is routine for a proxy: games cancel
// asset requests constantly and chat apps abort streaming fetches. The site
// handler must also keep answering proxy-asset misses with a plain 404 — the
// loader and favicon documents are not executable, and handing them to a
// script or wasm request is what black-screens proxied games.
test(
	'the site handler keeps serving after an aborted transfer, and answers proxy misses honestly',
	{ timeout: 180_000 },
	async (t) => {
		const root = await fixture(
			t,
			{ usingSEO: true, disguiseFiles: false },
			true
		);
		await buildFixture(root);
		await run(root, [
			fileURLToPath(
				new URL('../fixtures/resilience-probe.ts', import.meta.url)
			),
		]);
	}
);
