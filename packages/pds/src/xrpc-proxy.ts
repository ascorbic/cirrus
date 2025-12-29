/**
 * XRPC service proxying with atproto-proxy header support
 * See: https://atproto.com/specs/xrpc#service-proxying
 */

import type { Context } from "hono";
import { DidResolver } from "@atproto/identity";
import { getServiceEndpoint } from "@atproto/common-web";
import { createServiceJwt } from "./service-auth";
import { verifyAccessToken } from "./session";
import type { PDSEnv } from "./types";
import type { Secp256k1Keypair } from "@atproto/crypto";

// Bluesky service DIDs and endpoints for service auth
const APPVIEW_DID = "did:web:api.bsky.app";
const APPVIEW_ENDPOINT = "https://api.bsky.app";
const CHAT_DID = "did:web:api.bsky.chat";
const CHAT_ENDPOINT = "https://api.bsky.chat";

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
			// Special-case main Bluesky services to use known endpoints instead of fetching
			let didDoc: any;
			if (parsed.did === APPVIEW_DID || parsed.did === CHAT_DID) {
				// Use cached endpoint but still validate service exists
				didDoc = {
					id: parsed.did,
					service: [
						{
							id: "#atproto_appview",
							type: "AtprotoAppView",
							serviceEndpoint:
								parsed.did === APPVIEW_DID ? APPVIEW_ENDPOINT : CHAT_ENDPOINT,
						},
					],
				};
			} else {
				didDoc = await didResolver.resolve(parsed.did);
				if (!didDoc) {
					return c.json(
						{
							error: "InvalidRequest",
							message: `DID not found: ${parsed.did}`,
						},
						400,
					);
				}
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
			// Construct URL safely using URL constructor
			targetUrl = new URL(`/xrpc/${lxm}${url.search}`, endpoint);
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
		const isChat = lxm.startsWith("chat.bsky.");
		const endpoint = isChat ? CHAT_ENDPOINT : APPVIEW_ENDPOINT;
		audienceDid = isChat ? CHAT_DID : APPVIEW_DID;

		// Construct URL safely using URL constructor
		targetUrl = new URL(`/xrpc/${lxm}${url.search}`, endpoint);
	}

	// Check for authorization header
	const auth = c.req.header("Authorization");
	let headers: Record<string, string> = {};

	if (auth?.startsWith("Bearer ")) {
		const token = auth.slice(7);
		const serviceDid = `did:web:${c.env.PDS_HOSTNAME}`;

		// Try to verify the token - if valid, create a service JWT
		try {
			// Check static token first
			let userDid: string;
			if (token === c.env.AUTH_TOKEN) {
				userDid = c.env.DID;
			} else {
				// Verify JWT
				const payload = await verifyAccessToken(
					token,
					c.env.JWT_SECRET,
					serviceDid,
				);
				userDid = payload.sub;
			}

			// Create service JWT for target service
			const keypair = await getKeypair();
			const serviceJwt = await createServiceJwt({
				iss: userDid,
				aud: audienceDid,
				lxm,
				keypair,
			});
			headers["Authorization"] = `Bearer ${serviceJwt}`;
		} catch {
			// Token verification failed - forward without auth
			// Target service will return appropriate error
		}
	}

	// Forward request with potentially replaced auth header
	// Remove headers that shouldn't be forwarded (security/privacy)
	const originalHeaders = Object.fromEntries(c.req.raw.headers);
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
		delete originalHeaders[header];
	}

	const reqInit: RequestInit = {
		method: c.req.method,
		headers: {
			...originalHeaders,
			...headers,
		},
	};

	// Include body for non-GET requests
	if (c.req.method !== "GET" && c.req.method !== "HEAD") {
		reqInit.body = c.req.raw.body;
	}

	return fetch(targetUrl.toString(), reqInit);
}
