/**
 * Whether a request URL belongs to the Scramjet proxy prefix. blob:/data:
 * URLs never resolve against the proxy filesystem and stay with the
 * browser's native handler; prefix-wrapped blob requests (Scramjet rewrites
 * them so the controller can serve them through its blob fetcher) still
 * match the prefix and keep routing normally.
 */
export function isScramjetRouteUrl(
	url: string,
	networkPrefixPath: string
): boolean {
	if (/^(?:blob|data):/.test(url)) return false;
	try {
		return new URL(url).pathname.startsWith(networkPrefixPath);
	} catch {
		return false;
	}
}

export interface ProxiedClient {
	controllerId: string;
	frameId: string;
	target: URL;
}

/**
 * Parse a proxied document URL (`<prefix><controllerId>/<frameId>/<encoded
 * target>`) back into the frame ids and remote target it is proxying, or
 * null when the URL is not a proxied document (top-level proxy pages, the
 * service worker itself, malformed input).
 */
export function proxiedClientFor(
	clientUrl: string | undefined,
	networkPrefixPath: string
): ProxiedClient | null {
	if (!clientUrl) return null;
	let path: string;
	try {
		path = new URL(clientUrl).pathname;
	} catch {
		return null;
	}
	if (!path.startsWith(networkPrefixPath)) return null;
	const rest = path.slice(networkPrefixPath.length).split('/');
	if (rest.length < 3 || !rest[0] || !rest[1]) return null;
	try {
		const target = new URL(decodeURIComponent(rest.slice(2).join('/')));
		if (!['http:', 'https:'].includes(target.protocol)) return null;
		return { controllerId: rest[0], frameId: rest[1], target };
	} catch {
		return null;
	}
}

/**
 * Re-wrap an escaped request (anything a proxied client requested outside
 * the Scramjet prefix — images, fonts, wasm, media, but also scripts,
 * styles, manifests and arbitrary game binaries whose extensions no
 * allowlist could predict) so it loads through the same Wisp-backed
 * controller route instead of falling through to this origin's static site
 * server, which answers remote asset paths with 404s — or, worse, firing it
 * as a direct cross-origin request that only has to survive whatever
 * network sits in front of the proxy origin (a Cloudflare tunnel drops,
 * rate-limits or buffers those; the single Wisp connection does not).
 * Root-relative requests are re-resolved against the proxied document's
 * real origin; already-absolute cross-origin requests are wrapped as-is.
 * Navigations and everything that should stay native return null.
 */
export function proxiedAssetUrl(
	requestUrl: string,
	clientUrl: string | undefined,
	networkPrefixPath: string,
	proxyOrigin: string,
	requestMode?: string
): string | null {
	let url: URL;
	try {
		url = new URL(requestUrl);
	} catch {
		return null;
	}
	if (!['http:', 'https:'].includes(url.protocol)) return null;
	if (url.pathname.startsWith(networkPrefixPath)) return null;
	// The proxy engine's own files under its prefix directory (Scramjet
	// bundle, controller and inject scripts, wasm/worker payloads) are this
	// origin's infrastructure and are referenced as such by proxied frames.
	// Re-wrapping them would ask the frame's target origin for them, so the
	// remote server answers with its own 404, the frame's scripts never load,
	// and games and apps hang on black screens. Keep them native so the
	// origin's static handler serves them directly.
	const enginePrefix = networkPrefixPath.endsWith('network/')
		? networkPrefixPath.slice(0, -'network/'.length)
		: '';
	if (
		enginePrefix &&
		url.origin === proxyOrigin &&
		url.pathname.startsWith(enginePrefix)
	)
		return null;
	// A navigation must never be reconstructed as a wrapped subresource
	// request; document requests are filtered out before this point, but the
	// mode guard keeps any navigation-shaped request on its native path.
	if (requestMode === 'navigate') return null;
	const client = proxiedClientFor(clientUrl, networkPrefixPath);
	if (!client) return null;
	const target =
		url.origin === proxyOrigin
			? new URL(url.pathname + url.search, client.target.origin)
			: url;
	return new URL(
		`${networkPrefixPath}${client.controllerId}/${client.frameId}/${encodeURIComponent(target.href)}`,
		proxyOrigin
	).href;
}
