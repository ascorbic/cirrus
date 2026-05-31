import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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

	describe("com.atproto.identity.submitPlcOperation", () => {
		let originalFetch: typeof fetch;

		beforeAll(() => {
			originalFetch = globalThis.fetch;
		});

		afterEach(() => {
			globalThis.fetch = originalFetch;
			vi.unstubAllGlobals();
		});

		it("requires authentication", async () => {
			const response = await worker.fetch(
				new Request(
					"http://pds.test/xrpc/com.atproto.identity.submitPlcOperation",
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ operation: { type: "plc_operation" } }),
					},
				),
				env,
			);
			expect(response.status).toBe(401);
		});

		it("rejects request without operation", async () => {
			const response = await worker.fetch(
				new Request(
					"http://pds.test/xrpc/com.atproto.identity.submitPlcOperation",
					{
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							Authorization: `Bearer ${env.AUTH_TOKEN}`,
						},
						body: JSON.stringify({}),
					},
				),
				env,
			);
			expect(response.status).toBe(400);
			const body = (await response.json()) as { error: string };
			expect(body.error).toBe("InvalidRequest");
		});

		it("forwards the operation to plc.directory for this DID", async () => {
			const operation = {
				type: "plc_operation",
				prev: "bafyreid",
				rotationKeys: ["did:key:zRotation"],
				verificationMethods: { atproto: "did:key:zVerify" },
				alsoKnownAs: ["at://example.test"],
				services: {
					atproto_pds: {
						type: "AtprotoPersonalDataServer",
						endpoint: "https://new.pds.example",
					},
				},
				sig: "AAAA",
			};

			const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
				const href = typeof url === "string" ? url : url.toString();
				expect(href).toBe(`https://plc.directory/${env.DID}`);
				expect(init?.method).toBe("POST");
				expect(JSON.parse(init?.body as string)).toEqual(operation);
				return new Response(null, { status: 200 });
			});
			vi.stubGlobal("fetch", fetchMock);

			const response = await worker.fetch(
				new Request(
					"http://pds.test/xrpc/com.atproto.identity.submitPlcOperation",
					{
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							Authorization: `Bearer ${env.AUTH_TOKEN}`,
						},
						body: JSON.stringify({ operation }),
					},
				),
				env,
			);

			expect(fetchMock).toHaveBeenCalledTimes(1);
			expect(response.status).toBe(200);
		});

		it("surfaces PLC directory errors to the caller", async () => {
			const fetchMock = vi.fn(
				async () =>
					new Response("invalid signature", {
						status: 400,
						headers: { "Content-Type": "text/plain" },
					}),
			);
			vi.stubGlobal("fetch", fetchMock);

			const response = await worker.fetch(
				new Request(
					"http://pds.test/xrpc/com.atproto.identity.submitPlcOperation",
					{
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							Authorization: `Bearer ${env.AUTH_TOKEN}`,
						},
						body: JSON.stringify({
							operation: { type: "plc_operation", sig: "bad" },
						}),
					},
				),
				env,
			);

			expect(response.status).toBe(400);
			const body = (await response.json()) as {
				error: string;
				message: string;
			};
			expect(body.error).toBe("PlcDirectoryError");
			expect(body.message).toContain("invalid signature");
		});
	});
});
