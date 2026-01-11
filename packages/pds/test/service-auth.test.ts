import { describe, it, expect } from "vitest";
import { Secp256k1Keypair } from "@atproto/crypto";
import { createServiceJwt, verifyServiceJwt } from "../src/service-auth";
import { env, worker } from "./helpers";

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

		// Expiry should be 5 minutes from iat (for video processing callbacks)
		expect(payload.exp - payload.iat).toBe(300);
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

	it("verifyServiceJwt validates correctly signed token", async () => {
		const keypair = await Secp256k1Keypair.create({ exportable: true });
		const signingKey = await keypair.export();

		const jwt = await createServiceJwt({
			iss: "did:web:alice.test",
			aud: "did:web:pds.test",
			lxm: "com.atproto.repo.uploadBlob",
			keypair,
		});

		const payload = await verifyServiceJwt(
			jwt,
			signingKey,
			"did:web:pds.test",
			"did:web:alice.test",
		);

		expect(payload.iss).toBe("did:web:alice.test");
		expect(payload.aud).toBe("did:web:pds.test");
		expect(payload.lxm).toBe("com.atproto.repo.uploadBlob");
	});

	it("verifyServiceJwt rejects wrong audience", async () => {
		const keypair = await Secp256k1Keypair.create({ exportable: true });
		const signingKey = await keypair.export();

		const jwt = await createServiceJwt({
			iss: "did:web:alice.test",
			aud: "did:web:other.test",
			lxm: "com.atproto.repo.uploadBlob",
			keypair,
		});

		await expect(
			verifyServiceJwt(
				jwt,
				signingKey,
				"did:web:pds.test", // wrong audience
				"did:web:alice.test",
			),
		).rejects.toThrow("Invalid audience");
	});

	it("uploadBlob accepts service JWT auth (video upload flow)", async () => {
		// First get a service JWT for uploadBlob
		// This mimics what happens when a client uploads a video:
		// 1. Client calls getServiceAuth with aud=PDS and lxm=uploadBlob
		// 2. Client sends video to video.bsky.app with this token
		// 3. Video service calls uploadBlob on our PDS using the same token
		const getAuthResponse = await worker.fetch(
			new Request(
				`http://pds.test/xrpc/com.atproto.server.getServiceAuth?aud=did:web:${env.PDS_HOSTNAME}&lxm=com.atproto.repo.uploadBlob`,
				{
					headers: {
						Authorization: `Bearer ${env.AUTH_TOKEN}`,
					},
				},
			),
			env,
		);
		expect(getAuthResponse.status).toBe(200);

		const { token } = (await getAuthResponse.json()) as { token: string };

		// Now use that service JWT to call uploadBlob
		// This simulates what video.bsky.app does after processing a video
		const blobData = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // PNG header
		const uploadResponse = await worker.fetch(
			new Request("http://pds.test/xrpc/com.atproto.repo.uploadBlob", {
				method: "POST",
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "image/png",
				},
				body: blobData,
			}),
			env,
		);

		expect(uploadResponse.status).toBe(200);
		const blob = (await uploadResponse.json()) as {
			blob: { ref: { $link: string } };
		};
		expect(blob.blob.ref.$link).toBeDefined();
	});
});
