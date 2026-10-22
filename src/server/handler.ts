import { existsSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import send from 'send';
import { config, serverUrl } from '../config.ts';
import {
	disguiseExtension,
	entryPointFile,
	isDevelopment,
	siteDir,
	siteUrl,
} from '../constants.ts';
import { getPathAliases, getAltPrefix } from '../obfuscation/paths.ts';
import { preloaded404, tryReadFile } from './files.ts';
import { loadLanguages, pickLanguage } from './language.ts';
import { type ClientIp, createLinkDispenser } from './link-dispenser.ts';
import type { ExternalPages } from './links.ts';
import { loadRoutes } from './routes.ts';
import {
	matchesWispPath,
	nonWSRedirect,
	wispOptions,
	wispPath,
} from './wisp.ts';

export type SiteHandler = (req: IncomingMessage, res: ServerResponse) => void;

export interface SiteOptions {
	wispRedirect?: string;
	wispResponse?: string;
	clientIp?: ClientIp;
}

type Disguise = 'pass' | 'loader' | 'modified';

const securityHeaders: [string, string][] = [
	['Cross-Origin-Opener-Policy', 'same-origin'],
	['Cross-Origin-Resource-Policy', 'same-origin'],
	['Origin-Agent-Cluster', '?1'],
	['Referrer-Policy', 'no-referrer'],
	['Strict-Transport-Security', 'max-age=31536000; includeSubDomains'],
	['X-Content-Type-Options', 'nosniff'],
	['X-DNS-Prefetch-Control', 'off'],
	['X-Download-Options', 'noopen'],
	['X-Frame-Options', 'SAMEORIGIN'],
	['X-Permitted-Cross-Domain-Policies', 'none'],
	['X-XSS-Protection', '0'],
];

const pageTypes: Record<string, string> = {
	default: config.disguiseFiles ? 'image/vnd.microsoft.icon' : 'text/html',
	html: 'text/html',
	txt: 'text/plain',
	xml: 'application/xml',
	ico: 'image/vnd.microsoft.icon',
};

const precompressedTypes: Record<string, string> = {
	js: 'application/javascript; charset=utf-8',
	mjs: 'application/javascript; charset=utf-8',
	wasm: 'application/wasm',
};
const encodings = [
	['br', '.br'],
	['gzip', '.gz'],
] as const;

const trimSlash = (path: string) =>
	path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;

// Subresource requests that must never receive the anti-detection
// documents (the loader page or the favicon-disguised 404). Serving HTML
// or an icon for them triggers the browser's strict MIME refusal
// ("Refused to execute script … its MIME type is not executable") and
// black-screens games and proxied apps.
const scriptDests = new Set([
	'script',
	'worker',
	'sharedworker',
	'serviceworker',
]);
const scriptExt = /\.(?:mjs|js|wasm)$/;
const isScriptLike = (dest: string, path: string) =>
	scriptDests.has(dest) || scriptExt.test(path);

const decode = (path: string) => {
	try {
		return decodeURIComponent(path);
	} catch {
		return path;
	}
};

const extension = (file: string) => file.slice(file.lastIndexOf('.') + 1);

/**
 * Whether a response can still be answered normally. A transfer that has
 * already put bytes on the wire, a finished response, and a response whose
 * peer vanished mid-stream all reject further writes, and setHeader()
 * answers with ERR_HTTP_HEADERS_SENT. Raised from a stream event handler
 * that is an uncaught exception, which kills the process — and with it
 * every other session currently streaming through the proxy. Heavy games
 * and chat apps abort and restart asset transfers constantly, so this path
 * is hit in normal operation rather than rarely.
 */
const responseUsable = (res: ServerResponse) =>
	!res.headersSent && !res.writableEnded && !res.destroyed;

/** Drop a response that can no longer carry a body, without throwing. */
const abandon = (res: ServerResponse) => {
	if (!res.writableEnded) res.destroy();
};

function reply(
	res: ServerResponse,
	status: number,
	type?: string,
	body?: string | Buffer
) {
	if (!responseUsable(res)) return abandon(res);
	const payload = typeof body === 'string' ? Buffer.from(body) : body;
	res.statusCode = status;
	if (type) res.setHeader('Content-Type', type);
	res.setHeader('Content-Length', payload?.length ?? 0);
	res.end(payload);
}

function redirect(res: ServerResponse, location: string) {
	res.setHeader('Location', location);
	reply(res, 302);
}

function disguiseCheck(
	pages: Record<string, string>,
	externalPages: ExternalPages,
	wispRoute: string
): (url: string) => Disguise {
	if (!config.disguiseFiles) return () => 'pass';
	const base = serverUrl.pathname;
	const otherFile = new RegExp(
		`\\.(?!html$|${disguiseExtension}$)[\\w-]+$`,
		'i'
	);
	const exemptDirs = ['assets', 'scram', 'libcurl', 'epoxy', 'wisp'].map(
		(dir) => getAltPrefix(dir, base).slice(base.length, -1)
	);
	const exemptPages = ['', 'favicon.ico'];
	for (const [name, target] of Object.entries(externalPages))
		(typeof target === 'string' ? exemptPages : exemptDirs).push(name);
	exemptPages.push(...exemptDirs);

	return (url) => {
		let pathname: string;
		try {
			pathname = new URL(url, serverUrl).pathname;
		} catch {
			return 'pass';
		}
		// The Wisp endpoint must keep its designated non-WS response in every
		// encoding it can arrive in (query, percent-encoded slashes) instead of
		// falling through to the loader or a 404 before the upgrade happens.
		if (matchesWispPath(pathname, wispRoute)) return 'pass';
		const path = pathname.slice(base.length);
		if (
			otherFile.test(path) ||
			exemptDirs.some(
				(dir) => path === dir || path.startsWith(`${dir}/`)
			) ||
			exemptPages.includes(path)
		)
			return 'pass';
		if (!path.endsWith(`.${disguiseExtension}`)) return 'loader';
		if (!Object.hasOwn(pages, path) && !path.endsWith('favicon.ico'))
			return 'modified';
		return 'pass';
	};
}

function applyResponseHooks(
	req: IncomingMessage,
	res: ServerResponse,
	development: boolean
) {
	for (const [name, value] of securityHeaders) res.setHeader(name, value);
	const historyHide = (req.headers.cookie || '')
		.split('; ')
		.find((cookie) => cookie.startsWith('HistoryHide='))
		?.split('=')[1];
	const hide =
		historyHide === 'true' && req.headers['sec-fetch-dest'] === 'document';
	if (!hide && !development) return;
	const writeHead = res.writeHead;
	res.writeHead = function (
		this: ServerResponse,
		statusCode: number,
		...args: unknown[]
	) {
		if (development) {
			for (const arg of args)
				if (arg && typeof arg === 'object' && !Array.isArray(arg))
					for (const key of Object.keys(arg))
						if (key.toLowerCase() === 'cache-control')
							delete (arg as Record<string, unknown>)[key];
			this.setHeader('Cache-Control', 'no-store');
		}
		return (writeHead as (...args: unknown[]) => ServerResponse).call(
			this,
			hide &&
				!(
					statusCode >= 300 &&
					statusCode < 400 &&
					this.hasHeader('Location')
				)
				? 404
				: statusCode,
			...args
		);
	} as typeof res.writeHead;
}

export function createSiteHandler({
	wispRedirect = nonWSRedirect,
	wispResponse = wispOptions.nonWSResponse,
	clientIp,
}: SiteOptions = {}): SiteHandler {
	const { pages, externalPages } = loadRoutes();
	const base = serverUrl.pathname;
	const baseRoute = trimSlash(base);
	const development = isDevelopment();
	const dispenserPath = `${base}api/link`;
	const dispense = createLinkDispenser(undefined, clientIp);
	const wispRoute = trimSlash(wispPath());
	const checkDisguise = disguiseCheck(pages, externalPages, wispRoute);
	const loaderPage = config.disguiseFiles
		? tryReadFile('pages/misc/deobf/loader.html', siteUrl, false)
		: '';
	const serviceWorkers = new Map(
		['sw.js', 'sw-blacklist.js'].map((file) => {
			const name = getPathAliases()[`files/${file}`] || file;
			return [base + name, name];
		})
	);

	const staticDirs = ['assets', 'scram', 'libcurl', 'epoxy'].map(
		(prefix) => ({
			prefix: getAltPrefix(prefix, base),
			root: join(siteDir, prefix),
			precompressed: prefix !== 'assets' && !development,
			vary: prefix !== 'assets',
			proxy: true,
		})
	);
	const pagesDir = {
		prefix: base,
		root: join(siteDir, 'pages'),
		precompressed: false,
		vary: false,
		proxy: false,
	};
	type StaticDir = typeof pagesDir;

	const languages = loadLanguages();
	const languageVary = config.geoLanguage
		? 'Cookie, Accept-Language, CF-IPCountry'
		: 'Cookie, Accept-Language';
	const prefixedLanguages = config.usingSEO
		? languages.codes.filter((code) => code !== languages.default)
		: [];
	const redirectToLanguage =
		prefixedLanguages.length > 0 && !config.disguiseFiles;
	const languageFor = (req: IncomingMessage) => {
		if (languages.codes.length < 2) return '';
		const useCountry =
			config.geoLanguage &&
			(!config.usingSEO || !!req.headers['accept-language']);
		const language = pickLanguage(req, languages, useCountry);
		return language === languages.default ? '' : language;
	};
	const translated = (file: string, language: string) => {
		const copy = `locales/${language}/${file}`;
		return language &&
			file.endsWith('.html') &&
			existsSync(new URL(copy, siteUrl))
			? copy
			: file;
	};

	const notFound = (
		res: ServerResponse,
		language = '',
		scriptLike = false
	) => {
		// A transfer that already started, or a client that already went away,
		// cannot be answered with a 404 any more — try anyway and the process
		// dies on the thrown setHeader error.
		if (!responseUsable(res)) return abandon(res);
		// Never let a failure be cached: a stale obfuscation alias behind a CDN
		// or browser cache would otherwise pin a 404 until it expires.
		res.setHeader('Cache-Control', 'no-store');
		// A missing script or worker fails honestly instead of answering with
		// the anti-detection HTML/icon document, which the browser refuses
		// to execute as JavaScript and reports as a MIME type error.
		if (scriptLike)
			return reply(res, 404, 'text/plain; charset=utf-8', 'Not Found');
		reply(res, 404, pageTypes.default, preloaded404(language));
	};

	/**
	 * A miss inside a static/proxy directory (assets, scram, libcurl, epoxy).
	 * These paths already bypass the disguise layer, so answering with the
	 * anti-detection favicon document only breaks clients: scripts and proxied
	 * sub-requests get `image/vnd.microsoft.icon` and cannot execute, which
	 * surfaces as black-screened game frames when a request reaches the origin
	 * without a controlling service worker. Fail honestly instead.
	 */
	const staticNotFound = (res: ServerResponse) => {
		if (!responseUsable(res)) return abandon(res);
		// Never let a failure be cached either: a stale 404 behind a CDN or
		// tunnel cache would keep breaking proxied sub-requests after the
		// asset is restored by a rebuild.
		res.setHeader('Cache-Control', 'no-store');
		reply(res, 404, 'text/plain; charset=utf-8', 'Not Found');
	};

	const undisguise = (path: string) =>
		path.slice(0, path.length - 1 - disguiseExtension.length);

	function servePage(
		req: IncomingMessage,
		res: ServerResponse,
		name: string,
		modified: boolean,
		language: string,
		fromPath: boolean,
		scriptLike = false
	) {
		// The page layer only serves HTML documents, favicon bytes and
		// external redirects — none of which a script, worker or module can
		// execute. Answer honestly instead of handing the browser an HTML
		// document it will reject with a strict MIME type error.
		if (scriptLike) return notFound(res, language, true);
		if (name === 'favicon.ico') return reply(res, 200);

		if (Object.hasOwn(externalPages, name)) {
			if (modified || fromPath)
				return reply(res, 404, pageTypes.html, preloaded404(language));
			const target = externalPages[name];
			return redirect(
				res,
				typeof target === 'string' ? target : target.default
			);
		}

		if (!Object.hasOwn(pages, name)) return notFound(res, language);
		const file =
			!name && config.disguiseFiles && !modified
				? entryPointFile
				: pages[name];
		const type = modified
			? pageTypes[disguiseExtension]
			: pageTypes[extension(file)] || pageTypes.default;
		// Documents must always revalidate: they embed per-build obfuscation
		// aliases, and a cached copy served after a rebuild points at asset
		// and service-worker names that no longer exist (every proxied page
		// then 404s behind CDNs and tunnels until the cache is cleared).
		res.setHeader('Cache-Control', 'no-cache');
		if (file === entryPointFile)
			return reply(res, 200, type, tryReadFile(file, siteUrl));
		if (fromPath && !file.endsWith('.html')) return notFound(res, language);
		if (!fromPath && languages.codes.length > 1)
			res.setHeader('Vary', languageVary);
		if (
			redirectToLanguage &&
			!fromPath &&
			language &&
			file.endsWith('.html')
		) {
			const url = req.url || '';
			const query = url.includes('?') ? url.slice(url.indexOf('?')) : '';
			return redirect(res, `${base}${language}/${name}${query}`);
		}
		reply(res, 200, type, tryReadFile(translated(file, language), siteUrl));
	}

	function serveStatic(
		req: IncomingMessage,
		res: ServerResponse,
		dir: StaticDir,
		file: string,
		language: string
	) {
		res.removeHeader('Content-Type');
		const type = precompressedTypes[extension(file)];
		const accepted = String(req.headers['accept-encoding'] || '');
		const candidates =
			dir.precompressed && type
				? encodings.filter(([name]) => accepted.includes(name))
				: [];
		const attempt = (index: number) => {
			const encoding = candidates[index];
			const stream = send(req, `/${file}${encoding ? encoding[1] : ''}`, {
				root: dir.root,
				index: false,
			});
			stream.on('headers', () => {
				if (type) res.setHeader('Content-Type', type);
				if (encoding) res.setHeader('Content-Encoding', encoding[0]);
				if (dir.vary) res.setHeader('Vary', 'Accept-Encoding');
			});			// Proxy directories and script-class requests always fail honestly:
			// the page fallbacks are HTML/icon documents that browsers refuse
			// to run as JavaScript or wasm.
			const honest =
				dir.proxy ||
				isScriptLike(
					String(req.headers['sec-fetch-dest'] || ''),
					decode(file)
				);
			stream.on('directory', () =>
				honest ? staticNotFound(res) : notFound(res, language)
			);
			stream.on('error', () => {
				// Once any bytes have gone out the transfer is over: retrying
				// another encoding or swapping in a 404 would append a second
				// response to a live stream and throw. Drop the socket instead.
				if (!responseUsable(res)) return abandon(res);
				if (index < candidates.length) attempt(index + 1);
				else if (honest) staticNotFound(res);
				else notFound(res, language);
			});
			stream.pipe(res);
		};
		attempt(0);
	}

	return (req, res) => {
		// Peer resets are normal traffic here — a game navigating away, a// tunnel drop, a closed tab — and pipe() deliberately does not forward
		// destination errors. Without a listener an 'error' on either side of
		// the exchange becomes an uncaught exception that takes the process
		// down with every other session on it, so absorb them and let the
		// response end.
		req.on('error', () => {});
		res.on('error', () => {});
		applyResponseHooks(req, res, development);
		let url = req.url || '/';
		let path = trimSlash(url.split('?')[0].replace(/\/{2,}/g, '/'));
		// /fr/questions is the French copy of /questions.
		const prefix = prefixedLanguages.find(
			(code) => path === base + code || path.startsWith(`${base}${code}/`)
		);
		if (prefix) {
			const query = url.indexOf('?');
			path = trimSlash(
				base +
					path.slice(base.length + prefix.length).replace(/^\//, '')
			);
			url = path + (query < 0 ? '' : url.slice(query));
		}
		const language = prefix || languageFor(req);

		if (req.method === 'POST' && path === dispenserPath)
			return void dispense(req, res);

		if (path !== baseRoute && !path.startsWith(base))
			return reply(res, 404, 'text/plain', 'Not Found');

		const disguise = checkDisguise(url);
		const dest = String(req.headers['sec-fetch-dest'] || '');
		const scriptLike = isScriptLike(dest, decode(path));
		// Script and worker requests bypass the anti-detection layer entirely:
		// the loader page and favicon documents are not executable, so serving
		// them here is exactly what triggers strict MIME refusals upstream.
		if (disguise === 'loader' && !scriptLike)
			return reply(res, 200, pageTypes.html, loaderPage);
		const modified = disguise === 'modified' && !scriptLike;
		if (modified) {
			res.setHeader('Content-Type', pageTypes[disguiseExtension]);
			res.setHeader('Access-Control-Allow-Origin', 'null');
		}
		if (req.method !== 'GET' && req.method !== 'HEAD')
			return notFound(res, language, scriptLike);

		if (matchesWispPath(path, wispRoute))
			return wispRedirect
				? redirect(res, wispRedirect)
				: reply(res, 200, 'text/plain', wispResponse);

		const serviceWorker = serviceWorkers.get(path);
		if (serviceWorker !== undefined) {
			res.setHeader('Service-Worker-Allowed', base);
			// Service worker scripts must revalidate or updated workers are
			// never picked up behind caches.
			res.setHeader('Cache-Control', 'no-cache');
			return reply(
				res,
				200,
				'application/javascript',
				tryReadFile(serviceWorker, siteUrl)
			);
		}

		const relative = path === baseRoute ? '' : path.slice(base.length);
		// A directory root inside a proxy dir (its trailing slash was trimmed
		// above) must stay with that dir's handler instead of falling back to
		// the page layer and its loader/favicon documents.
		const dirRoot = staticDirs.find((dir) => `${path}/` === dir.prefix);
		if (dirRoot) return serveStatic(req, res, dirRoot, '', language);
		if (!relative.includes('/')) {
			const name = decode(relative);
			return servePage(
				req,
				res,
				modified ? undisguise(name) : name,
				modified,
				language,
				!!prefix,
				scriptLike
			);
		}

		const github = /^github\/([^/]+)$/.exec(relative);
		if (github) {
			const name = decode(github[1]);
			return Object.hasOwn(externalPages.github, name)
				? redirect(res, externalPages.github[name])
				: notFound(res, language, scriptLike);
		}

		// A directory root inside a proxy dir (trailing slash trimmed earlier)
		// must stay with that dir's handler instead of falling back to the
		// page layer and its favicon document.
		const dir =
			staticDirs.find(
				(dir) =>
					path.startsWith(dir.prefix) || `${path}/` === dir.prefix
			) || pagesDir;
		const file = path.slice(dir.prefix.length);
		serveStatic(
			req,
			res,
			dir,
			modified ? undisguise(file) : file,
			language
		);
	};
}
