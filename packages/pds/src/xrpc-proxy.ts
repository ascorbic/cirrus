/**
 * XRPC service proxying with atproto-proxy header support
 * See: https://atproto.com/specs/xrpc#service-proxying
 */

import type { Context } from "hono";
import { DidResolver } from "./did-resolver";
import { getAtprotoServiceEndpoint } from "@atcute/identity";
import { isDid, parseResourceUri } from "@atcute/lexicons/syntax";
import { createServiceJwt } from "./service-auth";
import { ScopeMissingError, permissionsFor } from "@getcirrus/oauth-provider";
import { verifyAccessToken, TokenExpiredError } from "./session";
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
 * Override the service-auth audience and lexicon method stamped into the
 * outbound JWT, independently of where the request is routed. Used for
 * getFeed, where the request is proxied to the AppView but the token must be
 * addressed to the feed generator so it can authorize the user.
 */
export interface ServiceAuthOverride {
	aud: string;
	lxm: string;
}

/**
 * Handle XRPC proxy requests
 * Routes requests to external services based on atproto-proxy header or lexicon namespace
 */
export async function handleXrpcProxy(
	c: Context<{ Bindings: PDSEnv }>,
	didResolver: DidResolver,
	getKeypair: () => Promise<Secp256k1Keypair>,
	serviceAuthOverride?: ServiceAuthOverride,
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
	// Audience used for OAuth scope checks: the full `did#service_id` form, since
	// granular `rpc:` scopes are granted against that (the bare DID never
	// matches). The outbound service-auth JWT uses the bare DID instead.
	let scopeAud: string;
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
			const endpoint = getAtprotoServiceEndpoint(didDoc, {
				id: serviceId as `#${string}`,
			});

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
			scopeAud = proxyHeader;
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
		scopeAud = isChat
			? "did:web:api.bsky.chat#bsky_chat"
			: "did:web:api.bsky.app#bsky_appview";
		const endpoint = isChat ? "https://api.bsky.chat" : "https://api.bsky.app";

		// Construct URL safely using URL constructor
		targetUrl = new URL(`/xrpc/${lxm}${url.search}`, endpoint);
	}

	// The outbound service JWT's audience and method may differ from the
	// request's routing target (see getFeed: routed to the AppView, addressed
	// to the feed generator).
	const serviceAud = serviceAuthOverride?.aud ?? audienceDid;
	const serviceLxm = serviceAuthOverride?.lxm ?? lxm;

	// Verify auth and create service JWT for target service
	let headers: Record<string, string> = {};
	const auth = c.req.header("Authorization");
	let userDid: string | undefined;

	if (auth?.startsWith("DPoP ")) {
		// Verify DPoP-bound OAuth access token. If the token is structurally
		// valid we then assert it carries an `rpc:` scope matching the lxm and
		// audience we're about to vouch for — otherwise a token granted for
		// one method could be replayed against another via the proxy.
		try {
			const provider = getProvider(c.env);
			const tokenData = await provider.verifyAccessToken(c.req.raw);
			if (tokenData) {
				// Scope is asserted against the routing audience (where the client
				// directed the request), not the override aud on the outbound JWT.
				// For getFeed that means getFeed + getFeedSkeleton at the AppView,
				// matching the reference PDS.
				const requiredLxms = serviceLxm === lxm ? [lxm] : [lxm, serviceLxm];
				try {
					const permissions = permissionsFor(tokenData.scope);
					for (const requiredLxm of requiredLxms) {
						permissions.assertRpc({ lxm: requiredLxm, aud: scopeAud });
					}
					userDid = tokenData.sub;
				} catch (err) {
					if (err instanceof ScopeMissingError) {
						return c.json(
							{
								error: "InsufficientScope",
								message: `Token does not grant rpc for ${requiredLxms.join(", ")} at aud=${scopeAud}`,
							},
							403,
						);
					}
					throw err;
				}
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
		} catch (err) {
			// Match official PDS: expired tokens return 400 with 'ExpiredToken'
			// This is required for clients to trigger automatic token refresh
			if (err instanceof TokenExpiredError) {
				return c.json(
					{
						error: "ExpiredToken",
						message: err.message,
					},
					400,
				);
			}
			// Other token verification errors - continue without auth
		}
	}

	// Create service JWT if user is authenticated
	if (userDid) {
		try {
			const keypair = await getKeypair();
			const serviceJwt = await createServiceJwt({
				iss: userDid,
				aud: serviceAud,
				lxm: serviceLxm,
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

/**
 * Resolve the service DID a feed generator runs on, given a feed AT-URI.
 * The feed record lives in the creator's repo and carries a `did` field
 * pointing at the feedgen service (e.g. did:web:foryou.club). Returns null if
 * the feed cannot be resolved, so callers can fall back to default proxying.
 */
async function resolveFeedGenDid(
	feed: string,
	didResolver: DidResolver,
): Promise<string | null> {
	const parsed = parseResourceUri(feed);
	if (!parsed.ok) return null;

	const { repo, collection, rkey } = parsed.value;
	if (collection !== "app.bsky.feed.generator" || !rkey) return null;
	if (!isDid(repo)) return null;

	const didDoc = await didResolver.resolve(repo);
	if (!didDoc) return null;

	const pds = getAtprotoServiceEndpoint(didDoc, {
		id: "#atproto_pds",
		type: "AtprotoPersonalDataServer",
	});
	if (!pds) return null;

	// The endpoint comes from a third-party DID document; only fetch over HTTPS,
	// matching the proxy-target restriction in handleXrpcProxy.
	let recordUrl: URL;
	try {
		recordUrl = new URL("/xrpc/com.atproto.repo.getRecord", pds);
	} catch {
		return null;
	}
	if (recordUrl.protocol !== "https:") return null;

	recordUrl.searchParams.set("repo", repo);
	recordUrl.searchParams.set("collection", collection);
	recordUrl.searchParams.set("rkey", rkey);

	const res = await fetch(recordUrl, { redirect: "manual" });
	if (res.status >= 300 && res.status < 400) return null;
	if (!res.ok) return null;

	const body = (await res.json()) as { value?: { did?: unknown } };
	const feedDid = body.value?.did;
	return typeof feedDid === "string" && isDid(feedDid) ? feedDid : null;
}

/**
 * Proxy app.bsky.feed.getFeed.
 *
 * getFeed is routed to the AppView like any other read, but the service-auth
 * JWT must be addressed to the feed generator (aud = feedgen DID, lxm =
 * getFeedSkeleton) so the generator can authorize the user and record
 * per-user state. Without this, generators that validate the audience reject
 * the token and operate in a degraded, stateless mode. If the feed can't be
 * resolved we fall back to default proxying so the feed still loads.
 */
export async function handleGetFeedProxy(
	c: Context<{ Bindings: PDSEnv }>,
	didResolver: DidResolver,
	getKeypair: () => Promise<Secp256k1Keypair>,
): Promise<Response> {
	const feed = c.req.query("feed");

	let override: ServiceAuthOverride | undefined;
	if (feed) {
		try {
			const feedDid = await resolveFeedGenDid(feed, didResolver);
			if (feedDid) {
				override = { aud: feedDid, lxm: "app.bsky.feed.getFeedSkeleton" };
			}
		} catch {
			// Fall back to default proxying when feed resolution fails.
		}
	}

	return handleXrpcProxy(c, didResolver, getKeypair, override);
}
