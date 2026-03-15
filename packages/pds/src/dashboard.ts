import dashboardHtml from "./dashboard.html";

export function renderDashboard(config: {
	hostname: string;
	handle: string;
	did: string;
	version: string;
}): string {
	const configScript = `<script>window.__CIRRUS_CONFIG=${JSON.stringify(config)};</script>`;
	return dashboardHtml.replace("</head>", configScript + "\n</head>");
}
