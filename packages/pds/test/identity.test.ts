import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Secp256k1Keypair, verifySignature } from "@atproto/crypto";
import { decode, encode } from "@atcute/cbor";
import { base64url, calculateJwkThumbprint, SignJWT, type JWK } from "jose";
import { env, runInDurableObject, worker } from "./helpers";
import app from "../src/index";
import type { AccountDurableObject } from "../src/account-do";
import type { PDSEnv } from "../src/types";
import { createMigrationToken } from "../src/migration-token";
import { createAccessToken } from "../src/session";
import { createServiceJwt, getSigningKeypair } from "../src/service-auth";

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

	describe("credentials allowed to change the identity", () => {
		const serviceDid = `did:web:${env.PDS_HOSTNAME}`;

		afterEach(() => {
			vi.unstubAllGlobals();
		});

		async function oauthToken(scope: string): Promise<string> {
			const accessToken = `oauth-identity-${crypto.randomUUID()}`;
			const stub = env.ACCOUNT.get(env.ACCOUNT.idFromName("account"));
			await (
				await stub.authStore()
			).saveTokens({
				accessToken,
				refreshToken: `refresh-${accessToken}`,
				clientId: "https://example.com/client-metadata.json",
				sub: env.DID,
				scope,
				issuedAt: Date.now(),
				accessExpiresAt: Date.now() + 60_000,
				refreshExpiresAt: Date.now() + 3_600_000,
			});
			return `DPoP ${accessToken}`;
		}

		async function sessionToken(appPassword: boolean): Promise<string> {
			return `Bearer ${await createAccessToken(env.JWT_SECRET, env.DID, serviceDid, { appPassword })}`;
		}

		async function serviceToken(lxm: string): Promise<string> {
			return `Bearer ${await createServiceJwt({
				iss: env.DID,
				aud: serviceDid,
				lxm,
				keypair: await getSigningKeypair(env.SIGNING_KEY),
			})}`;
		}

		function getMigrationToken(authorization: string) {
			return worker.fetch(
				new Request(
					"http://pds.test/xrpc/gg.mk.experimental.getMigrationToken",
					{ headers: { Authorization: authorization } },
				),
				env,
			);
		}

		async function signPlcOperation(authorization: string) {
			return worker.fetch(
				new Request(
					"http://pds.test/xrpc/com.atproto.identity.signPlcOperation",
					{
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							Authorization: authorization,
						},
						body: JSON.stringify({
							token: await createMigrationToken(env.DID, env.JWT_SECRET),
						}),
					},
				),
				env,
			);
		}

		it("allows the static token, a password session and OAuth with identity:*", async () => {
			for (const authorization of [
				`Bearer ${env.AUTH_TOKEN}`,
				await sessionToken(false),
				await oauthToken("atproto identity:*"),
			]) {
				const response = await getMigrationToken(authorization);
				expect(response.status).toBe(200);
			}
		});

		it("refuses app passwords", async () => {
			const authorization = await sessionToken(true);

			const tokenResponse = await getMigrationToken(authorization);
			expect(tokenResponse.status).toBe(403);
			const body = (await tokenResponse.json()) as { message: string };
			expect(body.message).toContain("App passwords");

			expect((await signPlcOperation(authorization)).status).toBe(403);
		});

		it("refuses OAuth tokens without identity:*", async () => {
			for (const scope of [
				"atproto transition:generic",
				"atproto identity:handle",
			]) {
				const authorization = await oauthToken(scope);
				expect((await getMigrationToken(authorization)).status).toBe(403);
				expect((await signPlcOperation(authorization)).status).toBe(403);
			}
		});

		it("refuses service JWTs, even when bound to the method", async () => {
			expect(
				(
					await getMigrationToken(
						await serviceToken("gg.mk.experimental.getMigrationToken"),
					)
				).status,
			).toBe(403);
			expect(
				(
					await signPlcOperation(
						await serviceToken("com.atproto.identity.signPlcOperation"),
					)
				).status,
			).toBe(403);
		});

		it("lets OAuth with identity:* sign a PLC operation", async () => {
			const key = (await Secp256k1Keypair.import(env.SIGNING_KEY)).did();
			vi.stubGlobal(
				"fetch",
				vi.fn(async () =>
					Response.json([
						{
							did: env.DID,
							operation: {
								type: "plc_operation",
								prev: null,
								sig: "c2ln",
								rotationKeys: [key],
								verificationMethods: { atproto: key },
								alsoKnownAs: [],
								services: {},
							},
							cid: "bafyreicurrentop",
							nullified: false,
							createdAt: "2025-01-01T00:00:00.000Z",
						},
					]),
				),
			);

			const response = await signPlcOperation(
				await oauthToken("atproto identity:*"),
			);
			expect(response.status).toBe(200);
		});
	});
});

describe("com.atproto.identity.updateHandle", () => {
	const NEW_HANDLE = "new-handle.example.com";
	const PLC_DID = "did:plc:ewvi7nxzyoun6zhxrhs64oiz";
	const accountStub = () => env.ACCOUNT.get(env.ACCOUNT.idFromName("account"));

	afterEach(async () => {
		vi.unstubAllGlobals();
		// The account DO is shared across test files; drop any stored handle.
		await runInDurableObject(accountStub(), (_instance, state) => {
			state.storage.sql.exec("DELETE FROM account_handle");
		});
	});

	/**
	 * Stub the network: DNS-over-HTTPS TXT lookups, /.well-known/atproto-did,
	 * and plc.directory. Any other request fails the test.
	 */
	function mockNetwork(opts: {
		dns?: Record<string, string>;
		wellKnown?: Record<string, string>;
		plcOperation?: Record<string, unknown>;
		plcPostResponse?: Response;
	}) {
		const posted: Array<Record<string, unknown>> = [];
		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = new URL(input instanceof Request ? input.url : input);
				if (url.origin === "https://cloudflare-dns.com") {
					const name = url.searchParams.get("name")!;
					const did = opts.dns?.[name.replace(/^_atproto\./, "")];
					return Response.json(
						{
							Status: did ? 0 : 3,
							TC: false,
							RD: true,
							RA: true,
							AD: false,
							CD: false,
							Question: [{ name, type: 16 }],
							...(did && {
								Answer: [{ name, type: 16, TTL: 300, data: `"did=${did}"` }],
							}),
						},
						{ headers: { "Content-Type": "application/dns-json" } },
					);
				}
				if (url.pathname === "/.well-known/atproto-did") {
					const did = opts.wellKnown?.[url.hostname];
					return did
						? new Response(did)
						: new Response("Not Found", { status: 404 });
				}
				if (url.origin === "https://plc.directory") {
					if (init?.method === "POST") {
						posted.push(JSON.parse(init.body as string));
						return opts.plcPostResponse ?? new Response(null, { status: 200 });
					}
					if (url.pathname === `/${PLC_DID}/log/audit` && opts.plcOperation) {
						return Response.json([
							{
								did: PLC_DID,
								operation: opts.plcOperation,
								cid: "bafyreicurrentop",
								nullified: false,
								createdAt: new Date().toISOString(),
							},
						]);
					}
					return new Response("Not Found", { status: 404 });
				}
				throw new Error(`Unexpected fetch: ${url}`);
			},
		);
		vi.stubGlobal("fetch", fetchMock);
		return { fetchMock, posted };
	}

	/**
	 * POST updateHandle. With a custom `env` the Hono app is called directly,
	 * since the worker export always runs with the configured bindings.
	 */
	function updateHandle(
		body: unknown,
		opts: { env?: PDSEnv; headers?: Record<string, string> } = {},
	) {
		const request = new Request(
			"http://pds.test/xrpc/com.atproto.identity.updateHandle",
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					...(opts.headers ?? { Authorization: `Bearer ${env.AUTH_TOKEN}` }),
				},
				body: JSON.stringify(body),
			},
		);
		return opts.env ? app.fetch(request, opts.env) : worker.fetch(request, env);
	}

	async function latestIdentityEvent(): Promise<{
		did: string;
		handle?: string;
	}> {
		return runInDurableObject(accountStub(), (_instance, state) => {
			const row = state.storage.sql
				.exec(
					"SELECT payload FROM firehose_events WHERE event_type = 'identity' ORDER BY seq DESC LIMIT 1",
				)
				.one();
			return decode(new Uint8Array(row.payload as ArrayBuffer)) as {
				did: string;
				handle?: string;
			};
		});
	}

	async function signingDid(): Promise<string> {
		return (await Secp256k1Keypair.import(env.SIGNING_KEY)).did();
	}

	it("requires authentication", async () => {
		const response = await updateHandle(
			{ handle: NEW_HANDLE },
			{ headers: {} },
		);
		expect(response.status).toBe(401);
	});

	it("refuses service JWTs, even when bound to the method", async () => {
		mockNetwork({ dns: { [NEW_HANDLE]: env.DID } });
		const jwt = await createServiceJwt({
			iss: env.DID,
			aud: `did:web:${env.PDS_HOSTNAME}`,
			lxm: "com.atproto.identity.updateHandle",
			keypair: await getSigningKeypair(env.SIGNING_KEY),
		});

		const response = await updateHandle(
			{ handle: NEW_HANDLE },
			{ headers: { Authorization: `Bearer ${jwt}` } },
		);
		expect(response.status).toBe(403);

		await runInDurableObject(accountStub(), async (instance) => {
			expect((await instance.account()).getHandle(env.HANDLE)).toBe(env.HANDLE);
		});
	});

	it("accepts app passwords, like the reference PDS", async () => {
		mockNetwork({ dns: { [NEW_HANDLE]: env.DID } });
		const token = await createAccessToken(
			env.JWT_SECRET,
			env.DID,
			`did:web:${env.PDS_HOSTNAME}`,
			{ appPassword: true },
		);

		const response = await updateHandle(
			{ handle: NEW_HANDLE },
			{ headers: { Authorization: `Bearer ${token}` } },
		);
		expect(response.status).toBe(200);
	});

	it("rejects a missing handle", async () => {
		const response = await updateHandle({});
		expect(response.status).toBe(400);
		const body = (await response.json()) as { error: string };
		expect(body.error).toBe("InvalidRequest");
	});

	it("rejects an invalid handle", async () => {
		const response = await updateHandle({ handle: "not a handle" });
		expect(response.status).toBe(400);
		const body = (await response.json()) as { error: string };
		expect(body.error).toBe("InvalidHandle");
	});

	it("rejects a disallowed TLD without resolving it", async () => {
		const { fetchMock } = mockNetwork({});
		const response = await updateHandle({ handle: "alice.local" });
		expect(response.status).toBe(400);
		const body = (await response.json()) as { error: string };
		expect(body.error).toBe("InvalidHandle");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("rejects a handle that does not resolve to this DID", async () => {
		mockNetwork({ dns: { [NEW_HANDLE]: "did:plc:someoneelse234567abcdefg" } });
		const response = await updateHandle({ handle: NEW_HANDLE });
		expect(response.status).toBe(400);
		const body = (await response.json()) as { error: string; message: string };
		expect(body.error).toBe("InvalidRequest");
		expect(body.message).toContain(`_atproto.${NEW_HANDLE}`);

		await runInDurableObject(accountStub(), async (instance) => {
			expect((await instance.account()).getHandle(env.HANDLE)).toBe(env.HANDLE);
		});
	});

	it("updates the handle everywhere for a did:web account", async () => {
		mockNetwork({ dns: { [NEW_HANDLE]: env.DID } });

		// Clients may send mixed case; handles are stored lowercased.
		const response = await updateHandle({ handle: "New-Handle.Example.com" });
		expect(response.status).toBe(200);

		const didDoc = (await (
			await worker.fetch(
				new Request("http://pds.test/.well-known/did.json"),
				env,
			)
		).json()) as { alsoKnownAs: string[] };
		expect(didDoc.alsoKnownAs).toEqual([`at://${NEW_HANDLE}`]);

		const described = (await (
			await worker.fetch(
				new Request(
					`http://pds.test/xrpc/com.atproto.repo.describeRepo?repo=${env.DID}`,
				),
				env,
			)
		).json()) as { handle: string };
		expect(described.handle).toBe(NEW_HANDLE);

		const resolved = (await (
			await worker.fetch(
				new Request(
					`http://pds.test/xrpc/com.atproto.identity.resolveHandle?handle=${NEW_HANDLE}`,
				),
				env,
			)
		).json()) as { did: string };
		expect(resolved.did).toBe(env.DID);

		const session = await worker.fetch(
			new Request("http://pds.test/xrpc/com.atproto.server.createSession", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					identifier: NEW_HANDLE,
					password: "test-password",
				}),
			}),
			env,
		);
		expect(session.status).toBe(200);
		expect(((await session.json()) as { handle: string }).handle).toBe(
			NEW_HANDLE,
		);

		const oldSession = await worker.fetch(
			new Request("http://pds.test/xrpc/com.atproto.server.createSession", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					identifier: env.HANDLE,
					password: "test-password",
				}),
			}),
			env,
		);
		expect(oldSession.status).toBe(401);

		expect(await latestIdentityEvent()).toMatchObject({
			did: env.DID,
			handle: NEW_HANDLE,
		});
	});

	it("accepts a handle verified by /.well-known/atproto-did", async () => {
		mockNetwork({ wellKnown: { [NEW_HANDLE]: env.DID } });
		const response = await updateHandle({ handle: NEW_HANDLE });
		expect(response.status).toBe(200);
	});

	it("accepts the PDS hostname without looking it up", async () => {
		const { fetchMock } = mockNetwork({});
		const response = await updateHandle({ handle: env.PDS_HOSTNAME });
		expect(response.status).toBe(200);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("lets a changed HANDLE var take precedence over a stored handle", async () => {
		await runInDurableObject(accountStub(), async (instance) => {
			const store = await instance.account();
			store.setHandle(NEW_HANDLE, env.HANDLE);
			expect(store.getHandle(env.HANDLE)).toBe(NEW_HANDLE);
			expect(store.getHandle("redeployed.example.com")).toBe(
				"redeployed.example.com",
			);
		});
	});

	describe("did:plc accounts", () => {
		const plcEnv = { ...env, DID: PLC_DID } as PDSEnv;

		async function currentOperation(
			overrides: Record<string, unknown> = {},
		): Promise<Record<string, unknown>> {
			const key = await signingDid();
			return {
				type: "plc_operation",
				prev: null,
				rotationKeys: ["did:key:zQ3shRecoveryKeyExample", key],
				verificationMethods: { atproto: key },
				alsoKnownAs: ["at://old-handle.example.com", "https://example.com/me"],
				services: {
					atproto_pds: {
						type: "AtprotoPersonalDataServer",
						endpoint: `https://${env.PDS_HOSTNAME}`,
					},
				},
				sig: "c2ln",
				...overrides,
			};
		}

		it("writes the new handle to the PLC directory, signed with the signing key", async () => {
			const current = await currentOperation();
			const { posted } = mockNetwork({
				dns: { [NEW_HANDLE]: PLC_DID },
				plcOperation: current,
			});

			const response = await updateHandle(
				{ handle: NEW_HANDLE },
				{ env: plcEnv },
			);
			expect(response.status).toBe(200);
			expect(posted).toHaveLength(1);

			const { sig, ...unsigned } = posted[0]!;
			expect(unsigned).toEqual({
				type: "plc_operation",
				prev: "bafyreicurrentop",
				rotationKeys: current.rotationKeys,
				verificationMethods: current.verificationMethods,
				alsoKnownAs: [`at://${NEW_HANDLE}`, "https://example.com/me"],
				services: current.services,
			});
			expect(
				await verifySignature(
					await signingDid(),
					encode(unsigned),
					base64url.decode(sig as string),
				),
			).toBe(true);

			await runInDurableObject(accountStub(), async (instance) => {
				expect((await instance.account()).getHandle(env.HANDLE)).toBe(
					NEW_HANDLE,
				);
			});
		});

		it("skips the PLC update when the directory already has the handle", async () => {
			const { posted } = mockNetwork({
				dns: { [NEW_HANDLE]: PLC_DID },
				plcOperation: await currentOperation({
					alsoKnownAs: [`at://${NEW_HANDLE}`],
				}),
			});

			const response = await updateHandle(
				{ handle: NEW_HANDLE },
				{ env: plcEnv },
			);
			expect(response.status).toBe(200);
			expect(posted).toHaveLength(0);
		});

		it("adds the handle when alsoKnownAs has no at:// entry", async () => {
			const { posted } = mockNetwork({
				dns: { [NEW_HANDLE]: PLC_DID },
				plcOperation: await currentOperation({
					alsoKnownAs: ["https://example.com/me"],
				}),
			});

			const response = await updateHandle(
				{ handle: NEW_HANDLE },
				{ env: plcEnv },
			);
			expect(response.status).toBe(200);
			expect(posted[0]?.alsoKnownAs).toEqual([
				`at://${NEW_HANDLE}`,
				"https://example.com/me",
			]);
		});

		it("does not duplicate the handle when alsoKnownAs already lists it later", async () => {
			const { posted } = mockNetwork({
				dns: { [NEW_HANDLE]: PLC_DID },
				plcOperation: await currentOperation({
					alsoKnownAs: ["at://old-handle.example.com", `at://${NEW_HANDLE}`],
				}),
			});

			const response = await updateHandle(
				{ handle: NEW_HANDLE },
				{ env: plcEnv },
			);
			expect(response.status).toBe(200);
			expect(posted[0]?.alsoKnownAs).toEqual([`at://${NEW_HANDLE}`]);
		});

		it("does not store the handle when the PLC state cannot be fetched", async () => {
			const { posted } = mockNetwork({ dns: { [NEW_HANDLE]: PLC_DID } });

			const response = await updateHandle(
				{ handle: NEW_HANDLE },
				{ env: plcEnv },
			);
			expect(response.status).toBe(500);
			expect(posted).toHaveLength(0);

			await runInDurableObject(accountStub(), async (instance) => {
				expect((await instance.account()).getHandle(env.HANDLE)).toBe(
					env.HANDLE,
				);
			});
		});

		it("refuses when the signing key is not a rotation key", async () => {
			const { posted } = mockNetwork({
				dns: { [NEW_HANDLE]: PLC_DID },
				plcOperation: await currentOperation({
					rotationKeys: ["did:key:zQ3shSomeoneElsesKeyExample"],
				}),
			});

			const response = await updateHandle(
				{ handle: NEW_HANDLE },
				{ env: plcEnv },
			);
			expect(response.status).toBe(400);
			const body = (await response.json()) as { message: string };
			expect(body.message).toContain("not a rotation key");
			expect(body.message).toContain("pds rotation-keys");
			expect(posted).toHaveLength(0);

			await runInDurableObject(accountStub(), async (instance) => {
				expect((await instance.account()).getHandle(env.HANDLE)).toBe(
					env.HANDLE,
				);
			});
		});

		it("does not store the handle when the PLC directory rejects the update", async () => {
			mockNetwork({
				dns: { [NEW_HANDLE]: PLC_DID },
				plcOperation: await currentOperation(),
				plcPostResponse: new Response("invalid signature", { status: 400 }),
			});

			const response = await updateHandle(
				{ handle: NEW_HANDLE },
				{ env: plcEnv },
			);
			expect(response.status).toBe(400);
			const body = (await response.json()) as { error: string };
			expect(body.error).toBe("PlcDirectoryError");

			await runInDurableObject(accountStub(), async (instance) => {
				expect((await instance.account()).getHandle(env.HANDLE)).toBe(
					env.HANDLE,
				);
			});
		});
	});

	describe("OAuth scopes", () => {
		async function oauthRequest(scope: string, accessToken: string) {
			const kp = (await crypto.subtle.generateKey(
				{ name: "ECDSA", namedCurve: "P-256" },
				true,
				["sign", "verify"],
			)) as CryptoKeyPair;
			const publicJwk = (await crypto.subtle.exportKey(
				"jwk",
				kp.publicKey,
			)) as JWK;
			delete publicJwk.key_ops;
			delete publicJwk.ext;
			const dpopJkt = await calculateJwkThumbprint(publicJwk, "sha256");

			await runInDurableObject(
				accountStub(),
				async (instance: AccountDurableObject) => {
					await (
						await instance.authStore()
					).saveTokens({
						accessToken,
						refreshToken: `refresh-${accessToken}`,
						clientId: "did:web:client.example.com",
						sub: env.DID,
						scope,
						dpopJkt,
						issuedAt: Date.now(),
						accessExpiresAt: Date.now() + 3600_000,
						refreshExpiresAt: Date.now() + 90 * 24 * 3600_000,
					});
				},
			);

			const url = "http://pds.test/xrpc/com.atproto.identity.updateHandle";
			const ath = base64url.encode(
				new Uint8Array(
					await crypto.subtle.digest(
						"SHA-256",
						new TextEncoder().encode(accessToken),
					),
				),
			);
			const dpop = await new SignJWT({ htm: "POST", htu: url, ath })
				.setProtectedHeader({
					typ: "dpop+jwt",
					alg: "ES256",
					jwk: publicJwk,
				})
				.setIssuedAt()
				.setJti(base64url.encode(crypto.getRandomValues(new Uint8Array(16))))
				.sign(kp.privateKey);

			return updateHandle(
				{ handle: NEW_HANDLE },
				{ headers: { Authorization: `DPoP ${accessToken}`, DPoP: dpop } },
			);
		}

		it("rejects a token without identity:handle", async () => {
			mockNetwork({ dns: { [NEW_HANDLE]: env.DID } });
			const response = await oauthRequest(
				"atproto transition:generic",
				"tok-update-handle-generic",
			);
			expect(response.status).toBe(403);
			const body = (await response.json()) as { error: string };
			expect(body.error).toBe("InsufficientScope");
		});

		it("accepts a token with identity:handle", async () => {
			mockNetwork({ dns: { [NEW_HANDLE]: env.DID } });
			const response = await oauthRequest(
				"atproto identity:handle",
				"tok-update-handle-identity",
			);
			expect(response.status).toBe(200);
		});
	});
});
