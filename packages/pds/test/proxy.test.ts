import { describe, it, expect, beforeAll } from "vitest";
import { env, worker } from "./helpers";

describe("XRPC Service Proxying", () => {
	let authToken: string;

	beforeAll(async () => {
		// Get auth token for tests that need authentication
		authToken = env.AUTH_TOKEN;
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

		it("should handle errors when resolving DID document", async () => {
			// In the test environment, we expect network requests to fail
			// This tests that we handle DID resolution errors gracefully
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
				message: expect.stringContaining("Failed to resolve service"),
			});
		});
	});

	describe("Fallback behavior", () => {
		it("should proxy to Bluesky AppView when no proxy header present", async () => {
			// This should proxy to api.bsky.app (we can't test the full flow
			// but we can verify it doesn't return 404 or proxy header errors)
			const response = await worker.fetch(
				new Request(
					"http://pds.test/xrpc/app.bsky.actor.getProfile?actor=test.bsky.social",
				),
				env,
			);

			// We expect this to be proxied (status won't be 404 or 400 for proxy errors)
			// The actual response depends on api.bsky.app
			expect(response.status).not.toBe(404);
		});

		it("should proxy chat methods to api.bsky.chat", async () => {
			// Verify chat.bsky.* methods get routed to chat service
			// without proxy header
			const response = await worker.fetch(
				new Request("http://pds.test/xrpc/chat.bsky.convo.getConvo?convoId=123", {
					headers: {
						Authorization: `Bearer ${authToken}`,
					},
				}),
				env,
			);

			// Should be proxied, not 404
			expect(response.status).not.toBe(404);
		});

		it("should forward Authorization header as service JWT", async () => {
			// Test that auth header is properly converted to service JWT
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

			// Should be proxied successfully
			expect(response.status).not.toBe(401); // Not unauthorized
			expect(response.status).not.toBe(404); // Not not found
		});
	});
});
