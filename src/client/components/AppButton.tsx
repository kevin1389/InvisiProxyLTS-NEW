import { route } from '../document-helpers.tsx';

export default function App(props: {
	url: string;
	name: string;
	newtab?: boolean;
	icon?: string;
}) {
	// A root-absolute icon path names a site-local asset; route() maps it
	// through the obfuscated alias map so the file resolves when served.
	// Relative paths and absolute URLs stay destination-resolved.
	const icon =
		props.icon?.startsWith('/') && !/^https?:/i.test(props.icon)
			? route(props.icon.slice(1))
			: props.icon;
	return (
		<>
			{props.newtab ? (
				<a
					href={props.url}
					target="_blank"
					rel="noopener noreferrer"
					class="dependencylogo tippy-button"
					data-app-url={props.url}
					data-tippy-content={props.name}
					aria-label={props.name}
				>
					<img data-proxy-icon={icon ?? ''} alt={props.name} />
				</a>
			) : (
				<button
					type="button"
					class="dependencylogo tippy-button"
					data-app-url={props.url}
					data-tippy-content={props.name}
					aria-label={props.name}
				>
					<img data-proxy-icon={icon ?? ''} alt={props.name} />
				</button>
			)}
		</>
	);
}
