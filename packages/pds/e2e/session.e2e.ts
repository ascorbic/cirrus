import { describe, it, expect } from "vitest";
import { createAgent, getBaseUrl } from "./helpers";

describe("Session Authentication", () => {
	describe("createSession", () => {
		it("returns error - password login not supported", async () => {
			const response = await fetch(
				`${getBaseUrl()}/xrpc/com.atproto.server.createSession`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						identifier: "1.test.local",
						password: "any-password",
					}),
				},
			);

			expect(response.status).toBe(400);
			const body = (await response.json()) as { error: string; message: string };
			expect(body.error).toBe("InvalidRequest");
			expect(body.message).toContain("Password-based login is not supported");
			expect(body.message).toContain("is.fid.auth.login");
		});
	});

	// TODO: describeServer requires hostname to match WebFID pattern (NNN.domain)
	// The e2e test server runs on localhost which doesn't match
	describe.skip("describeServer", () => {
		it("returns server description without auth", async () => {
			const agent = createAgent();
			const result = await agent.com.atproto.server.describeServer();

			expect(result.success).toBe(true);
			expect(result.data.did).toBeDefined();
			expect(result.data.availableUserDomains).toBeDefined();
		});
	});

	// TODO: Add tests for Farcaster Quick Auth (is.fid.auth.login)
	// These tests require mocking Farcaster's verification endpoint
	// or setting up a test Farcaster signer
});
