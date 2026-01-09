/**
 * Passkey (WebAuthn) security tests
 *
 * Tests for the passkey authentication and registration flows,
 * focusing on security properties like challenge verification,
 * token expiry, and replay protection.
 */
import { describe, it, expect, vi } from "vitest";
import { env, runInDurableObject } from "./helpers";
import { AccountDurableObject } from "../src/account-do";

describe("Passkey Security", () => {
	describe("WebAuthn Challenge Storage", () => {
		it("stores and retrieves a challenge", async () => {
			const id = env.ACCOUNT.newUniqueId();
			const stub = env.ACCOUNT.get(id);

			await runInDurableObject(stub, async (instance: AccountDurableObject) => {
				const oauthStorage = await instance.getOAuthStorage();
				const challenge = "test-challenge-" + crypto.randomUUID();

				oauthStorage.saveWebAuthnChallenge(challenge);
				const isValid = oauthStorage.consumeWebAuthnChallenge(challenge);

				expect(isValid).toBe(true);
			});
		});

		it("challenge can only be consumed once (single-use)", async () => {
			const id = env.ACCOUNT.newUniqueId();
			const stub = env.ACCOUNT.get(id);

			await runInDurableObject(stub, async (instance: AccountDurableObject) => {
				const oauthStorage = await instance.getOAuthStorage();
				const challenge = "test-challenge-" + crypto.randomUUID();

				oauthStorage.saveWebAuthnChallenge(challenge);

				// First consume should succeed
				const firstConsume = oauthStorage.consumeWebAuthnChallenge(challenge);
				expect(firstConsume).toBe(true);

				// Second consume should fail (already used)
				const secondConsume = oauthStorage.consumeWebAuthnChallenge(challenge);
				expect(secondConsume).toBe(false);
			});
		});

		it("rejects unknown challenges", async () => {
			const id = env.ACCOUNT.newUniqueId();
			const stub = env.ACCOUNT.get(id);

			await runInDurableObject(stub, async (instance: AccountDurableObject) => {
				const oauthStorage = await instance.getOAuthStorage();

				const isValid = oauthStorage.consumeWebAuthnChallenge(
					"unknown-challenge-" + crypto.randomUUID(),
				);

				expect(isValid).toBe(false);
			});
		});

		it("rejects expired challenges (2 minute TTL)", async () => {
			const id = env.ACCOUNT.newUniqueId();
			const stub = env.ACCOUNT.get(id);

			await runInDurableObject(stub, async (instance: AccountDurableObject) => {
				const oauthStorage = await instance.getOAuthStorage();
				const challenge = "test-challenge-" + crypto.randomUUID();

				// Save challenge with mocked time
				const now = Date.now();
				vi.setSystemTime(now);
				oauthStorage.saveWebAuthnChallenge(challenge);

				// Fast-forward past the 2 minute TTL
				vi.setSystemTime(now + 3 * 60 * 1000); // 3 minutes later

				const isValid = oauthStorage.consumeWebAuthnChallenge(challenge);
				expect(isValid).toBe(false);

				vi.useRealTimers();
			});
		});

		it("accepts challenge just before expiry", async () => {
			const id = env.ACCOUNT.newUniqueId();
			const stub = env.ACCOUNT.get(id);

			await runInDurableObject(stub, async (instance: AccountDurableObject) => {
				const oauthStorage = await instance.getOAuthStorage();
				const challenge = "test-challenge-" + crypto.randomUUID();

				const now = Date.now();
				vi.setSystemTime(now);
				oauthStorage.saveWebAuthnChallenge(challenge);

				// Just under 2 minutes - should still be valid
				vi.setSystemTime(now + 119 * 1000); // 1 min 59 sec later

				const isValid = oauthStorage.consumeWebAuthnChallenge(challenge);
				expect(isValid).toBe(true);

				vi.useRealTimers();
			});
		});

		it("handles multiple concurrent challenges", async () => {
			const id = env.ACCOUNT.newUniqueId();
			const stub = env.ACCOUNT.get(id);

			await runInDurableObject(stub, async (instance: AccountDurableObject) => {
				const oauthStorage = await instance.getOAuthStorage();

				const challenge1 = "challenge-1-" + crypto.randomUUID();
				const challenge2 = "challenge-2-" + crypto.randomUUID();
				const challenge3 = "challenge-3-" + crypto.randomUUID();

				oauthStorage.saveWebAuthnChallenge(challenge1);
				oauthStorage.saveWebAuthnChallenge(challenge2);
				oauthStorage.saveWebAuthnChallenge(challenge3);

				// Consume out of order
				expect(oauthStorage.consumeWebAuthnChallenge(challenge2)).toBe(true);
				expect(oauthStorage.consumeWebAuthnChallenge(challenge1)).toBe(true);
				expect(oauthStorage.consumeWebAuthnChallenge(challenge3)).toBe(true);

				// All should be consumed now
				expect(oauthStorage.consumeWebAuthnChallenge(challenge1)).toBe(false);
				expect(oauthStorage.consumeWebAuthnChallenge(challenge2)).toBe(false);
				expect(oauthStorage.consumeWebAuthnChallenge(challenge3)).toBe(false);
			});
		});
	});

	describe("Passkey Token Storage", () => {
		it("stores and retrieves a passkey token", async () => {
			const id = env.ACCOUNT.newUniqueId();
			const stub = env.ACCOUNT.get(id);

			const token = "test-token-" + crypto.randomUUID();
			const challenge = "test-challenge-" + crypto.randomUUID();
			const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes

			await stub.rpcSavePasskeyToken(token, challenge, expiresAt, "Test Passkey");
			const tokenData = await stub.rpcConsumePasskeyToken(token);

			expect(tokenData).not.toBeNull();
			expect(tokenData?.challenge).toBe(challenge);
			expect(tokenData?.name).toBe("Test Passkey");
		});

		it("token can only be consumed once", async () => {
			const id = env.ACCOUNT.newUniqueId();
			const stub = env.ACCOUNT.get(id);

			const token = "test-token-" + crypto.randomUUID();
			const challenge = "test-challenge-" + crypto.randomUUID();
			const expiresAt = Date.now() + 10 * 60 * 1000;

			await stub.rpcSavePasskeyToken(token, challenge, expiresAt);

			const firstConsume = await stub.rpcConsumePasskeyToken(token);
			expect(firstConsume).not.toBeNull();

			const secondConsume = await stub.rpcConsumePasskeyToken(token);
			expect(secondConsume).toBeNull();
		});

		it("rejects expired tokens", async () => {
			const id = env.ACCOUNT.newUniqueId();
			const stub = env.ACCOUNT.get(id);

			const token = "test-token-" + crypto.randomUUID();
			const challenge = "test-challenge-" + crypto.randomUUID();
			const expiresAt = Date.now() - 1000; // Already expired

			await stub.rpcSavePasskeyToken(token, challenge, expiresAt);
			const tokenData = await stub.rpcConsumePasskeyToken(token);

			expect(tokenData).toBeNull();
		});

		it("rejects unknown tokens", async () => {
			const id = env.ACCOUNT.newUniqueId();
			const stub = env.ACCOUNT.get(id);

			const tokenData = await stub.rpcConsumePasskeyToken(
				"unknown-token-" + crypto.randomUUID(),
			);

			expect(tokenData).toBeNull();
		});
	});

	describe("Passkey Credential Storage", () => {
		it("saves and retrieves a passkey credential", async () => {
			const id = env.ACCOUNT.newUniqueId();
			const stub = env.ACCOUNT.get(id);

			const credentialId = "cred-" + crypto.randomUUID();
			const publicKey = new Uint8Array([1, 2, 3, 4, 5]);
			const counter = 0;
			const name = "My Passkey";

			await stub.rpcSavePasskey(credentialId, publicKey, counter, name);
			const passkey = await stub.rpcGetPasskey(credentialId);

			expect(passkey).not.toBeNull();
			expect(passkey?.credentialId).toBe(credentialId);
			expect(passkey?.name).toBe(name);
			expect(passkey?.counter).toBe(counter);
			expect(new Uint8Array(passkey!.publicKey)).toEqual(publicKey);
		});

		it("lists all passkeys for an account", async () => {
			const id = env.ACCOUNT.newUniqueId();
			const stub = env.ACCOUNT.get(id);

			const cred1 = "cred-1-" + crypto.randomUUID();
			const cred2 = "cred-2-" + crypto.randomUUID();

			await stub.rpcSavePasskey(cred1, new Uint8Array([1]), 0, "Passkey 1");
			await stub.rpcSavePasskey(cred2, new Uint8Array([2]), 0, "Passkey 2");

			const passkeys = await stub.rpcListPasskeys();

			expect(passkeys).toHaveLength(2);
			expect(passkeys.map((p) => p.credentialId)).toContain(cred1);
			expect(passkeys.map((p) => p.credentialId)).toContain(cred2);
		});

		it("updates passkey counter for replay protection", async () => {
			const id = env.ACCOUNT.newUniqueId();
			const stub = env.ACCOUNT.get(id);

			const credentialId = "cred-" + crypto.randomUUID();
			await stub.rpcSavePasskey(credentialId, new Uint8Array([1]), 0);

			// Simulate authentication - counter should increase
			await stub.rpcUpdatePasskeyCounter(credentialId, 1);

			const passkey = await stub.rpcGetPasskey(credentialId);
			expect(passkey?.counter).toBe(1);

			// Counter should only go up
			await stub.rpcUpdatePasskeyCounter(credentialId, 5);

			const passkey2 = await stub.rpcGetPasskey(credentialId);
			expect(passkey2?.counter).toBe(5);
		});

		it("deletes a passkey", async () => {
			const id = env.ACCOUNT.newUniqueId();
			const stub = env.ACCOUNT.get(id);

			const credentialId = "cred-" + crypto.randomUUID();
			await stub.rpcSavePasskey(credentialId, new Uint8Array([1]), 0);

			const deleted = await stub.rpcDeletePasskey(credentialId);
			expect(deleted).toBe(true);

			const passkey = await stub.rpcGetPasskey(credentialId);
			expect(passkey).toBeNull();
		});

		it("returns false when deleting non-existent passkey", async () => {
			const id = env.ACCOUNT.newUniqueId();
			const stub = env.ACCOUNT.get(id);

			const deleted = await stub.rpcDeletePasskey("nonexistent-" + crypto.randomUUID());
			expect(deleted).toBe(false);
		});
	});

	describe("Cleanup Alarm", () => {
		it("cleans up expired challenges during alarm", async () => {
			const id = env.ACCOUNT.newUniqueId();
			const stub = env.ACCOUNT.get(id);

			await runInDurableObject(stub, async (instance: AccountDurableObject) => {
				const oauthStorage = await instance.getOAuthStorage();

				// Create some challenges
				const now = Date.now();
				vi.setSystemTime(now);

				const oldChallenge = "old-" + crypto.randomUUID();
				const newChallenge = "new-" + crypto.randomUUID();

				oauthStorage.saveWebAuthnChallenge(oldChallenge);

				// Fast forward 3 minutes
				vi.setSystemTime(now + 3 * 60 * 1000);
				oauthStorage.saveWebAuthnChallenge(newChallenge);

				// Run cleanup
				oauthStorage.cleanup();

				// Old challenge should be gone
				expect(oauthStorage.consumeWebAuthnChallenge(oldChallenge)).toBe(false);

				// New challenge should still be valid
				expect(oauthStorage.consumeWebAuthnChallenge(newChallenge)).toBe(true);

				vi.useRealTimers();
			});
		});
	});
});
