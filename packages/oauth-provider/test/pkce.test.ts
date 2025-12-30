import { describe, it, expect } from "vitest";
import {
	verifyPkceChallenge,
	generateCodeChallenge,
	generateCodeVerifier,
} from "../src/pkce.js";

describe("PKCE", () => {
	describe("generateCodeVerifier", () => {
		it("generates a verifier of correct length", () => {
			const verifier = generateCodeVerifier();
			expect(verifier.length).toBeGreaterThanOrEqual(43);
			expect(verifier.length).toBeLessThanOrEqual(128);
		});

		it("generates unique verifiers", () => {
			const verifier1 = generateCodeVerifier();
			const verifier2 = generateCodeVerifier();
			expect(verifier1).not.toBe(verifier2);
		});

		it("uses only unreserved characters", () => {
			const verifier = generateCodeVerifier();
			expect(verifier).toMatch(/^[A-Za-z0-9._~-]+$/);
		});
	});

	describe("generateCodeChallenge", () => {
		it("generates S256 challenge from verifier", async () => {
			// Known test vector from RFC 7636 Appendix B
			const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
			const challenge = await generateCodeChallenge(verifier);
			expect(challenge).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
		});

		it("generates base64url-encoded challenge without padding", async () => {
			const verifier = generateCodeVerifier();
			const challenge = await generateCodeChallenge(verifier);
			expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/); // base64url without padding
			expect(challenge).not.toContain("=");
			expect(challenge.length).toBe(43); // SHA-256 = 32 bytes = 43 base64url chars
		});
	});

	describe("verifyPkceChallenge", () => {
		it("verifies valid S256 challenge", async () => {
			const verifier = generateCodeVerifier();
			const challenge = await generateCodeChallenge(verifier);
			const result = await verifyPkceChallenge(verifier, challenge, "S256");
			expect(result).toBe(true);
		});

		it("rejects invalid verifier", async () => {
			const verifier = generateCodeVerifier();
			const challenge = await generateCodeChallenge(verifier);
			const result = await verifyPkceChallenge("wrong-verifier-value", challenge, "S256");
			expect(result).toBe(false);
		});

		it("rejects verifier that is too short", async () => {
			const result = await verifyPkceChallenge("short", "challenge", "S256");
			expect(result).toBe(false);
		});

		it("rejects verifier that is too long", async () => {
			const longVerifier = "a".repeat(129);
			const result = await verifyPkceChallenge(longVerifier, "challenge", "S256");
			expect(result).toBe(false);
		});

		it("rejects verifier with invalid characters", async () => {
			const invalidVerifier = "a".repeat(43) + "!";
			const challenge = await generateCodeChallenge("a".repeat(43));
			const result = await verifyPkceChallenge(invalidVerifier, challenge, "S256");
			expect(result).toBe(false);
		});

		it("throws for unsupported challenge method", async () => {
			await expect(
				verifyPkceChallenge("verifier", "challenge", "plain" as "S256")
			).rejects.toThrow("Only S256 challenge method is supported");
		});
	});
});
