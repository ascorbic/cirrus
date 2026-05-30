import { describe, it, expect, beforeAll, vi, afterEach } from "vitest";
import { base64url, calculateJwkThumbprint, SignJWT } from "jose";
import { env, runInDurableObject, worker } from "./helpers";
import type { AccountDurableObject } from "../src/account-do";

// Mock DID documents for testing
// Note: @context is required by @atcute/identity-resolver validation
const mockDidDocuments: Record<string, any> = {
	"did:web:labeler.example.com": {
		"@context": ["https://www.w3.org/ns/did/v1"],
		id: "did:web:labeler.example.com",
		service: [
			{
				id: "#atproto_labeler",
				type: "AtprotoLabeler",
				serviceEndpoint: "https://labeler.example.com",
			},
		],
	},
	"did:web:api.bsky.app": {
		"@context": ["https://www.w3.org/ns/did/v1"],
		id: "did:web:api.bsky.app",
		service: [
			{
				id: "#atproto_appview",
				type: "AtprotoAppView",
				serviceEndpoint: "https://api.bsky.app",
			},
		],
	},
};

describe("XRPC Service Proxying", () => {
	let authToken: string;
	let originalFetch: typeof fetch;

	beforeAll(async () => {
		// Get auth token for tests that need authentication
		authToken = env.AUTH_TOKEN;

		// Save original fetch
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		// Restore original fetch after each test
		globalThis.fetch = originalFetch;
		vi.unstubAllGlobals();
	});

	describe("atproto-proxy header", () => {
		it("should reject invalid proxy header format", async () => {
			const response = await worker.fetch(
				new Request(
					"http://pds.test/xrpc/app.bsky.feed.getAuthorFeed?actor=test.bsky.social",
					{
						headers: {
							"atproto-proxy": "invalid-format",
						},
					},
				),
				env,
			);

			expect(response.status).toBe(400);
			const data = await response.json();
			expect(data).toMatchObject({
				error: "InvalidRequest",
				message: expect.stringContaining("Invalid atproto-proxy header"),
			});
		});

		it("should reject proxy header without service ID", async () => {
			const response = await worker.fetch(
				new Request(
					"http://pds.test/xrpc/app.bsky.feed.getAuthorFeed?actor=test.bsky.social",
					{
						headers: {
							"atproto-proxy": "did:web:example.com",
						},
					},
				),
				env,
			);

			expect(response.status).toBe(400);
			const data = await response.json();
			expect(data).toMatchObject({
				error: "InvalidRequest",
				message: expect.stringContaining("Invalid atproto-proxy header"),
			});
		});

		it("should handle DID resolution failure gracefully", async () => {
			// Mock fetch to simulate DID resolution failure
			vi.stubGlobal(
				"fetch",
				vi.fn((url: string) => {
					if (
						url ===
						"https://nonexistent-domain-12345.invalid/.well-known/did.json"
					) {
						return Promise.reject(new Error("DNS lookup failed"));
					}
					return originalFetch(url);
				}),
			);

			const response = await worker.fetch(
				new Request(
					"http://pds.test/xrpc/app.bsky.feed.getAuthorFeed?actor=test.bsky.social",
					{
						headers: {
							"atproto-proxy":
								"did:web:nonexistent-domain-12345.invalid#atproto_labeler",
						},
					},
				),
				env,
			);

			expect(response.status).toBe(400);
			const data = await response.json();
			expect(data).toMatchObject({
				error: "InvalidRequest",
				message: expect.stringContaining("DID not found"),
			});
		});

		it("should reject when service not found in DID document", async () => {
			// Mock fetch to return DID document without the requested service
			vi.stubGlobal(
				"fetch",
				vi.fn((url: string) => {
					if (url === "https://api.bsky.app/.well-known/did.json") {
						return Promise.resolve(
							new Response(
								JSON.stringify(mockDidDocuments["did:web:api.bsky.app"]),
								{
									status: 200,
									headers: { "Content-Type": "application/json" },
								},
							),
						);
					}
					return originalFetch(url);
				}),
			);

			const response = await worker.fetch(
				new Request(
					"http://pds.test/xrpc/app.bsky.feed.getAuthorFeed?actor=test.bsky.social",
					{
						headers: {
							"atproto-proxy": "did:web:api.bsky.app#nonexistent_service",
						},
					},
				),
				env,
			);

			expect(response.status).toBe(400);
			const data = await response.json();
			expect(data).toMatchObject({
				error: "InvalidRequest",
				message: expect.stringContaining("Service not found in DID document"),
			});
		});

		it("should reject non-HTTPS service endpoints", async () => {
			// Mock DID document with HTTP endpoint
			// Note: @atcute/identity-resolver passes URL objects, not strings
			vi.stubGlobal(
				"fetch",
				vi.fn((url: string | URL) => {
					const urlStr = url.toString();
					if (urlStr === "https://insecure.example.com/.well-known/did.json") {
						return Promise.resolve(
							new Response(
								JSON.stringify({
									"@context": ["https://www.w3.org/ns/did/v1"],
									id: "did:web:insecure.example.com",
									service: [
										{
											id: "#atproto_pds",
											type: "AtprotoPersonalDataServer",
											serviceEndpoint: "http://insecure.example.com", // HTTP, not HTTPS
										},
									],
								}),
								{
									status: 200,
									headers: { "Content-Type": "application/json" },
								},
							),
						);
					}
					return originalFetch(urlStr);
				}),
			);

			const response = await worker.fetch(
				new Request(
					"http://pds.test/xrpc/app.bsky.feed.getAuthorFeed?actor=test",
					{
						headers: {
							"atproto-proxy": "did:web:insecure.example.com#atproto_pds",
						},
					},
				),
				env,
			);

			expect(response.status).toBe(400);
			const data = await response.json();
			expect(data).toMatchObject({
				error: "InvalidRequest",
				message: "Proxy target must use HTTPS",
			});
		});

		it("should successfully proxy with valid atproto-proxy header", async () => {
			// Mock fetch for both DID resolution and the proxied request
			vi.stubGlobal(
				"fetch",
				vi.fn((url: string | URL, init?: RequestInit) => {
					const urlStr = url.toString();
					if (urlStr === "https://labeler.example.com/.well-known/did.json") {
						return Promise.resolve(
							new Response(
								JSON.stringify(mockDidDocuments["did:web:labeler.example.com"]),
								{
									status: 200,
									headers: { "Content-Type": "application/json" },
								},
							),
						);
					}
					if (urlStr.startsWith("https://labeler.example.com/xrpc/")) {
						// Verify the service JWT was added
						const headers = new Headers(init?.headers);
						const authHeader = headers.get("Authorization");
						expect(authHeader).toMatch(/^Bearer /);

						return Promise.resolve(
							new Response(JSON.stringify({ success: true }), {
								status: 200,
								headers: { "Content-Type": "application/json" },
							}),
						);
					}
					return originalFetch(url, init);
				}),
			);

			const response = await worker.fetch(
				new Request(
					"http://pds.test/xrpc/app.bsky.feed.getAuthorFeed?actor=test.bsky.social",
					{
						headers: {
							"atproto-proxy": "did:web:labeler.example.com#atproto_labeler",
							Authorization: `Bearer ${authToken}`,
						},
					},
				),
				env,
			);

			expect(response.status).toBe(200);
			const data = await response.json();
			expect(data).toEqual({ success: true });
		});
	});

	describe("getFeed service auth", () => {
		const feedUri =
			"at://did:web:creator.example.com/app.bsky.feed.generator/for-you";

		const appviewDidDoc = {
			"@context": ["https://www.w3.org/ns/did/v1"],
			id: "did:web:appview.example.com",
			service: [
				{
					id: "#bsky_appview",
					type: "BskyAppView",
					serviceEndpoint: "https://appview.example.com",
				},
			],
		};

		function decodeJwtPayload(authHeader: string | null): any {
			expect(authHeader).toMatch(/^Bearer /);
			const payloadB64 = authHeader!.slice(7).split(".")[1]!;
			return JSON.parse(Buffer.from(payloadB64, "base64url").toString());
		}

		it("mints the service JWT with aud of the feed generator, not the appview", async () => {
			let capturedAuth: string | null = null;

			vi.stubGlobal(
				"fetch",
				vi.fn((url: string | URL, init?: RequestInit) => {
					const u = url.toString();
					if (u === "https://creator.example.com/.well-known/did.json") {
						return Promise.resolve(
							new Response(
								JSON.stringify({
									"@context": ["https://www.w3.org/ns/did/v1"],
									id: "did:web:creator.example.com",
									service: [
										{
											id: "#atproto_pds",
											type: "AtprotoPersonalDataServer",
											serviceEndpoint: "https://creator-pds.example.com",
										},
									],
								}),
								{
									status: 200,
									headers: { "Content-Type": "application/json" },
								},
							),
						);
					}
					if (
						u.startsWith(
							"https://creator-pds.example.com/xrpc/com.atproto.repo.getRecord",
						)
					) {
						return Promise.resolve(
							new Response(
								JSON.stringify({
									uri: feedUri,
									value: {
										$type: "app.bsky.feed.generator",
										did: "did:web:feedgen.example.com",
									},
								}),
								{
									status: 200,
									headers: { "Content-Type": "application/json" },
								},
							),
						);
					}
					if (u === "https://appview.example.com/.well-known/did.json") {
						return Promise.resolve(
							new Response(JSON.stringify(appviewDidDoc), {
								status: 200,
								headers: { "Content-Type": "application/json" },
							}),
						);
					}
					if (
						u.startsWith(
							"https://appview.example.com/xrpc/app.bsky.feed.getFeed",
						)
					) {
						capturedAuth = new Headers(init?.headers).get("Authorization");
						return Promise.resolve(
							new Response(JSON.stringify({ feed: [] }), {
								status: 200,
								headers: { "Content-Type": "application/json" },
							}),
						);
					}
					return originalFetch(url, init);
				}),
			);

			const response = await worker.fetch(
				new Request(
					`http://pds.test/xrpc/app.bsky.feed.getFeed?feed=${encodeURIComponent(feedUri)}&limit=30`,
					{
						headers: {
							"atproto-proxy": "did:web:appview.example.com#bsky_appview",
							Authorization: `Bearer ${authToken}`,
						},
					},
				),
				env,
			);

			expect(response.status).toBe(200);
			const payload = decodeJwtPayload(capturedAuth);
			expect(payload.aud).toBe("did:web:feedgen.example.com");
			expect(payload.lxm).toBe("app.bsky.feed.getFeedSkeleton");
		});

		it("falls back to the appview aud when the feed record cannot be resolved", async () => {
			let capturedAuth: string | null = null;

			vi.stubGlobal(
				"fetch",
				vi.fn((url: string | URL, init?: RequestInit) => {
					const u = url.toString();
					if (u === "https://creator.example.com/.well-known/did.json") {
						return Promise.resolve(
							new Response(JSON.stringify({ error: "NotFound" }), {
								status: 404,
								headers: { "Content-Type": "application/json" },
							}),
						);
					}
					if (u === "https://appview.example.com/.well-known/did.json") {
						return Promise.resolve(
							new Response(JSON.stringify(appviewDidDoc), {
								status: 200,
								headers: { "Content-Type": "application/json" },
							}),
						);
					}
					if (
						u.startsWith(
							"https://appview.example.com/xrpc/app.bsky.feed.getFeed",
						)
					) {
						capturedAuth = new Headers(init?.headers).get("Authorization");
						return Promise.resolve(
							new Response(JSON.stringify({ feed: [] }), {
								status: 200,
								headers: { "Content-Type": "application/json" },
							}),
						);
					}
					return originalFetch(url, init);
				}),
			);

			const response = await worker.fetch(
				new Request(
					`http://pds.test/xrpc/app.bsky.feed.getFeed?feed=${encodeURIComponent(feedUri)}&limit=30`,
					{
						headers: {
							"atproto-proxy": "did:web:appview.example.com#bsky_appview",
							Authorization: `Bearer ${authToken}`,
						},
					},
				),
				env,
			);

			expect(response.status).toBe(200);
			const payload = decodeJwtPayload(capturedAuth);
			expect(payload.aud).toBe("did:web:appview.example.com");
			expect(payload.lxm).toBe("app.bsky.feed.getFeed");
		});

		it("does not resolve the feed over a non-HTTPS creator PDS endpoint", async () => {
			let capturedAuth: string | null = null;
			let recordFetched = false;

			vi.stubGlobal(
				"fetch",
				vi.fn((url: string | URL, init?: RequestInit) => {
					const u = url.toString();
					if (u === "https://creator.example.com/.well-known/did.json") {
						return Promise.resolve(
							new Response(
								JSON.stringify({
									"@context": ["https://www.w3.org/ns/did/v1"],
									id: "did:web:creator.example.com",
									service: [
										{
											id: "#atproto_pds",
											type: "AtprotoPersonalDataServer",
											serviceEndpoint: "http://creator-pds.example.com",
										},
									],
								}),
								{
									status: 200,
									headers: { "Content-Type": "application/json" },
								},
							),
						);
					}
					if (u.startsWith("http://creator-pds.example.com")) {
						recordFetched = true;
						return Promise.resolve(
							new Response(
								JSON.stringify({
									value: { did: "did:web:feedgen.example.com" },
								}),
								{
									status: 200,
									headers: { "Content-Type": "application/json" },
								},
							),
						);
					}
					if (u === "https://appview.example.com/.well-known/did.json") {
						return Promise.resolve(
							new Response(JSON.stringify(appviewDidDoc), {
								status: 200,
								headers: { "Content-Type": "application/json" },
							}),
						);
					}
					if (
						u.startsWith(
							"https://appview.example.com/xrpc/app.bsky.feed.getFeed",
						)
					) {
						capturedAuth = new Headers(init?.headers).get("Authorization");
						return Promise.resolve(
							new Response(JSON.stringify({ feed: [] }), {
								status: 200,
								headers: { "Content-Type": "application/json" },
							}),
						);
					}
					return originalFetch(url, init);
				}),
			);

			const response = await worker.fetch(
				new Request(
					`http://pds.test/xrpc/app.bsky.feed.getFeed?feed=${encodeURIComponent(feedUri)}&limit=30`,
					{
						headers: {
							"atproto-proxy": "did:web:appview.example.com#bsky_appview",
							Authorization: `Bearer ${authToken}`,
						},
					},
				),
				env,
			);

			expect(response.status).toBe(200);
			expect(recordFetched).toBe(false);
			const payload = decodeJwtPayload(capturedAuth);
			expect(payload.aud).toBe("did:web:appview.example.com");
		});
	});

	describe("Fallback behavior", () => {
		it("should proxy getRecord with foreign DID to AppView", async () => {
			vi.stubGlobal(
				"fetch",
				vi.fn((url: string) => {
					if (url.includes("api.bsky.app")) {
						return Promise.resolve(
							new Response(
								JSON.stringify({
									uri: "at://did:plc:foreign/app.bsky.feed.post/abc123",
									cid: "bafyreiabc123",
									value: { text: "test post" },
								}),
								{
									status: 200,
									headers: { "Content-Type": "application/json" },
								},
							),
						);
					}
					return originalFetch(url);
				}),
			);

			const response = await worker.fetch(
				new Request(
					"http://pds.test/xrpc/com.atproto.repo.getRecord?repo=did:plc:foreign&collection=app.bsky.feed.post&rkey=abc123",
				),
				env,
			);

			expect(response.status).toBe(200);
			const data = await response.json();
			expect(data).toMatchObject({
				uri: "at://did:plc:foreign/app.bsky.feed.post/abc123",
				value: { text: "test post" },
			});
		});

		it("should proxy listRecords with foreign DID to AppView", async () => {
			vi.stubGlobal(
				"fetch",
				vi.fn((url: string) => {
					if (url.includes("api.bsky.app")) {
						return Promise.resolve(
							new Response(
								JSON.stringify({
									records: [
										{
											uri: "at://did:plc:foreign/app.bsky.feed.post/abc123",
											cid: "bafyreiabc123",
											value: { text: "test post" },
										},
									],
								}),
								{
									status: 200,
									headers: { "Content-Type": "application/json" },
								},
							),
						);
					}
					return originalFetch(url);
				}),
			);

			const response = await worker.fetch(
				new Request(
					"http://pds.test/xrpc/com.atproto.repo.listRecords?repo=did:plc:foreign&collection=app.bsky.feed.post",
				),
				env,
			);

			expect(response.status).toBe(200);
			const data = await response.json();
			expect(data.records).toHaveLength(1);
			expect(data.records[0].uri).toBe(
				"at://did:plc:foreign/app.bsky.feed.post/abc123",
			);
		});

		it("should proxy describeRepo with foreign DID to AppView", async () => {
			vi.stubGlobal(
				"fetch",
				vi.fn((url: string) => {
					if (url.includes("api.bsky.app")) {
						return Promise.resolve(
							new Response(
								JSON.stringify({
									handle: "foreign.bsky.social",
									did: "did:plc:foreign",
									collections: ["app.bsky.feed.post"],
								}),
								{
									status: 200,
									headers: { "Content-Type": "application/json" },
								},
							),
						);
					}
					return originalFetch(url);
				}),
			);

			const response = await worker.fetch(
				new Request(
					"http://pds.test/xrpc/com.atproto.repo.describeRepo?repo=did:plc:foreign",
				),
				env,
			);

			expect(response.status).toBe(200);
			const data = await response.json();
			expect(data.did).toBe("did:plc:foreign");
			expect(data.handle).toBe("foreign.bsky.social");
		});

		it("should proxy to Bluesky AppView when no proxy header present", async () => {
			// Mock fetch to verify request goes to api.bsky.app
			vi.stubGlobal(
				"fetch",
				vi.fn((url: string) => {
					if (url.includes("api.bsky.app")) {
						return Promise.resolve(
							new Response(JSON.stringify({ proxied: true }), {
								status: 200,
								headers: { "Content-Type": "application/json" },
							}),
						);
					}
					return originalFetch(url);
				}),
			);

			const response = await worker.fetch(
				new Request(
					"http://pds.test/xrpc/app.bsky.actor.getProfile?actor=test.bsky.social",
				),
				env,
			);

			expect(response.status).toBe(200);
			const data = await response.json();
			expect(data).toEqual({ proxied: true });
		});

		it("should proxy chat methods to api.bsky.chat", async () => {
			// Mock fetch to verify request goes to api.bsky.chat
			vi.stubGlobal(
				"fetch",
				vi.fn((url: string) => {
					if (url.includes("api.bsky.chat")) {
						return Promise.resolve(
							new Response(JSON.stringify({ chat: true }), {
								status: 200,
								headers: { "Content-Type": "application/json" },
							}),
						);
					}
					return originalFetch(url);
				}),
			);

			const response = await worker.fetch(
				new Request(
					"http://pds.test/xrpc/chat.bsky.convo.getConvo?convoId=123",
					{
						headers: {
							Authorization: `Bearer ${authToken}`,
						},
					},
				),
				env,
			);

			expect(response.status).toBe(200);
			const data = await response.json();
			expect(data).toEqual({ chat: true });
		});

		it("should forward Authorization header as service JWT", async () => {
			let capturedAuthHeader: string | null = null;

			// Mock fetch to capture the Authorization header
			vi.stubGlobal(
				"fetch",
				vi.fn((url: string, init?: RequestInit) => {
					if (url.includes("api.bsky.app")) {
						// Headers can be a Headers object, array, or plain object
						const headers = new Headers(init?.headers);
						capturedAuthHeader = headers.get("Authorization");
						return Promise.resolve(
							new Response(JSON.stringify({ ok: true }), {
								status: 200,
								headers: { "Content-Type": "application/json" },
							}),
						);
					}
					return originalFetch(url, init);
				}),
			);

			const response = await worker.fetch(
				new Request(
					"http://pds.test/xrpc/app.bsky.actor.getProfile?actor=test.bsky.social",
					{
						headers: {
							Authorization: `Bearer ${authToken}`,
						},
					},
				),
				env,
			);

			expect(response.status).toBe(200);
			// Verify service JWT was created and forwarded
			expect(capturedAuthHeader).toMatch(/^Bearer /);
			// The forwarded token should be different from the original (it's a service JWT)
			expect(capturedAuthHeader).not.toBe(`Bearer ${authToken}`);
		});
	});

	describe("getFeed OAuth/DPoP scope check", () => {
		const feedUri =
			"at://did:web:creator.example.com/app.bsky.feed.generator/for-you";
		const proxyHeader = "did:web:appview.example.com#bsky_appview";

		const appviewDidDoc = {
			"@context": ["https://www.w3.org/ns/did/v1"],
			id: "did:web:appview.example.com",
			service: [
				{
					id: "#bsky_appview",
					type: "BskyAppView",
					serviceEndpoint: "https://appview.example.com",
				},
			],
		};

		async function generateEs256() {
			const kp = (await crypto.subtle.generateKey(
				{ name: "ECDSA", namedCurve: "P-256" },
				true,
				["sign", "verify"],
			)) as CryptoKeyPair;
			const publicJwk = (await crypto.subtle.exportKey(
				"jwk",
				kp.publicKey,
			)) as JsonWebKey;
			delete publicJwk.key_ops;
			delete publicJwk.ext;
			return { privateKey: kp.privateKey, publicJwk };
		}

		async function makeDpopProof(
			privateKey: CryptoKey,
			publicJwk: JsonWebKey,
			accessToken: string,
			requestUrl: string,
		): Promise<string> {
			const u = new URL(requestUrl);
			const ath = base64url.encode(
				new Uint8Array(
					await crypto.subtle.digest(
						"SHA-256",
						new TextEncoder().encode(accessToken),
					),
				),
			);
			return new SignJWT({ htm: "GET", htu: u.origin + u.pathname, ath })
				.setProtectedHeader({
					typ: "dpop+jwt",
					alg: "ES256",
					jwk: publicJwk as Record<string, unknown>,
				})
				.setIssuedAt()
				.setJti(base64url.encode(crypto.getRandomValues(new Uint8Array(16))))
				.sign(privateKey);
		}

		async function storeToken(
			accessToken: string,
			scope: string,
			dpopJkt: string,
		): Promise<void> {
			const stub = env.ACCOUNT.get(env.ACCOUNT.idFromName("account"));
			await runInDurableObject(stub, async (instance: AccountDurableObject) => {
				await instance.rpcSaveTokens({
					accessToken,
					refreshToken: `refresh-${accessToken}`,
					clientId: "did:web:client.example.com",
					sub: env.DID,
					scope,
					dpopJkt,
					issuedAt: Date.now(),
					accessExpiresAt: Date.now() + 3600_000,
					refreshExpiresAt: Date.now() + 90 * 24 * 3600_000,
				});
			});
		}

		function stubFeedFetch(capture: { auth: string | null }): void {
			vi.stubGlobal(
				"fetch",
				vi.fn((url: string | URL, init?: RequestInit) => {
					const u = url.toString();
					if (u === "https://creator.example.com/.well-known/did.json") {
						return Promise.resolve(
							new Response(
								JSON.stringify({
									"@context": ["https://www.w3.org/ns/did/v1"],
									id: "did:web:creator.example.com",
									service: [
										{
											id: "#atproto_pds",
											type: "AtprotoPersonalDataServer",
											serviceEndpoint: "https://creator-pds.example.com",
										},
									],
								}),
								{
									status: 200,
									headers: { "Content-Type": "application/json" },
								},
							),
						);
					}
					if (
						u.startsWith(
							"https://creator-pds.example.com/xrpc/com.atproto.repo.getRecord",
						)
					) {
						return Promise.resolve(
							new Response(
								JSON.stringify({
									value: { did: "did:web:feedgen.example.com" },
								}),
								{
									status: 200,
									headers: { "Content-Type": "application/json" },
								},
							),
						);
					}
					if (u === "https://appview.example.com/.well-known/did.json") {
						return Promise.resolve(
							new Response(JSON.stringify(appviewDidDoc), {
								status: 200,
								headers: { "Content-Type": "application/json" },
							}),
						);
					}
					if (
						u.startsWith(
							"https://appview.example.com/xrpc/app.bsky.feed.getFeed",
						)
					) {
						capture.auth = new Headers(init?.headers).get("Authorization");
						return Promise.resolve(
							new Response(JSON.stringify({ feed: [] }), {
								status: 200,
								headers: { "Content-Type": "application/json" },
							}),
						);
					}
					return originalFetch(url, init);
				}),
			);
		}

		async function getFeedRequest(
			accessToken: string,
			privateKey: CryptoKey,
			publicJwk: JsonWebKey,
		): Promise<Response> {
			const requestUrl = `http://pds.test/xrpc/app.bsky.feed.getFeed?feed=${encodeURIComponent(feedUri)}&limit=30`;
			const dpop = await makeDpopProof(
				privateKey,
				publicJwk,
				accessToken,
				requestUrl,
			);
			return worker.fetch(
				new Request(requestUrl, {
					headers: {
						"atproto-proxy": proxyHeader,
						Authorization: `DPoP ${accessToken}`,
						DPoP: dpop,
					},
				}),
				env,
			);
		}

		it("accepts a token scoped for the AppView audience and addresses the JWT to the feedgen", async () => {
			const { privateKey, publicJwk } = await generateEs256();
			const dpopJkt = await calculateJwkThumbprint(
				publicJwk as Parameters<typeof calculateJwkThumbprint>[0],
				"sha256",
			);
			const accessToken = "tok-getfeed-valid";
			await storeToken(
				accessToken,
				`atproto rpc:app.bsky.feed.getFeed?aud=${proxyHeader} rpc:app.bsky.feed.getFeedSkeleton?aud=${proxyHeader}`,
				dpopJkt,
			);

			const capture: { auth: string | null } = { auth: null };
			stubFeedFetch(capture);

			const response = await getFeedRequest(accessToken, privateKey, publicJwk);

			expect(response.status).toBe(200);
			expect(capture.auth).toMatch(/^Bearer /);
			const payload = JSON.parse(
				Buffer.from(
					capture.auth!.slice(7).split(".")[1]!,
					"base64url",
				).toString(),
			);
			expect(payload.aud).toBe("did:web:feedgen.example.com");
			expect(payload.lxm).toBe("app.bsky.feed.getFeedSkeleton");
		});

		it("rejects a token scoped only for a different audience", async () => {
			const { privateKey, publicJwk } = await generateEs256();
			const dpopJkt = await calculateJwkThumbprint(
				publicJwk as Parameters<typeof calculateJwkThumbprint>[0],
				"sha256",
			);
			const accessToken = "tok-getfeed-wrong-aud";
			const otherAud = "did:web:other.example.com#bsky_appview";
			await storeToken(
				accessToken,
				`atproto rpc:app.bsky.feed.getFeed?aud=${otherAud} rpc:app.bsky.feed.getFeedSkeleton?aud=${otherAud}`,
				dpopJkt,
			);

			const capture: { auth: string | null } = { auth: null };
			stubFeedFetch(capture);

			const response = await getFeedRequest(accessToken, privateKey, publicJwk);

			expect(response.status).toBe(403);
			expect(capture.auth).toBeNull();
			const body = (await response.json()) as { error: string };
			expect(body.error).toBe("InsufficientScope");
		});
	});
});
