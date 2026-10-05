import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Secp256k1Keypair, verifySignature } from "@atproto/crypto";
import { encode } from "@atcute/cbor";
import { base64url } from "jose";
import { env, worker } from "./helpers";
import { createMigrationToken } from "../src/migration-token";

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

	describe("com.atproto.identity.signPlcOperation", () => {
		const recoveryKey = "did:key:zQ3shRecoveryKeyExample";
		const services = {
			atproto_pds: {
				type: "AtprotoPersonalDataServer",
				endpoint: `https://${env.PDS_HOSTNAME}`,
			},
		};

		afterEach(() => {
			vi.unstubAllGlobals();
		});

		async function signingDid(): Promise<string> {
			return (await Secp256k1Keypair.import(env.SIGNING_KEY)).did();
		}

		function mockAuditLog(operation: Record<string, unknown>) {
			vi.stubGlobal(
				"fetch",
				vi.fn(async (input: RequestInfo | URL) => {
					const url = input instanceof Request ? input.url : input.toString();
					expect(url).toBe(`https://plc.directory/${env.DID}/log/audit`);
					return Response.json([
						{
							did: env.DID,
							operation: { ...operation, prev: null, sig: "b2xk" },
							cid: "bafyreioldop",
							nullified: true,
							createdAt: "2025-01-01T00:00:00.000Z",
						},
						{
							did: env.DID,
							operation: { ...operation, prev: "bafyreioldop", sig: "c2ln" },
							cid: "bafyreicurrentop",
							nullified: false,
							createdAt: "2025-01-02T00:00:00.000Z",
						},
					]);
				}),
			);
		}

		async function sign(body: Record<string, unknown>) {
			return worker.fetch(
				new Request(
					"http://pds.test/xrpc/com.atproto.identity.signPlcOperation",
					{
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							Authorization: `Bearer ${env.AUTH_TOKEN}`,
						},
						body: JSON.stringify({
							token: await createMigrationToken(env.DID, env.JWT_SECRET),
							...body,
						}),
					},
				),
				env,
			);
		}

		it("signs the requested changes on top of the current operation", async () => {
			const key = await signingDid();
			mockAuditLog({
				type: "plc_operation",
				rotationKeys: ["did:key:zQ3shOldPdsKeyExample", key],
				verificationMethods: { atproto: key },
				alsoKnownAs: ["at://alice.example.com"],
				services,
			});

			const response = await sign({ rotationKeys: [recoveryKey, key] });
			expect(response.status).toBe(200);

			const { operation } = (await response.json()) as {
				operation: Record<string, unknown> & { sig: string };
			};
			const { sig, ...unsigned } = operation;
			expect(unsigned).toEqual({
				type: "plc_operation",
				prev: "bafyreicurrentop",
				rotationKeys: [recoveryKey, key],
				verificationMethods: { atproto: key },
				alsoKnownAs: ["at://alice.example.com"],
				services,
			});
			expect(
				await verifySignature(key, encode(unsigned), base64url.decode(sig)),
			).toBe(true);
		});

		it("refuses when the signing key is not a rotation key", async () => {
			mockAuditLog({
				type: "plc_operation",
				rotationKeys: ["did:key:zQ3shOldPdsKeyExample"],
				verificationMethods: { atproto: await signingDid() },
				alsoKnownAs: ["at://alice.example.com"],
				services,
			});

			const response = await sign({});
			expect(response.status).toBe(400);
			const body = (await response.json()) as {
				error: string;
				message: string;
			};
			expect(body.error).toBe("InvalidRequest");
			expect(body.message).toContain("not a rotation key");
		});

		it("refuses when the DID has been tombstoned", async () => {
			mockAuditLog({ type: "plc_tombstone" });

			const response = await sign({});
			expect(response.status).toBe(500);
		});
	});
});
