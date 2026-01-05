import { describe, it, expect, afterEach } from "vitest";
import { env, worker } from "./helpers";

describe("gg.mk.experimental.emitIdentityEvent", () => {
	// Ensure account is activated after each test to prevent state leakage
	afterEach(async () => {
		await worker.fetch(
			new Request(`http://pds.test/xrpc/com.atproto.server.activateAccount`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${env.AUTH_TOKEN}`,
				},
			}),
			env,
		);
	});

	it("requires authentication", async () => {
		const response = await worker.fetch(
			new Request(`http://pds.test/xrpc/gg.mk.experimental.emitIdentityEvent`, {
				method: "POST",
			}),
			env,
		);

		expect(response.status).toBe(401);
		const body = (await response.json()) as Record<string, unknown>;
		expect(body.error).toBe("AuthMissing");
	});

	it("emits identity event with sequence number", async () => {
		// Create a record to ensure the account has data
		await worker.fetch(
			new Request(`http://pds.test/xrpc/com.atproto.repo.createRecord`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${env.AUTH_TOKEN}`,
				},
				body: JSON.stringify({
					repo: env.DID,
					collection: "app.bsky.feed.post",
					record: {
						$type: "app.bsky.feed.post",
						text: "Test post for emit identity",
						createdAt: new Date().toISOString(),
					},
				}),
			}),
			env,
		);

		const response = await worker.fetch(
			new Request(`http://pds.test/xrpc/gg.mk.experimental.emitIdentityEvent`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${env.AUTH_TOKEN}`,
				},
			}),
			env,
		);

		expect(response.status).toBe(200);
		const body = (await response.json()) as { seq: number };
		expect(typeof body.seq).toBe("number");
		expect(body.seq).toBeGreaterThan(0);
	});

	it("can be called multiple times", async () => {
		// First call
		const response1 = await worker.fetch(
			new Request(`http://pds.test/xrpc/gg.mk.experimental.emitIdentityEvent`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${env.AUTH_TOKEN}`,
				},
			}),
			env,
		);

		expect(response1.status).toBe(200);
		const body1 = (await response1.json()) as { seq: number };

		// Second call - should get a higher sequence number
		const response2 = await worker.fetch(
			new Request(`http://pds.test/xrpc/gg.mk.experimental.emitIdentityEvent`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${env.AUTH_TOKEN}`,
				},
			}),
			env,
		);

		expect(response2.status).toBe(200);
		const body2 = (await response2.json()) as { seq: number };
		expect(body2.seq).toBeGreaterThan(body1.seq);
	});
});
