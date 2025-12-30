import { describe, it, expect, beforeEach } from "vitest";
import {
	verifyDpopProof,
	calculateKeyThumbprint,
	createDpopProof,
	generateDpopKeyPair,
	generateDpopNonce,
	DpopError,
} from "../src/dpop.js";

describe("DPoP", () => {
	let keyPair: { privateKey: CryptoKey; publicKey: CryptoKey; publicJwk: JsonWebKey };

	beforeEach(async () => {
		keyPair = await generateDpopKeyPair("ES256");
	});

	describe("generateDpopKeyPair", () => {
		it("generates an ES256 key pair", async () => {
			expect(keyPair.privateKey).toBeDefined();
			expect(keyPair.publicKey).toBeDefined();
			expect(keyPair.publicJwk).toBeDefined();
			expect(keyPair.publicJwk.kty).toBe("EC");
			expect(keyPair.publicJwk.crv).toBe("P-256");
		});

		it("public JWK does not contain private key material", () => {
			expect(keyPair.publicJwk.d).toBeUndefined();
		});
	});

	describe("calculateKeyThumbprint", () => {
		it("calculates consistent thumbprint for EC key", async () => {
			const thumbprint1 = await calculateKeyThumbprint(keyPair.publicJwk);
			const thumbprint2 = await calculateKeyThumbprint(keyPair.publicJwk);
			expect(thumbprint1).toBe(thumbprint2);
		});

		it("calculates different thumbprints for different keys", async () => {
			const keyPair2 = await generateDpopKeyPair("ES256");
			const thumbprint1 = await calculateKeyThumbprint(keyPair.publicJwk);
			const thumbprint2 = await calculateKeyThumbprint(keyPair2.publicJwk);
			expect(thumbprint1).not.toBe(thumbprint2);
		});
	});

	describe("generateDpopNonce", () => {
		it("generates a base64url-encoded nonce", () => {
			const nonce = generateDpopNonce();
			expect(nonce).toMatch(/^[A-Za-z0-9_-]+$/);
		});

		it("generates unique nonces", () => {
			const nonce1 = generateDpopNonce();
			const nonce2 = generateDpopNonce();
			expect(nonce1).not.toBe(nonce2);
		});
	});

	describe("createDpopProof", () => {
		it("creates a valid DPoP proof JWT", async () => {
			const proof = await createDpopProof(
				keyPair.privateKey,
				keyPair.publicJwk,
				{ htm: "POST", htu: "https://example.com/token" },
				"ES256"
			);

			expect(proof).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

			// Parse and verify header
			const [headerB64] = proof.split(".");
			const header = JSON.parse(atob(headerB64!.replace(/-/g, "+").replace(/_/g, "/")));
			expect(header.typ).toBe("dpop+jwt");
			expect(header.alg).toBe("ES256");
			expect(header.jwk).toBeDefined();
		});

		it("includes ath claim when access token provided", async () => {
			const accessToken = "test-access-token";
			const tokenHash = await crypto.subtle.digest(
				"SHA-256",
				new TextEncoder().encode(accessToken)
			);
			const expectedAth = btoa(String.fromCharCode(...new Uint8Array(tokenHash)))
				.replace(/\+/g, "-")
				.replace(/\//g, "_")
				.replace(/=+$/, "");

			const proof = await createDpopProof(
				keyPair.privateKey,
				keyPair.publicJwk,
				{ htm: "GET", htu: "https://example.com/api", ath: expectedAth },
				"ES256"
			);

			const [, payloadB64] = proof.split(".");
			const payload = JSON.parse(atob(payloadB64!.replace(/-/g, "+").replace(/_/g, "/")));
			expect(payload.ath).toBe(expectedAth);
		});
	});

	describe("verifyDpopProof", () => {
		it("verifies a valid DPoP proof", async () => {
			const proof = await createDpopProof(
				keyPair.privateKey,
				keyPair.publicJwk,
				{ htm: "POST", htu: "https://example.com/token" },
				"ES256"
			);

			const request = new Request("https://example.com/token", {
				method: "POST",
				headers: { DPoP: proof },
			});

			const result = await verifyDpopProof(request);
			expect(result.htm).toBe("POST");
			expect(result.htu).toBe("https://example.com/token");
			expect(result.jkt).toBeDefined();
		});

		it("rejects request without DPoP header", async () => {
			const request = new Request("https://example.com/token", {
				method: "POST",
			});

			await expect(verifyDpopProof(request)).rejects.toThrow(DpopError);
			await expect(verifyDpopProof(request)).rejects.toMatchObject({
				code: "missing_dpop",
			});
		});

		it("rejects invalid JWT format", async () => {
			const request = new Request("https://example.com/token", {
				method: "POST",
				headers: { DPoP: "not.a.valid.jwt" },
			});

			await expect(verifyDpopProof(request)).rejects.toThrow(DpopError);
		});

		it("rejects mismatched HTTP method", async () => {
			const proof = await createDpopProof(
				keyPair.privateKey,
				keyPair.publicJwk,
				{ htm: "POST", htu: "https://example.com/token" },
				"ES256"
			);

			const request = new Request("https://example.com/token", {
				method: "GET",
				headers: { DPoP: proof },
			});

			await expect(verifyDpopProof(request)).rejects.toThrow(DpopError);
		});

		it("rejects mismatched URL", async () => {
			const proof = await createDpopProof(
				keyPair.privateKey,
				keyPair.publicJwk,
				{ htm: "POST", htu: "https://example.com/token" },
				"ES256"
			);

			const request = new Request("https://other.com/token", {
				method: "POST",
				headers: { DPoP: proof },
			});

			await expect(verifyDpopProof(request)).rejects.toThrow(DpopError);
		});

		it("ignores query parameters in URL comparison", async () => {
			const proof = await createDpopProof(
				keyPair.privateKey,
				keyPair.publicJwk,
				{ htm: "POST", htu: "https://example.com/token" },
				"ES256"
			);

			const request = new Request("https://example.com/token?foo=bar", {
				method: "POST",
				headers: { DPoP: proof },
			});

			const result = await verifyDpopProof(request);
			expect(result.htm).toBe("POST");
		});

		it("verifies access token hash when provided", async () => {
			const accessToken = "test-access-token";
			const tokenHash = await crypto.subtle.digest(
				"SHA-256",
				new TextEncoder().encode(accessToken)
			);
			const ath = btoa(String.fromCharCode(...new Uint8Array(tokenHash)))
				.replace(/\+/g, "-")
				.replace(/\//g, "_")
				.replace(/=+$/, "");

			const proof = await createDpopProof(
				keyPair.privateKey,
				keyPair.publicJwk,
				{ htm: "GET", htu: "https://example.com/api", ath },
				"ES256"
			);

			const request = new Request("https://example.com/api", {
				method: "GET",
				headers: { DPoP: proof },
			});

			const result = await verifyDpopProof(request, { accessToken });
			expect(result.ath).toBe(ath);
		});

		it("rejects invalid access token hash", async () => {
			const ath = btoa("wrong-hash")
				.replace(/\+/g, "-")
				.replace(/\//g, "_")
				.replace(/=+$/, "");

			const proof = await createDpopProof(
				keyPair.privateKey,
				keyPair.publicJwk,
				{ htm: "GET", htu: "https://example.com/api", ath },
				"ES256"
			);

			const request = new Request("https://example.com/api", {
				method: "GET",
				headers: { DPoP: proof },
			});

			await expect(
				verifyDpopProof(request, { accessToken: "different-token" })
			).rejects.toThrow(DpopError);
		});

		it("rejects unsupported algorithm", async () => {
			const proof = await createDpopProof(
				keyPair.privateKey,
				keyPair.publicJwk,
				{ htm: "POST", htu: "https://example.com/token" },
				"ES256"
			);

			const request = new Request("https://example.com/token", {
				method: "POST",
				headers: { DPoP: proof },
			});

			await expect(
				verifyDpopProof(request, { allowedAlgorithms: ["RS256"] })
			).rejects.toThrow(DpopError);
		});
	});
});
