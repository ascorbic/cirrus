import { describe, it, expect } from "vitest";
import {
	createAgent,
	TEST_DID,
	TEST_HANDLE,
	TEST_PASSWORD,
} from "./helpers";

describe("Session Authentication", () => {
	describe("createSession", () => {
		it("creates session with handle and password", async () => {
			const agent = createAgent();
			const result = await agent.login({
				identifier: TEST_HANDLE,
				password: TEST_PASSWORD,
			});

			expect(result.success).toBe(true);
			expect(result.data.did).toBe(TEST_DID);
			expect(result.data.handle).toBe(TEST_HANDLE);
			expect(result.data.accessJwt).toBeDefined();
			expect(result.data.refreshJwt).toBeDefined();
		});

		it("creates session with DID and password", async () => {
			const agent = createAgent();
			const result = await agent.login({
				identifier: TEST_DID,
				password: TEST_PASSWORD,
			});

			expect(result.success).toBe(true);
			expect(result.data.did).toBe(TEST_DID);
			expect(result.data.accessJwt).toBeDefined();
		});

		it("rejects invalid password", async () => {
			const agent = createAgent();
			await expect(
				agent.login({
					identifier: TEST_HANDLE,
					password: "wrong-password",
				}),
			).rejects.toThrow();
		});

		it("rejects invalid identifier", async () => {
			const agent = createAgent();
			await expect(
				agent.login({
					identifier: "invalid-handle",
					password: TEST_PASSWORD,
				}),
			).rejects.toThrow();
		});
	});

	describe("getSession", () => {
		it("returns current session info", async () => {
			const agent = createAgent();
			await agent.login({
				identifier: TEST_HANDLE,
				password: TEST_PASSWORD,
			});

			const result = await agent.com.atproto.server.getSession();
			expect(result.success).toBe(true);
			expect(result.data.did).toBe(TEST_DID);
			expect(result.data.handle).toBe(TEST_HANDLE);
		});

		it("fails without authentication", async () => {
			const agent = createAgent();
			await expect(agent.com.atproto.server.getSession()).rejects.toThrow();
		});
	});

	describe("refreshSession", () => {
		it("refreshes tokens using refresh JWT", async () => {
			const agent = createAgent();
			await agent.login({
				identifier: TEST_HANDLE,
				password: TEST_PASSWORD,
			});

			const refreshJwt = agent.session?.refreshJwt;
			expect(refreshJwt).toBeDefined();

			// Force refresh
			const result = await agent.com.atproto.server.refreshSession(undefined, {
				headers: {
					authorization: `Bearer ${refreshJwt}`,
				},
			});

			expect(result.success).toBe(true);
			expect(result.data.accessJwt).toBeDefined();
			expect(result.data.refreshJwt).toBeDefined();
			expect(result.data.did).toBe(TEST_DID);
			expect(result.data.handle).toBe(TEST_HANDLE);
		});
	});

	describe("describeServer", () => {
		it("returns server description without auth", async () => {
			const agent = createAgent();
			const result = await agent.com.atproto.server.describeServer();

			expect(result.success).toBe(true);
			expect(result.data.did).toBeDefined();
			expect(result.data.availableUserDomains).toBeDefined();
		});
	});
});
