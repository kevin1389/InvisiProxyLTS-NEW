import type { PageDefinition } from './types';

export default function Document(props: PageDefinition) {
	const Head = props.Head;
	const Page = props.Page;
	return (
		<html lang={props.lang}>
			<head>
				<Head />
			</head>
			<body id="top" style={props.bodyStyle}>
				<Page />
				{(props.bodyScripts || []).map((script) => (
					<script {...script} />
				))}
			</body>
		</html>
	);
}
