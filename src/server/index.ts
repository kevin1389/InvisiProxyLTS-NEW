import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import { createRequire } from 'node:module';
import { platform } from 'node:os';
import { dirname, join } from 'node:path';
import { Socket } from 'node:net';
import { wispurr } from 'wispurr';
import { config, serverPort } from '../config.ts';
import { entryPointFile } from '../constants.ts';
import { createSiteHandler } from './handler.ts';
import {
	wispPath,
	wispOptions,
	wispProxies,
	wispRegion,
	type WispRegion,
} from './wisp.ts';

/**
 * wispurr ships one Go worker per platform, and every Linux build is linked
 * against musl. On a glibc host (Debian, Ubuntu, most PaaS images) exec
 * fails with ENOENT even though the binary is present and executable,
 * because the loader it names — /lib/ld-musl-x86_64.so.1 — is not there.
 * That makes the failure read like a missing file and sends operators
 * looking in the wrong place, so probe the worker up front and report what
 * is actually wrong.
 */
const require = createRequire(import.meta.url);
const muslLoader = '/lib/ld-musl-x86_64.so.1';

const diagnoseWispurr = (): string | null => {
	const worker = join(
		dirname(require.resolve('wispurr/package.json')),
		'bin',
		`${platform()}-${process.arch}`,
		platform() === 'win32' ? 'wispurr.exe' : 'wispurr'
	);
	if (!existsSync(worker))
		return `no wispurr worker is published for ${platform()}-${process.arch}`;
	let probe: ReturnType<typeof spawnSync>;
	try {
		probe = spawnSync(worker, ['--version'], {
			stdio: 'ignore',
			timeout: 10_000,
		});
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	if (!probe.error) return null;
	if (platform() === 'linux' && !existsSync(muslLoader))
		return `the bundled worker is a musl build but this host is glibc (${muslLoader} is absent); run the official container image, which is Alpine, or install musl`;
	return probe.error.message;
};

/**
 * A Wisp backend regardless of implementation: the wispurr Go worker exposes
 * route/stop/kill/isRunning, while the pure-JS fallback only routes.
 */
interface WispBackend {
	route(req: IncomingMessage, socket: Socket, head: Buffer): void;
	stop?(): Promise<void> | void;
	kill?(): void;
}

/**
 * wispurr drives a Go worker binary that may be missing or built for another
 * platform/libc (e.g. the published musl build on a glibc host, where the
 * spawn fails with ENOENT because the musl dynamic loader is absent). Probe
 * the fleet at startup and fall back to the pure-JS Wisp server so the site
 * still serves and the proxy still works without a working Go toolchain —
 * the same degradation vite.config.ts already applies in development.
 */
const startWisps = async (): Promise<Map<string, WispBackend>> => {
	try {
		const entries: [string, WispBackend][] = [
			['', new wispurr(wispOptions)],
		];
		for (const region of Object.keys(wispProxies) as WispRegion[])
			entries.push([
				region,
				new wispurr({ ...wispOptions, proxy: wispProxies[region] }),
			]);
		const wisps = new Map<string, WispBackend>(entries);
		for (const wisp of wisps.values()) await (wisp as wispurr).start(1);
		return wisps;
	} catch (error) {
		console.warn(
			'wispurr is unavailable; falling back to the pure-JS Wisp server:',
			diagnoseWispurr() ??
				(error instanceof Error ? error.message : error)
		);
		const { server: wisp, logging } = await import(
			'@mercuryworkshop/wisp-js/server'
		);
		logging.set_level(logging.WARN);
		// Mirror the egress restrictions from src/server/wisp.ts and the
		// development fallback in vite.config.ts. The pure-JS server has no
		// SOCKS support, so the regional Tor/VPN backends cannot be
		// represented here at all — they are deliberately absent from the
		// returned map rather than aliased onto the default backend, which
		// would quietly send traffic a user selected Tor for out to the
		// clearnet.
		Object.assign(wisp.options, {
			wisp_version: 2,
			allow_udp_streams: false,
			allow_direct_ip: false,
			allow_private_ips: false,
			allow_loopback_ips: wispOptions.allowLoopbackIPs,
			port_blacklist: wispOptions.blacklist.ports,
			dns_result_order: wispOptions.dnsResultOrder,
			parse_real_ip: wispOptions.parseRealIP,
			parse_real_ip_from: wispOptions.trustedProxies,
		});
		return new Map<string, WispBackend>([
			[
				'',
				{
					route: (req, socket, head) =>
						wisp.routeRequest(req, socket, head),
				},
			],
		]);
	}
};

const wisps = await startWisps();

const server = createServer(createSiteHandler()).on(
	'upgrade',
	(req, socket, head) => {
		const region = wispRegion(req.url);
		if (socket instanceof Socket && region !== null) {
			// Hand the Wisp backend its canonical path: query strings or
			// percent-encoded variants must never reach path-sensitive
			// routing inside the transport.
			req.url = wispPath();
			const backend = wisps.get(region);
			if (!backend) {
				// Only the pure-JS fallback can be missing a region: wispurr
				// always starts every backend. Routing to the default here
				// instead would egress the request directly while the user
				// believes Tor or a VPN is in use, so an unavailable region
				// fails visibly rather than silently degrading.
				socket.destroy();
				return;
			}
			backend.route(req, socket, head);
		} else socket.destroy();
	}
);

let shuttingDown = false;
const stopServer = async () => {
	if (shuttingDown) return;
	shuttingDown = true;
	await Promise.all([...wisps.values()].map((wisp) => wisp.stop?.()));
	server.closeAllConnections();
	server.close();
};
process.once('SIGTERM', () => void stopServer());
process.once('SIGINT', () => void stopServer());
process.once('exit', () => {
	for (const wisp of wisps.values()) wisp.kill?.();
});

// A reverse proxy sits in front of production deployments (the startup
// banner recommends nginx, and Freebuff's tunnel does the same here), and
// it pools keep-alive connections it believes are still open. Node defaults
// keepAliveTimeout to 5s while nginx defaults keepalive_timeout to 75s, so
// nginx keeps handing requests to sockets Node has already closed; those
// responses are dropped mid-flight and the client just sees a stream that
// stops part-way through. That is exactly the shape of a chat transcript or
// a proxied game asset transfer that dies during an otherwise healthy
// session, so hold idle sockets well past any sane proxy default and keep
// headersTimeout above it the way Node requires.
server.keepAliveTimeout = 120_000;
server.headersTimeout = 130_000;


server.listen(serverPort, '0.0.0.0', () => {
	process.send?.({ type: 'ready' });
	console.log(`InvisiProxy is listening on port ${serverPort}.`);
	console.log(
		'When hosting with a reverse proxy please ensure you are using NGINX only.\nCaddy and Apache have security risks due to wispurr and loopbacks. Please configure them correctly.\nNGINX is recommended and used for production. Ports are whitelisted and security is maintained with NGINX only.'
	);
	if (config.disguiseFiles)
		console.log(
			`disguiseFiles is enabled. The site root now serves the entry point (views/dist/${entryPointFile}), which unlocks the page loader.`
		);
});
