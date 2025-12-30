import { describe, it, expect, beforeAll, vi, afterEach } from "vitest";
import { env, worker } from "./helpers";

// Mock DID documents for testing
const mockDidDocuments: Record<string, any> = {
	"did:web:labeler.example.com": {
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
				message: expect.stringContaining("Failed to resolve service"),
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
			vi.stubGlobal(
				"fetch",
				vi.fn((url: string) => {
					if (url === "https://insecure.example.com/.well-known/did.json") {
						return Promise.resolve(
							new Response(
								JSON.stringify({
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
					return originalFetch(url);
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

	describe("Fallback behavior", () => {
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
});
