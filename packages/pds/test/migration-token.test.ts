import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
	createMigrationToken,
	validateMigrationToken,
} from "../src/migration-token";

const TEST_SECRET = "test-jwt-secret-at-least-32-chars-long";
const TEST_DID = "did:plc:abc123xyz";

describe("Migration Token", () => {
	describe("createMigrationToken", () => {
		it("creates a token with correct format", async () => {
			const token = await createMigrationToken(TEST_DID, TEST_SECRET);

			// Token format: base64url(payload).base64url(signature)
			const parts = token.split(".");
			expect(parts).toHaveLength(2);

			// Payload should be valid base64url
			const [payloadB64] = parts;
			const payloadStr = atob(
				payloadB64!.replace(/-/g, "+").replace(/_/g, "/") +
					"=".repeat((4 - (payloadB64!.length % 4)) % 4),
			);
			const payload = JSON.parse(payloadStr);

			expect(payload.did).toBe(TEST_DID);
			expect(typeof payload.exp).toBe("number");
		});

		it("sets expiry 15 minutes in the future", async () => {
			const before = Math.floor(Date.now() / 1000);
			const token = await createMigrationToken(TEST_DID, TEST_SECRET);
			const after = Math.floor(Date.now() / 1000);

			const [payloadB64] = token.split(".");
			const payloadStr = atob(
				payloadB64!.replace(/-/g, "+").replace(/_/g, "/") +
					"=".repeat((4 - (payloadB64!.length % 4)) % 4),
			);
			const payload = JSON.parse(payloadStr);

			// 15 minutes = 900 seconds
			const expectedMin = before + 900;
			const expectedMax = after + 900;

			expect(payload.exp).toBeGreaterThanOrEqual(expectedMin);
			expect(payload.exp).toBeLessThanOrEqual(expectedMax);
		});

		it("produces different signatures for different secrets", async () => {
			const token1 = await createMigrationToken(TEST_DID, TEST_SECRET);
			const token2 = await createMigrationToken(
				TEST_DID,
				"different-secret-also-32-chars!!",
			);

			const sig1 = token1.split(".")[1];
			const sig2 = token2.split(".")[1];

			expect(sig1).not.toBe(sig2);
		});

		it("produces different signatures for different DIDs", async () => {
			const token1 = await createMigrationToken("did:plc:user1", TEST_SECRET);
			const token2 = await createMigrationToken("did:plc:user2", TEST_SECRET);

			const sig1 = token1.split(".")[1];
			const sig2 = token2.split(".")[1];

			expect(sig1).not.toBe(sig2);
		});
	});

	describe("validateMigrationToken", () => {
		it("validates a correctly signed token", async () => {
			const token = await createMigrationToken(TEST_DID, TEST_SECRET);
			const result = await validateMigrationToken(token, TEST_DID, TEST_SECRET);

			expect(result).not.toBeNull();
			expect(result?.did).toBe(TEST_DID);
		});

		it("rejects token with wrong secret", async () => {
			const token = await createMigrationToken(TEST_DID, TEST_SECRET);
			const result = await validateMigrationToken(
				token,
				TEST_DID,
				"wrong-secret-that-is-also-32-chars",
			);

			expect(result).toBeNull();
		});

		it("rejects token with mismatched DID", async () => {
			const token = await createMigrationToken(TEST_DID, TEST_SECRET);
			const result = await validateMigrationToken(
				token,
				"did:plc:different",
				TEST_SECRET,
			);

			expect(result).toBeNull();
		});

		it("rejects malformed token (no dot)", async () => {
			const result = await validateMigrationToken(
				"nodotinthisstring",
				TEST_DID,
				TEST_SECRET,
			);

			expect(result).toBeNull();
		});

		it("rejects malformed token (too many dots)", async () => {
			const result = await validateMigrationToken(
				"too.many.dots.here",
				TEST_DID,
				TEST_SECRET,
			);

			expect(result).toBeNull();
		});

		it("rejects token with invalid base64", async () => {
			const result = await validateMigrationToken(
				"!!!invalid!!!.!!!base64!!!",
				TEST_DID,
				TEST_SECRET,
			);

			expect(result).toBeNull();
		});

		it("rejects tampered payload", async () => {
			const token = await createMigrationToken(TEST_DID, TEST_SECRET);
			const [, signature] = token.split(".");

			// Create a different payload
			const tamperedPayload = btoa(
				JSON.stringify({ did: "did:plc:hacker", exp: 9999999999 }),
			)
				.replace(/\+/g, "-")
				.replace(/\//g, "_")
				.replace(/=/g, "");

			const tamperedToken = `${tamperedPayload}.${signature}`;
			const result = await validateMigrationToken(
				tamperedToken,
				"did:plc:hacker",
				TEST_SECRET,
			);

			expect(result).toBeNull();
		});

		describe("expiry handling", () => {
			beforeEach(() => {
				vi.useFakeTimers();
			});

			afterEach(() => {
				vi.useRealTimers();
			});

			it("accepts token before expiry", async () => {
				const now = new Date("2026-01-11T12:00:00Z");
				vi.setSystemTime(now);

				const token = await createMigrationToken(TEST_DID, TEST_SECRET);

				// Move forward 14 minutes (still within 15 minute window)
				vi.setSystemTime(new Date("2026-01-11T12:14:00Z"));

				const result = await validateMigrationToken(
					token,
					TEST_DID,
					TEST_SECRET,
				);
				expect(result).not.toBeNull();
			});

			it("rejects expired token", async () => {
				const now = new Date("2026-01-11T12:00:00Z");
				vi.setSystemTime(now);

				const token = await createMigrationToken(TEST_DID, TEST_SECRET);

				// Move forward 16 minutes (past 15 minute expiry)
				vi.setSystemTime(new Date("2026-01-11T12:16:00Z"));

				const result = await validateMigrationToken(
					token,
					TEST_DID,
					TEST_SECRET,
				);
				expect(result).toBeNull();
			});

			it("rejects token at exact expiry boundary", async () => {
				const now = new Date("2026-01-11T12:00:00Z");
				vi.setSystemTime(now);

				const token = await createMigrationToken(TEST_DID, TEST_SECRET);

				// Move forward exactly 15 minutes + 1 second
				vi.setSystemTime(new Date("2026-01-11T12:15:01Z"));

				const result = await validateMigrationToken(
					token,
					TEST_DID,
					TEST_SECRET,
				);
				expect(result).toBeNull();
			});
		});
	});

	describe("round-trip", () => {
		it("token created and validated successfully", async () => {
			const did = "did:plc:roundtrip123";
			const secret = "roundtrip-secret-with-32-chars!!";

			const token = await createMigrationToken(did, secret);
			const result = await validateMigrationToken(token, did, secret);

			expect(result).not.toBeNull();
			expect(result?.did).toBe(did);
			expect(typeof result?.exp).toBe("number");
		});

		it("works with special characters in DID", async () => {
			const did = "did:web:example.com:users:alice";
			const token = await createMigrationToken(did, TEST_SECRET);
			const result = await validateMigrationToken(token, did, TEST_SECRET);

			expect(result).not.toBeNull();
			expect(result?.did).toBe(did);
		});
	});
});
