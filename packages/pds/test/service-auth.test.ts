import { describe, it, expect } from "vitest";
import { Secp256k1Keypair } from "@atproto/crypto";
import { createServiceJwt } from "../src/service-auth";

describe("Service Auth", () => {
	it("creates valid service JWT", async () => {
		const keypair = await Secp256k1Keypair.create({ exportable: true });

		const jwt = await createServiceJwt({
			iss: "did:web:alice.test",
			aud: "did:web:api.bsky.app",
			lxm: "app.bsky.feed.getTimeline",
			keypair,
		});

		// JWT should have three parts
		const parts = jwt.split(".");
		expect(parts).toHaveLength(3);

		// Decode header
		const header = JSON.parse(Buffer.from(parts[0], "base64url").toString());
		expect(header.typ).toBe("JWT");
		expect(header.alg).toBe("ES256K");

		// Decode payload
		const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
		expect(payload.iss).toBe("did:web:alice.test");
		expect(payload.aud).toBe("did:web:api.bsky.app");
		expect(payload.lxm).toBe("app.bsky.feed.getTimeline");
		expect(payload.iat).toBeTypeOf("number");
		expect(payload.exp).toBeTypeOf("number");
		expect(payload.jti).toBeTypeOf("string");

		// Expiry should be ~60 seconds from iat
		expect(payload.exp - payload.iat).toBe(60);
	});

	it("creates JWT without lxm when null", async () => {
		const keypair = await Secp256k1Keypair.create({ exportable: true });

		const jwt = await createServiceJwt({
			iss: "did:web:alice.test",
			aud: "did:web:api.bsky.app",
			lxm: null,
			keypair,
		});

		const parts = jwt.split(".");
		const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());

		// lxm should not be present when null
		expect(payload.lxm).toBeUndefined();
	});

	it("creates verifiable signature", async () => {
		const keypair = await Secp256k1Keypair.create({ exportable: true });

		const jwt = await createServiceJwt({
			iss: "did:web:alice.test",
			aud: "did:web:api.bsky.app",
			lxm: "com.atproto.sync.getRepo",
			keypair,
		});

		const parts = jwt.split(".");
		const msgBytes = Buffer.from(parts.slice(0, 2).join("."), "utf8");
		const sigBytes = Buffer.from(parts[2], "base64url");

		// Import verify function and use did:key format
		const { verifySignature } = await import("@atproto/crypto");
		const didKey = keypair.did();

		const isValid = await verifySignature(didKey, msgBytes, sigBytes, {
			jwtAlg: "ES256K",
			allowMalleableSig: true,
		});

		expect(isValid).toBe(true);
	});
});
