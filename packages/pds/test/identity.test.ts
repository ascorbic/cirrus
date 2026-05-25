import { describe, expect, it } from "vitest";
import { Secp256k1Keypair } from "@atproto/crypto";
import { env, worker } from "./helpers";

describe("Identity Endpoints", () => {
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
