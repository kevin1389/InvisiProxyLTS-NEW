import { basename, extname, join } from 'node:path';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import ts from 'typescript';
import { config } from '../config.ts';
import { projectDir } from '../constants.ts';
import { externalPages } from '../server/links.ts';
import {
	generatedNames,
	obfuscationState,
	saveObfuscationState,
} from './state.ts';

type Routes = Record<string, string>;
type Links = Record<string, string | Record<string, string>>;

export function getPathAliases(): Record<string, string> {
	if (config.usingSEO) return {};
	const state = obfuscationState();
	if (Object.keys(state.aliases).length) return state.aliases;
	const keys = new Set<string>();
	const source = ts.createSourceFile(
		'pages.ts',
		readFileSync(join(projectDir, 'src/client/pages.ts'), 'utf8'),
		ts.ScriptTarget.Latest,
		true
	);
	function visit(node: ts.Node) {
		if (
			ts.isPropertyAssignment(node) &&
			node.name.getText(source) === 'route'
		) {
			const routes = ts.isArrayLiteralExpression(node.initializer)
				? node.initializer.elements
				: [node.initializer];
			for (const route of routes)
				if (ts.isStringLiteralLike(route) && route.text)
					keys.add(route.text);
		}
		ts.forEachChild(node, visit);
	}
	visit(source);
	for (const [name, target] of Object.entries(externalPages)) {
		if (typeof target === 'string') keys.add(name);
		else
			for (const child of Object.keys(target))
				if (child !== 'default') keys.add(`${name}/${child}`);
	}
	for (const prefix of ['scram', 'libcurl', 'epoxy', 'wisp'])
		keys.add(`prefixes/${prefix}`);
	const assetDir = join(projectDir, 'views/assets');
	const files = (
		existsSync(assetDir)
			? readdirSync(assetDir, {
					recursive: true,
					encoding: 'utf8',
				})
			: []
	)
		.filter((file) => extname(file) && !file.endsWith('.map'))
		.map((file) => basename(file).replace(/\.ts$/, '.js'));
	files.push('sw.js', 'sw-blacklist.js', 'faq-search.js', 'splash.json');
	for (const file of files) keys.add(`files/${file}`);
	const names = generatedNames(keys, 'paths');
	state.aliases = Object.fromEntries(
    Object.entries(names).map(([key, value]) => {
        if (key.startsWith('files/')) return [key, value + extname(key)];
        if (key.includes('/') && !key.startsWith('prefixes/'))
            return [key, key.slice(0, key.indexOf('/') + 1) + value];
        return [key, value];
    })
) as Record<string, string>;
saveObfuscationState(state);
	return state.aliases;
}

export const getAltPrefix = (prefix: string, serverPathname = '/') =>
	`${serverPathname}${getPathAliases()[`prefixes/${prefix}`] || prefix}/`;

export function aliasRoutes<P extends Routes, L extends Links>(
	pages: P,
	links: L
) {
	const aliases = getPathAliases();
	return {
		pages: Object.fromEntries(
			Object.entries(pages)
				.filter(
					([name]) =>
						config.usingSEO ||
						!['robots.txt', 'sitemap.xml'].includes(name)
				)
				.map(([name, target]) => [aliases[name] || name, target])
		) as P,
		links: Object.fromEntries(
			Object.entries(links).map(([name, target]) => [
				aliases[name] || name,
				typeof target === 'string'
					? target
					: Object.fromEntries(
							Object.entries(target).map(([child, url]) => [
								(
									aliases[`${name}/${child}`] ||
									`${name}/${child}`
								)
									.split('/')
									.at(-1) || child,
								url,
							])
						),
			])
		) as L,
	};
}
