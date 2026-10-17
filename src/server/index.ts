import { createServer, type IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import { wispurr } from 'wispurr';
import { config, serverPort, serverUrl } from '../config.ts';
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
			error instanceof Error ? error.message : error
		);
		const { server: wisp, logging } = await import(
			'@mercuryworkshop/wisp-js/server'
		);
		logging.set_level(logging.WARN);
		// Mirror the egress restrictions from src/server/wisp.ts and the
		// development fallback in vite.config.ts. Regional Tor/VPN backends
		// have no pure-JS equivalent, so every region shares the default
		// backend until wispurr is usable again.
		Object.assign(wisp.options, {
			wisp_version: 2,
			allow_udp_streams: false,
			allow_direct_ip: false,
			allow_private_ips: false,
			allow_loopback_ips: false,
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
			const backend = wisps.get(region) ?? wisps.get('');
			backend?.route(req, socket, head);
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

server.listen(serverPort, serverUrl.hostname, () => {
	process.send?.({ type: 'ready' });
	console.log(`InvisiProxy is listening on port ${serverPort}.`);
	console.log(
		'When hosting with a reverse proxy please ensure you are using NGINX only.\nCaddy and Apache have security risks due to wispurr and loopbacks. Please configure them correctly.\nNGINX is recommended and used for production. Ports are whitelisted and security is maintained with NGINX only.'
	);
	if (config.disguiseFiles)
		console.log(
			`disguiseFiles is enabled. The site root now serves the entry point (views/dist-new/${entryPointFile}), which unlocks the page loader.`
		);
});
