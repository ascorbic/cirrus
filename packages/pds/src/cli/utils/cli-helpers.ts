/**
 * Shared CLI utilities for PDS commands
 */

/**
 * Get target PDS URL based on mode
 */
export function getTargetUrl(isDev: boolean, pdsHostname: string | undefined): string {
	const LOCAL_PDS_URL = "http://localhost:5173";

	if (isDev) {
		return LOCAL_PDS_URL;
	}
	if (!pdsHostname) {
		throw new Error("PDS_HOSTNAME not configured in wrangler.jsonc");
	}
	return `https://${pdsHostname}`;
}

/**
 * Extract domain from URL
 */
export function getDomain(url: string): string {
	try {
		return new URL(url).hostname;
	} catch {
		return url;
	}
}
