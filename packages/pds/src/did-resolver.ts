/**
 * Proxy header parsing for XRPC service proxying
 * DID resolution now handled by @atproto/identity package
 */

/**
 * Parse atproto-proxy header value
 * Format: "did:web:example.com#service_id"
 * Returns: { did: "did:web:example.com", serviceId: "service_id" }
 */
export function parseProxyHeader(
	header: string,
): { did: string; serviceId: string } | null {
	const parts = header.split("#");
	if (parts.length !== 2) {
		return null;
	}

	const [did, serviceId] = parts;
	if (!did.startsWith("did:")) {
		return null;
	}

	return { did, serviceId };
}
