/**
 * XRPC service proxying with atproto-proxy header support
 * See: https://atproto.com/specs/xrpc#service-proxying
 */

import type { Context } from "hono";
import { DidResolver } from "./did-resolver";
import { getServiceEndpoint } from "@atproto/common-web";
import { createServiceJwt } from "./service-auth";
import { verifyAccessToken } from "./session";
import { getProvider } from "./oauth";
import type { PDSEnv } from "./types";
import type { Secp256k1Keypair } from "@atproto/crypto";

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
	if (!did?.startsWith("did:") || !serviceId) {
		return null;
	}

	return { did, serviceId };
}

/**
 * Handle XRPC proxy requests
 * Routes requests to external services based on atproto-proxy header or lexicon namespace
 */
export async function handleXrpcProxy(
	c: Context<{ Bindings: PDSEnv }>,
	didResolver: DidResolver,
	getKeypair: () => Promise<Secp256k1Keypair>,
): Promise<Response> {
	// Extract XRPC method name from path (e.g., "app.bsky.feed.getTimeline")
	const url = new URL(c.req.url);
	const lxm = url.pathname.replace("/xrpc/", "");

	// Validate XRPC path to prevent path traversal
	if (lxm.includes("..") || lxm.includes("//")) {
		return c.json(
			{
				error: "InvalidRequest",
				message: "Invalid XRPC method path",
			},
			400,
		);
	}

	// Check for atproto-proxy header for explicit service routing
	const proxyHeader = c.req.header("atproto-proxy");
	let audienceDid: string;
	let targetUrl: URL;

	if (proxyHeader) {
		// Parse proxy header: "did:web:example.com#service_id"
		const parsed = parseProxyHeader(proxyHeader);
		if (!parsed) {
			return c.json(
				{
					error: "InvalidRequest",
					message: `Invalid atproto-proxy header format: ${proxyHeader}`,
				},
				400,
			);
		}

		try {
			// Resolve DID document to get service endpoint (with caching)
			const didDoc = await didResolver.resolve(parsed.did);
			if (!didDoc) {
				return c.json(
					{
						error: "InvalidRequest",
						message: `DID not found: ${parsed.did}`,
					},
					400,
				);
			}

			// getServiceEndpoint expects the ID to start with #
			const serviceId = parsed.serviceId.startsWith("#")
				? parsed.serviceId
				: `#${parsed.serviceId}`;
			const endpoint = getServiceEndpoint(didDoc, { id: serviceId });

			if (!endpoint) {
				return c.json(
					{
						error: "InvalidRequest",
						message: `Service not found in DID document: ${parsed.serviceId}`,
					},
					400,
				);
			}

			// Use the resolved service endpoint
			audienceDid = parsed.did;
			targetUrl = new URL(endpoint);
			if (targetUrl.protocol !== "https:") {
				return c.json(
					{
						error: "InvalidRequest",
						message: "Proxy target must use HTTPS",
					},
					400,
				);
			}
			targetUrl.pathname = url.pathname;
			targetUrl.search = url.search;
		} catch (err) {
			return c.json(
				{
					error: "InvalidRequest",
					message: `Failed to resolve service: ${err instanceof Error ? err.message : String(err)}`,
				},
				400,
			);
		}
	} else {
		// Fallback: Route to Bluesky services based on lexicon namespace
		// These are well-known endpoints that don't require DID resolution
		const isChat = lxm.startsWith("chat.bsky.");
		audienceDid = isChat ? "did:web:api.bsky.chat" : "did:web:api.bsky.app";
		const endpoint = isChat ? "https://api.bsky.chat" : "https://api.bsky.app";

		// Construct URL safely using URL constructor
		targetUrl = new URL(`/xrpc/${lxm}${url.search}`, endpoint);
	}

	// Verify auth and create service JWT for target service
	let headers: Record<string, string> = {};
	const auth = c.req.header("Authorization");
	let userDid: string | undefined;

	if (auth?.startsWith("DPoP ")) {
		// Verify DPoP-bound OAuth access token
		try {
			const provider = getProvider(c.env);
			const tokenData = await provider.verifyAccessToken(c.req.raw);
			if (tokenData) {
				userDid = tokenData.sub;
			}
		} catch {
			// DPoP verification failed - continue without auth
		}
	} else if (auth?.startsWith("Bearer ")) {
		const token = auth.slice(7);
		const serviceDid = `did:web:${c.env.PDS_HOSTNAME}`;

		try {
			// Check static token first
			if (token === c.env.AUTH_TOKEN) {
				userDid = c.env.DID;
			} else {
				// Verify JWT
				const payload = await verifyAccessToken(
					token,
					c.env.JWT_SECRET,
					serviceDid,
				);
				if (payload.sub) {
					userDid = payload.sub;
				}
			}
		} catch {
			// Token verification failed - continue without auth
		}
	}

	// Create service JWT if user is authenticated
	if (userDid) {
		try {
			const keypair = await getKeypair();
			const serviceJwt = await createServiceJwt({
				iss: userDid,
				aud: audienceDid,
				lxm,
				keypair,
			});
			headers["Authorization"] = `Bearer ${serviceJwt}`;
		} catch {
			// Service JWT creation failed - forward without auth
		}
	}

	// Forward request with potentially replaced auth header
	// Use Headers object for case-insensitive handling
	const forwardHeaders = new Headers(c.req.raw.headers);

	// Remove headers that shouldn't be forwarded (security/privacy)
	const headersToRemove = [
		"authorization", // Replaced with service JWT
		"atproto-proxy", // Internal routing header
		"host", // Will be set by fetch
		"connection", // Connection-specific
		"cookie", // Privacy - don't leak cookies
		"x-forwarded-for", // Don't leak client IP
		"x-real-ip", // Don't leak client IP
		"x-forwarded-proto", // Internal
		"x-forwarded-host", // Internal
	];

	for (const header of headersToRemove) {
		forwardHeaders.delete(header);
	}

	// Add service auth if we have it
	if (headers["Authorization"]) {
		forwardHeaders.set("Authorization", headers["Authorization"]);
	}

	const reqInit: RequestInit = {
		method: c.req.method,
		headers: forwardHeaders,
	};

	// Include body for non-GET requests
	if (c.req.method !== "GET" && c.req.method !== "HEAD") {
		reqInit.body = c.req.raw.body;
	}

	return fetch(targetUrl.toString(), reqInit);
}
