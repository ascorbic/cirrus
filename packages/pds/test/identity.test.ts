import { describe, expect, it } from "vitest";
import { Secp256k1Keypair } from "@atproto/crypto";
import { env, worker } from "./helpers";

describe("Identity Endpoints", () => {
	describe("com.atproto.identity.resolveDid", () => {
		it("returns the DID document for our DID", async () => {
			const response = await worker.fetch(
				new Request(
					`http://pds.test/xrpc/com.atproto.identity.resolveDid?did=${env.DID}`,
				),
				env,
			);
			expect(response.status).toBe(200);

			const data = (await response.json()) as { didDoc: Record<string, unknown> };
			expect(data.didDoc).toBeDefined();
			expect(data.didDoc.id).toBe(env.DID);
			expect(data.didDoc.alsoKnownAs).toEqual([`at://${env.HANDLE}`]);
			expect(Array.isArray(data.didDoc.verificationMethod)).toBe(true);
			expect(Array.isArray(data.didDoc.service)).toBe(true);
			const services = data.didDoc.service as Array<{
				id: string;
				type: string;
				serviceEndpoint: string;
			}>;
			expect(services[0]).toMatchObject({
				id: "#atproto_pds",
				type: "AtprotoPersonalDataServer",
				serviceEndpoint: `https://${env.PDS_HOSTNAME}`,
			});
		});

		it("returns 400 when did param is missing", async () => {
			const response = await worker.fetch(
				new Request("http://pds.test/xrpc/com.atproto.identity.resolveDid"),
				env,
			);
			expect(response.status).toBe(400);
			const data = (await response.json()) as { error: string };
			expect(data.error).toBe("InvalidRequest");
		});

		it("falls through to the AppView proxy for foreign DIDs", async () => {
			const response = await worker.fetch(
				new Request(
					"http://pds.test/xrpc/com.atproto.identity.resolveDid?did=did:web:other.example",
				),
				env,
			);
			expect(response.status).not.toBe(404);
		});
	});

	describe("com.atproto.identity.resolveIdentity", () => {
		it("returns identity info for our DID", async () => {
			const response = await worker.fetch(
				new Request(
					`http://pds.test/xrpc/com.atproto.identity.resolveIdentity?identifier=${env.DID}`,
				),
				env,
			);
			expect(response.status).toBe(200);

			const data = (await response.json()) as {
				did: string;
				handle: string;
				didDoc: { id: string };
			};
			expect(data.did).toBe(env.DID);
			expect(data.handle).toBe(env.HANDLE);
			expect(data.didDoc.id).toBe(env.DID);
		});

		it("returns identity info for our handle", async () => {
			const response = await worker.fetch(
				new Request(
					`http://pds.test/xrpc/com.atproto.identity.resolveIdentity?identifier=${env.HANDLE}`,
				),
				env,
			);
			expect(response.status).toBe(200);

			const data = (await response.json()) as {
				did: string;
				handle: string;
				didDoc: { id: string };
			};
			expect(data.did).toBe(env.DID);
			expect(data.handle).toBe(env.HANDLE);
			expect(data.didDoc.id).toBe(env.DID);
		});

		it("returns 400 when identifier param is missing", async () => {
			const response = await worker.fetch(
				new Request(
					"http://pds.test/xrpc/com.atproto.identity.resolveIdentity",
				),
				env,
			);
			expect(response.status).toBe(400);
			const data = (await response.json()) as { error: string };
			expect(data.error).toBe("InvalidRequest");
		});

		it("falls through to the AppView proxy for foreign identifiers", async () => {
			const response = await worker.fetch(
				new Request(
					"http://pds.test/xrpc/com.atproto.identity.resolveIdentity?identifier=bob.test",
				),
				env,
			);
			expect(response.status).not.toBe(404);
		});
	});

	describe("com.atproto.identity.getRecommendedDidCredentials", () => {
		it("requires authentication", async () => {
			const response = await worker.fetch(
				new Request(
					"http://pds.test/xrpc/com.atproto.identity.getRecommendedDidCredentials",
				),
				env,
			);
			expect(response.status).toBe(401);
		});

		it("returns recommended credentials for the current account", async () => {
			const response = await worker.fetch(
				new Request(
					"http://pds.test/xrpc/com.atproto.identity.getRecommendedDidCredentials",
					{
						headers: { Authorization: `Bearer ${env.AUTH_TOKEN}` },
					},
				),
				env,
			);
			expect(response.status).toBe(200);

			const data = (await response.json()) as {
				rotationKeys: string[];
				alsoKnownAs: string[];
				verificationMethods: { atproto: string };
				services: {
					atproto_pds: { type: string; endpoint: string };
				};
			};

			const expectedSigningKey = (
				await Secp256k1Keypair.import(env.SIGNING_KEY)
			).did();

			expect(data.rotationKeys).toEqual([expectedSigningKey]);
			expect(data.alsoKnownAs).toEqual([`at://${env.HANDLE}`]);
			expect(data.verificationMethods).toEqual({ atproto: expectedSigningKey });
			expect(data.services).toEqual({
				atproto_pds: {
					type: "AtprotoPersonalDataServer",
					endpoint: `https://${env.PDS_HOSTNAME}`,
				},
			});
			expect(expectedSigningKey.startsWith("did:key:")).toBe(true);
		});
	});
});
