import { describe, it, expect, beforeAll } from "vitest";
import { SELF } from "cloudflare:test";

describe("Session Authentication", () => {
	describe("createSession", () => {
		it("creates session with valid handle and password", async () => {
			const response = await SELF.fetch(
				"https://pds.test/xrpc/com.atproto.server.createSession",
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						identifier: "alice.test",
						password: "test-password",
					}),
				},
			);

			expect(response.status).toBe(200);
			const body = await response.json();
			expect(body.accessJwt).toBeDefined();
			expect(body.refreshJwt).toBeDefined();
			expect(body.did).toBe("did:web:pds.test");
			expect(body.handle).toBe("alice.test");
			expect(body.active).toBe(true);
		});

		it("creates session with valid DID and password", async () => {
			const response = await SELF.fetch(
				"https://pds.test/xrpc/com.atproto.server.createSession",
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						identifier: "did:web:pds.test",
						password: "test-password",
					}),
				},
			);

			expect(response.status).toBe(200);
			const body = await response.json();
			expect(body.accessJwt).toBeDefined();
			expect(body.did).toBe("did:web:pds.test");
		});

		it("rejects invalid password", async () => {
			const response = await SELF.fetch(
				"https://pds.test/xrpc/com.atproto.server.createSession",
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						identifier: "alice.test",
						password: "wrong-password",
					}),
				},
			);

			expect(response.status).toBe(401);
			const body = await response.json();
			expect(body.error).toBe("AuthenticationRequired");
		});

		it("rejects unknown identifier", async () => {
			const response = await SELF.fetch(
				"https://pds.test/xrpc/com.atproto.server.createSession",
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						identifier: "unknown.test",
						password: "test-password",
					}),
				},
			);

			expect(response.status).toBe(401);
		});

		it("rejects missing credentials", async () => {
			const response = await SELF.fetch(
				"https://pds.test/xrpc/com.atproto.server.createSession",
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({}),
				},
			);

			expect(response.status).toBe(400);
		});
	});

	describe("getSession", () => {
		it("returns session info with access token", async () => {
			// First login
			const loginRes = await SELF.fetch(
				"https://pds.test/xrpc/com.atproto.server.createSession",
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						identifier: "alice.test",
						password: "test-password",
					}),
				},
			);
			const { accessJwt } = (await loginRes.json()) as { accessJwt: string };

			// Get session
			const response = await SELF.fetch(
				"https://pds.test/xrpc/com.atproto.server.getSession",
				{
					headers: { Authorization: `Bearer ${accessJwt}` },
				},
			);

			expect(response.status).toBe(200);
			const body = await response.json();
			expect(body.did).toBe("did:web:pds.test");
			expect(body.handle).toBe("alice.test");
			expect(body.active).toBe(true);
		});

		it("returns session info with static token", async () => {
			const response = await SELF.fetch(
				"https://pds.test/xrpc/com.atproto.server.getSession",
				{
					headers: { Authorization: "Bearer test-token" },
				},
			);

			expect(response.status).toBe(200);
			const body = await response.json();
			expect(body.did).toBe("did:web:pds.test");
		});

		it("rejects invalid token", async () => {
			const response = await SELF.fetch(
				"https://pds.test/xrpc/com.atproto.server.getSession",
				{
					headers: { Authorization: "Bearer invalid-token" },
				},
			);

			expect(response.status).toBe(401);
		});

		it("rejects missing token", async () => {
			const response = await SELF.fetch(
				"https://pds.test/xrpc/com.atproto.server.getSession",
			);

			expect(response.status).toBe(401);
		});
	});

	describe("refreshSession", () => {
		it("refreshes session with valid refresh token", async () => {
			// First login
			const loginRes = await SELF.fetch(
				"https://pds.test/xrpc/com.atproto.server.createSession",
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						identifier: "alice.test",
						password: "test-password",
					}),
				},
			);
			const { refreshJwt } = (await loginRes.json()) as { refreshJwt: string };

			// Refresh session
			const response = await SELF.fetch(
				"https://pds.test/xrpc/com.atproto.server.refreshSession",
				{
					method: "POST",
					headers: { Authorization: `Bearer ${refreshJwt}` },
				},
			);

			expect(response.status).toBe(200);
			const body = await response.json();
			expect(body.accessJwt).toBeDefined();
			expect(body.refreshJwt).toBeDefined();
			expect(body.did).toBe("did:web:pds.test");
			expect(body.handle).toBe("alice.test");
		});

		it("rejects access token for refresh", async () => {
			// First login
			const loginRes = await SELF.fetch(
				"https://pds.test/xrpc/com.atproto.server.createSession",
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						identifier: "alice.test",
						password: "test-password",
					}),
				},
			);
			const { accessJwt } = (await loginRes.json()) as { accessJwt: string };

			// Try to refresh with access token (should fail)
			const response = await SELF.fetch(
				"https://pds.test/xrpc/com.atproto.server.refreshSession",
				{
					method: "POST",
					headers: { Authorization: `Bearer ${accessJwt}` },
				},
			);

			expect(response.status).toBe(400);
		});

		it("rejects missing token", async () => {
			const response = await SELF.fetch(
				"https://pds.test/xrpc/com.atproto.server.refreshSession",
				{
					method: "POST",
				},
			);

			expect(response.status).toBe(401);
		});
	});

	describe("deleteSession", () => {
		it("returns success", async () => {
			const response = await SELF.fetch(
				"https://pds.test/xrpc/com.atproto.server.deleteSession",
				{
					method: "POST",
				},
			);

			expect(response.status).toBe(200);
			const body = await response.json();
			expect(body).toEqual({});
		});
	});

	describe("authenticated requests", () => {
		it("accepts access token for write operations", async () => {
			// First login
			const loginRes = await SELF.fetch(
				"https://pds.test/xrpc/com.atproto.server.createSession",
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						identifier: "alice.test",
						password: "test-password",
					}),
				},
			);
			const { accessJwt } = (await loginRes.json()) as { accessJwt: string };

			// Create record with access token
			const response = await SELF.fetch(
				"https://pds.test/xrpc/com.atproto.repo.createRecord",
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${accessJwt}`,
					},
					body: JSON.stringify({
						repo: "did:web:pds.test",
						collection: "app.bsky.feed.post",
						record: {
							$type: "app.bsky.feed.post",
							text: "Hello from session auth!",
							createdAt: new Date().toISOString(),
						},
					}),
				},
			);

			expect(response.status).toBe(200);
			const body = await response.json();
			expect(body.uri).toMatch(/^at:\/\//);
		});

		it("rejects refresh token for write operations", async () => {
			// First login
			const loginRes = await SELF.fetch(
				"https://pds.test/xrpc/com.atproto.server.createSession",
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						identifier: "alice.test",
						password: "test-password",
					}),
				},
			);
			const { refreshJwt } = (await loginRes.json()) as { refreshJwt: string };

			// Try to create record with refresh token (should fail)
			const response = await SELF.fetch(
				"https://pds.test/xrpc/com.atproto.repo.createRecord",
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${refreshJwt}`,
					},
					body: JSON.stringify({
						repo: "did:web:pds.test",
						collection: "app.bsky.feed.post",
						record: {
							$type: "app.bsky.feed.post",
							text: "Should fail",
							createdAt: new Date().toISOString(),
						},
					}),
				},
			);

			expect(response.status).toBe(401);
		});
	});
});
