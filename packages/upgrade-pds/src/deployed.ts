const VERSION = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/;

/**
 * The `@getcirrus/pds` version a deployed PDS reports at its health endpoint,
 * or nothing when it cannot be reached or does not say.
 */
export async function fetchDeployedVersion(
	hostname: string,
	fetcher: typeof fetch = fetch,
): Promise<string | undefined> {
	try {
		const response = await fetcher(`https://${hostname}/xrpc/_health`, {
			headers: { Accept: "application/json", "User-Agent": "upgrade-pds" },
			signal: AbortSignal.timeout(5000),
		});
		if (!response.ok) return undefined;
		const health: unknown = await response.json();
		const version =
			typeof health === "object" && health !== null
				? Reflect.get(health, "version")
				: undefined;
		return typeof version === "string"
			? version.match(VERSION)?.[0]
			: undefined;
	} catch {
		return undefined;
	}
}
