import type { JSX, ParentProps } from 'solid-js';
import { renderToString, ssr } from 'solid-js/web';
import { values, randomItem, inlineHtml, route } from '../site.ts';
export {
	values,
	sites,
	credits,
	route,
	ifSEO,
	ifDisguise,
	inlineHtml,
} from '../site.ts';
export { getSplash } from '../obfuscation/masks.ts';

function serializeHtml(html: string): JSX.Element {
	return ssr(html) as unknown as JSX.Element;
}
export function Splash() {
	return randomItem(values.splash);
}
export function iconBookmarklet() {
	return `javascript:alert((Array.from(document.head.querySelectorAll("link[rel*='icon']")).slice(-1)[0]||0).href||location.origin+"${route('/favicon.ico')}")`;
}
export function Cooking() {
	if (values.usingSEO) return null;
	return (
		<span
			style={{ display: 'none' }}
			data-fact={randomItem(values.cookingFacts)}
		>
			{randomItem(values.cookingText)}
		</span>
	);
}
export function SEO(props: ParentProps) {
	return values.usingSEO ? props.children : null;
}
export function Disguise(props: ParentProps) {
	return values.disguiseFiles ? props.children : null;
}
export function Inline(props: ParentProps): JSX.Element {
	const children = props.children;
	const assets = (Array.isArray(children) ? children : [children])
		.map((child) => renderToString(() => child))
		.join('\n');
	return serializeHtml(inlineHtml(assets));
}
