import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { Context } from "hono";
import { Secp256k1Keypair } from "@atproto/crypto";
import {
	LtHash,
	createDpopProof,
	createSpaceToken,
	spaceHostAud,
	verifyCommit,
	verifyRepoCarFull,
} from "@atproto/space";
import type { SignedCommit } from "@atproto/space";
import { JoseKey } from "@atproto/jwk-jose";
import { fromBase64 } from "@atproto/lex-data";
import { create as createCid, CODEC_RAW, toString as cidToString } from "@atcute/cid";
import { createSpaceRoutes } from "../src/routes";
import type { SpaceRoutesHost, SpaceScopeMatch } from "../src/routes";
import { TEST_OPERATOR_DID, TEST_SIGNING_KEY } from "./fixtures/spaces-worker/index";

const OPERATOR = TEST_OPERATOR_DID;
const BOB = "did:web:bob.test";
const ORIGIN = "https://pds.test";

const operatorKeypair = await Secp256k1Keypair.import(TEST_SIGNING_KEY);
const bobKeypair = await Secp256k1Keypair.create();

/** did → did:key registry standing in for DID-document resolution. */
const signingKeys = new Map<string, string>([
	[OPERATOR, operatorKeypair.did()],
	[BOB, bobKeypair.did()],
]);

interface OutboundCall {
	url: string;
	init?: RequestInit;
}

function makeHost(overrides: Partial<SpaceRoutesHost> = {}): {
	host: SpaceRoutesHost;
	outbound: OutboundCall[];
	setOutboundResponse(fn: (url: string) => Response | null): void;
} {
	const outbound: OutboundCall[] = [];
	let responder: (url: string) => Response | null = () => null;
	const host: SpaceRoutesHost = {
		operatorDid: OPERATOR,
		publicOrigin: ORIGIN,
		blobs: env.BLOBS,
		getKeypair: async () => operatorKeypair,
		getSigningKey: async (iss) => {
			const key = signingKeys.get(iss);
			if (!key) throw new Error(`Unknown issuer: ${iss}`);
			return key;
		},
		resolveServiceEndpoint: async (service) =>
			`https://${service.split("#")[0]!.replace("did:web:", "")}`,
		resolveAuthorityEndpoint: async (did) =>
			`https://${did.replace("did:web:", "")}`,
		// Trusted test double: decodes the payload without signature checks.
		// The real implementation lives in the host PDS.
		verifyServiceJwt: async (token, lxm) => {
			const payload = JSON.parse(
				atob(token.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/")),
			) as { iss: string; aud: string; lxm?: string };
			if (payload.lxm !== lxm) throw new Error("lxm mismatch");
			return { iss: payload.iss, aud: payload.aud };
		},
		authenticate: async (c: Context) => {
			const auth = c.req.header("Authorization");
			if (auth === "Bearer operator-session") {
				return {
					did: OPERATOR,
					fullTrust: true,
					allowsSpace: () => true,
				};
			}
			if (auth?.startsWith("Bearer scoped:")) {
				// "Bearer scoped:<json>" — an OAuth session allowing exactly
				// the encoded matches.
				const allowed = JSON.parse(auth.slice("Bearer scoped:".length)) as {
					actions?: string[];
					manage?: string[];
				};
				return {
					did: OPERATOR,
					fullTrust: false,
					allowsSpace: (m: SpaceScopeMatch) =>
						"manage" in m && m.manage
							? (allowed.manage ?? []).includes(m.manage)
							: (allowed.actions ?? []).includes(
									(m as { action: string }).action,
								),
				};
			}
			return c.json(
				{ error: "AuthenticationRequired", message: "No session" },
				401,
			);
		},
		validateRecord: ({ record }) => ({ record, status: "unknown" }),
		getSpaceDO: (uri) =>
			env.SPACES.get(env.SPACES.idFromName(uri)) as never,
		getIndexDO: () =>
			env.SPACES_INDEX.get(env.SPACES_INDEX.idFromName("spaces")) as never,
		outboundFetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
			outbound.push({ url: String(input), init });
			return responder(String(input)) ?? new Response("{}", { status: 200 });
		}) as typeof fetch,
		...overrides,
	};
	return {
		host,
		outbound,
		setOutboundResponse: (fn) => {
			responder = fn;
		},
	};
}

const { host } = makeHost();
const app = createSpaceRoutes(host);

let spaceN = 0;
async function createSpace(
	policy: Record<string, unknown> = {
		$type: "com.atproto.simplespace.defs#memberListPolicy",
	},
	appAccess: Record<string, unknown> = {
		$type: "com.atproto.simplespace.defs#open",
	},
): Promise<string> {
	const res = await app.request("/xrpc/com.atproto.simplespace.createSpace", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: "Bearer operator-session",
		},
		body: JSON.stringify({
			type: "app.bsky.group",
			skey: `route${spaceN++}x`,
			policy,
			appAccess,
		}),
	});
	expect(res.status).toBe(200);
	const { uri } = (await res.json()) as { uri: string };
	return uri;
}

async function createRecord(
	space: string,
	record: Record<string, unknown>,
	rkey?: string,
): Promise<{ uri: string; cid: string }> {
	const res = await app.request("/xrpc/com.atproto.space.createRecord", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: "Bearer operator-session",
		},
		body: JSON.stringify({
			space,
			repo: OPERATOR,
			collection: "app.bsky.feed.post",
			...(rkey ? { rkey } : {}),
			record,
		}),
	});
	expect(res.status).toBe(200);
	return (await res.json()) as { uri: string; cid: string };
}

/** Mint a delegation token + DPoP-bound credential for `user`. */
async function obtainCredential(
	space: string,
	userKeypair: Secp256k1Keypair,
	userDid: string,
): Promise<{ credential: string; dpopKey: JoseKey; status: number; body: unknown }> {
	const dpopKey = await JoseKey.generate(["ES256"]);
	const delegation = await createSpaceToken(
		"delegation",
		{ iss: userDid, sub: space, aud: spaceHostAud(OPERATOR) },
		userKeypair,
	);
	const proof = await createDpopProof(dpopKey, {
		htm: "POST",
		htu: `${ORIGIN}/xrpc/com.atproto.space.getSpaceCredential`,
	});
	const res = await app.request("/xrpc/com.atproto.space.getSpaceCredential", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${delegation}`,
			DPoP: proof,
		},
		body: JSON.stringify({ space }),
	});
	const body = (await res.json()) as { credential?: string };
	return {
		credential: body.credential ?? "",
		dpopKey,
		status: res.status,
		body,
	};
}

/** Perform a credential-authenticated GET. */
async function credentialGet(
	path: string,
	credential: string,
	dpopKey: JoseKey,
): Promise<Response> {
	const proof = await createDpopProof(dpopKey, {
		htm: "GET",
		htu: `${ORIGIN}${path.split("?")[0]}`,
		credential,
	});
	return app.request(path, {
		headers: {
			Authorization: `DPoP ${credential}`,
			DPoP: proof,
		},
	});
}

function commitFromJson(json: Record<string, unknown>): SignedCommit {
	const bytes = (field: string) =>
		fromBase64((json[field] as { $bytes: string }).$bytes);
	return {
		ver: json.ver as 1,
		hash: bytes("hash"),
		ikm: bytes("ikm"),
		sig: bytes("sig"),
		mac: bytes("mac"),
		rev: json.rev as string,
	};
}

describe("space routes: personal data (S1)", () => {
	it("creates a space, writes and reads records with a session", async () => {
		const space = await createSpace();
		const created = await createRecord(space, {
			$type: "app.bsky.feed.post",
			text: "hello spaces",
		});
		expect(created.uri).toBe(
			`${space}/${OPERATOR}/app.bsky.feed.post/${created.uri.split("/").pop()}`,
		);

		const rkey = created.uri.split("/").pop()!;
		const res = await app.request(
			`/xrpc/com.atproto.space.getRecord?space=${encodeURIComponent(space)}&repo=${OPERATOR}&collection=app.bsky.feed.post&rkey=${rkey}`,
			{ headers: { Authorization: "Bearer operator-session" } },
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { value: { text: string }; cid: string };
		expect(body.value.text).toBe("hello spaces");
		expect(body.cid).toBe(created.cid);
	});

	it("refuses an unauthenticated getRecord", async () => {
		const space = await createSpace();
		await createRecord(space, { $type: "app.bsky.feed.post", text: "x" }, "aaa");
		const res = await app.request(
			`/xrpc/com.atproto.space.getRecord?space=${encodeURIComponent(space)}&repo=${OPERATOR}&collection=app.bsky.feed.post&rkey=aaa`,
		);
		expect(res.status).toBe(401);
	});

	it("returns RepoNotFound for a repo that is not the operator", async () => {
		const space = await createSpace();
		const res = await app.request(
			`/xrpc/com.atproto.space.getRecord?space=${encodeURIComponent(space)}&repo=${BOB}&collection=app.bsky.feed.post&rkey=aaa`,
			{ headers: { Authorization: "Bearer operator-session" } },
		);
		expect(res.status).toBe(404);
		expect(((await res.json()) as { error: string }).error).toBe(
			"RepoNotFound",
		);
	});

	it("requires createSpace before writing into an own-authority space", async () => {
		const res = await app.request("/xrpc/com.atproto.space.createRecord", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer operator-session",
			},
			body: JSON.stringify({
				space: `at://${OPERATOR}/space/app.bsky.group/nevercreated`,
				repo: OPERATOR,
				collection: "app.bsky.feed.post",
				record: { $type: "app.bsky.feed.post", text: "x" },
			}),
		});
		expect(res.status).toBe(404);
		expect(((await res.json()) as { error: string }).error).toBe(
			"SpaceNotFound",
		);
	});

	it("enforces scoped sessions on writes and reads", async () => {
		const space = await createSpace();
		// Write-only scope cannot read.
		const writeOnly = `Bearer scoped:${JSON.stringify({ actions: ["create"] })}`;
		const write = await app.request("/xrpc/com.atproto.space.createRecord", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: writeOnly,
			},
			body: JSON.stringify({
				space,
				repo: OPERATOR,
				collection: "app.bsky.feed.post",
				rkey: "scoped",
				record: { $type: "app.bsky.feed.post", text: "x" },
			}),
		});
		expect(write.status).toBe(200);

		const read = await app.request(
			`/xrpc/com.atproto.space.getRecord?space=${encodeURIComponent(space)}&repo=${OPERATOR}&collection=app.bsky.feed.post&rkey=scoped`,
			{ headers: { Authorization: writeOnly } },
		);
		expect(read.status).toBe(403);

		const readOnly = `Bearer scoped:${JSON.stringify({ actions: ["read_self"] })}`;
		const read2 = await app.request(
			`/xrpc/com.atproto.space.getRecord?space=${encodeURIComponent(space)}&repo=${OPERATOR}&collection=app.bsky.feed.post&rkey=scoped`,
			{ headers: { Authorization: readOnly } },
		);
		expect(read2.status).toBe(200);

		const denyWrite = await app.request("/xrpc/com.atproto.space.createRecord", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: readOnly,
			},
			body: JSON.stringify({
				space,
				repo: OPERATOR,
				collection: "app.bsky.feed.post",
				record: { $type: "app.bsky.feed.post", text: "x" },
			}),
		});
		expect(denyWrite.status).toBe(403);
	});

	it("applyWrites returns typed results in order", async () => {
		const space = await createSpace();
		await createRecord(space, { $type: "app.bsky.feed.post", text: "d" }, "del");
		const res = await app.request("/xrpc/com.atproto.space.applyWrites", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer operator-session",
			},
			body: JSON.stringify({
				space,
				repo: OPERATOR,
				writes: [
					{
						$type: "com.atproto.space.applyWrites#create",
						collection: "app.bsky.feed.post",
						rkey: "batch1",
						value: { $type: "app.bsky.feed.post", text: "one" },
					},
					{
						$type: "com.atproto.space.applyWrites#delete",
						collection: "app.bsky.feed.post",
						rkey: "del",
					},
				],
			}),
		});
		expect(res.status).toBe(200);
		const { results } = (await res.json()) as {
			results: Array<{ $type: string; uri?: string }>;
		};
		expect(results[0]?.$type).toBe("com.atproto.space.applyWrites#createResult");
		expect(results[0]?.uri).toContain("/app.bsky.feed.post/batch1");
		expect(results[1]?.$type).toBe("com.atproto.space.applyWrites#deleteResult");
	});

	it("putRecord upserts and deleteRecord is idempotent", async () => {
		const space = await createSpace();
		const put = async (text: string) =>
			app.request("/xrpc/com.atproto.space.putRecord", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: "Bearer operator-session",
				},
				body: JSON.stringify({
					space,
					repo: OPERATOR,
					collection: "app.bsky.feed.post",
					rkey: "upsert",
					record: { $type: "app.bsky.feed.post", text },
				}),
			});
		const first = await put("v1");
		expect(first.status).toBe(200);
		const second = await put("v2");
		expect(second.status).toBe(200);
		const firstCid = ((await first.json()) as { cid: string }).cid;
		const secondCid = ((await second.json()) as { cid: string }).cid;
		expect(secondCid).not.toBe(firstCid);

		const del = async () =>
			app.request("/xrpc/com.atproto.space.deleteRecord", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: "Bearer operator-session",
				},
				body: JSON.stringify({
					space,
					repo: OPERATOR,
					collection: "app.bsky.feed.post",
					rkey: "upsert",
				}),
			});
		expect((await del()).status).toBe(200);
		// Deleting again succeeds silently.
		expect((await del()).status).toBe(200);
	});
});

describe("space routes: credentials (S5)", () => {
	it("issues, gates and revokes space credentials", async () => {
		const space = await createSpace();
		await createRecord(space, { $type: "app.bsky.feed.post", text: "m" }, "mem");

		// Not a member yet: UserNotAuthorized.
		const refused = await obtainCredential(space, bobKeypair, BOB);
		expect(refused.status).toBe(403);
		expect((refused.body as { error: string }).error).toBe("UserNotAuthorized");

		// Add bob, obtain a credential.
		const add = await app.request("/xrpc/com.atproto.simplespace.addMember", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer operator-session",
			},
			body: JSON.stringify({ space, did: BOB }),
		});
		expect(add.status).toBe(200);

		const granted = await obtainCredential(space, bobKeypair, BOB);
		expect(granted.status).toBe(200);
		expect(granted.credential).toBeTruthy();

		// The credential reads the space.
		const read = await credentialGet(
			`/xrpc/com.atproto.space.getRecord?space=${encodeURIComponent(space)}&repo=${OPERATOR}&collection=app.bsky.feed.post&rkey=mem`,
			granted.credential,
			granted.dpopKey,
		);
		expect(read.status).toBe(200);

		// Remove bob: next credential request fails, but the existing
		// credential still works until expiry.
		await app.request("/xrpc/com.atproto.simplespace.removeMember", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer operator-session",
			},
			body: JSON.stringify({ space, did: BOB }),
		});
		const refusedAgain = await obtainCredential(space, bobKeypair, BOB);
		expect(refusedAgain.status).toBe(403);
		expect((refusedAgain.body as { error: string }).error).toBe(
			"UserNotAuthorized",
		);

		const stillReads = await credentialGet(
			`/xrpc/com.atproto.space.getRecord?space=${encodeURIComponent(space)}&repo=${OPERATOR}&collection=app.bsky.feed.post&rkey=mem`,
			granted.credential,
			granted.dpopKey,
		);
		expect(stillReads.status).toBe(200);
	});

	it("rejects a replayed delegation token", async () => {
		const space = await createSpace({
			$type: "com.atproto.simplespace.defs#publicPolicy",
		});
		const dpopKey = await JoseKey.generate(["ES256"]);
		const delegation = await createSpaceToken(
			"delegation",
			{ iss: BOB, sub: space, aud: spaceHostAud(OPERATOR) },
			bobKeypair,
		);
		const request = async () => {
			const proof = await createDpopProof(dpopKey, {
				htm: "POST",
				htu: `${ORIGIN}/xrpc/com.atproto.space.getSpaceCredential`,
			});
			return app.request("/xrpc/com.atproto.space.getSpaceCredential", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${delegation}`,
					DPoP: proof,
				},
				body: JSON.stringify({ space }),
			});
		};
		expect((await request()).status).toBe(200);
		const replayed = await request();
		expect(replayed.status).toBe(401);
		expect(((await replayed.json()) as { error: string }).error).toBe(
			"InvalidDelegationToken",
		);
	});

	it("rejects a replayed DPoP proof and a cross-space credential", async () => {
		const spaceA = await createSpace({
			$type: "com.atproto.simplespace.defs#publicPolicy",
		});
		const spaceB = await createSpace({
			$type: "com.atproto.simplespace.defs#publicPolicy",
		});
		await createRecord(spaceA, { $type: "app.bsky.feed.post", text: "a" }, "ra");
		await createRecord(spaceB, { $type: "app.bsky.feed.post", text: "b" }, "rb");

		const granted = await obtainCredential(spaceA, bobKeypair, BOB);
		expect(granted.status).toBe(200);

		const path = `/xrpc/com.atproto.space.getRecord?space=${encodeURIComponent(spaceA)}&repo=${OPERATOR}&collection=app.bsky.feed.post&rkey=ra`;
		const proof = await createDpopProof(granted.dpopKey, {
			htm: "GET",
			htu: `${ORIGIN}/xrpc/com.atproto.space.getRecord`,
			credential: granted.credential,
		});
		const headers = {
			Authorization: `DPoP ${granted.credential}`,
			DPoP: proof,
		};
		expect((await app.request(path, { headers })).status).toBe(200);
		// Same proof again: replayed.
		const replayed = await app.request(path, { headers });
		expect(replayed.status).toBe(401);

		// Credential for space A cannot read space B.
		const cross = await credentialGet(
			`/xrpc/com.atproto.space.getRecord?space=${encodeURIComponent(spaceB)}&repo=${OPERATOR}&collection=app.bsky.feed.post&rkey=rb`,
			granted.credential,
			granted.dpopKey,
		);
		expect(cross.status).toBe(401);
	});

	it("gates on the app allowList with client attestations", async () => {
		const clientId = "https://app.test/client-metadata.json";
		const clientKey = await JoseKey.generate(["ES256"], "client-key-1");
		const { host: attHost, setOutboundResponse } = makeHost();
		// Publish a clean JWKS entry (kty/crv/x/y/kid/alg): key_ops from the
		// generated key would be rejected by workerd's ECDSA import.
		const clientJwk = {
			...clientKey.bareJwk,
			kid: clientKey.kid,
			alg: "ES256",
		};
		setOutboundResponse((url) => {
			if (url === clientId) {
				return Response.json({ jwks: { keys: [clientJwk] } });
			}
			return null;
		});
		const attApp = createSpaceRoutes(attHost);

		const createRes = await attApp.request(
			"/xrpc/com.atproto.simplespace.createSpace",
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: "Bearer operator-session",
				},
				body: JSON.stringify({
					type: "app.bsky.group",
					skey: "attested",
					policy: { $type: "com.atproto.simplespace.defs#publicPolicy" },
					appAccess: {
						$type: "com.atproto.simplespace.defs#allowList",
						allowed: [clientId],
					},
				}),
			},
		);
		expect(createRes.status).toBe(200);
		const { uri: space } = (await createRes.json()) as { uri: string };

		const dpopKey = await JoseKey.generate(["ES256"]);
		const requestCredential = async (attestation?: string) => {
			const delegation = await createSpaceToken(
				"delegation",
				{ iss: BOB, sub: space, aud: spaceHostAud(OPERATOR) },
				bobKeypair,
			);
			const proof = await createDpopProof(dpopKey, {
				htm: "POST",
				htu: `${ORIGIN}/xrpc/com.atproto.space.getSpaceCredential`,
			});
			return attApp.request("/xrpc/com.atproto.space.getSpaceCredential", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${delegation}`,
					DPoP: proof,
				},
				body: JSON.stringify({
					space,
					...(attestation ? { clientAttestation: attestation } : {}),
				}),
			});
		};

		// No attestation: refused on the app perimeter.
		const missing = await requestCredential();
		expect(missing.status).toBe(403);
		expect(((await missing.json()) as { error: string }).error).toBe(
			"AppNotAuthorized",
		);

		// Valid attestation from the allowed client.
		const makeAttestation = async (iss: string) =>
			clientKey.createJwt(
				{
					alg: "ES256",
					typ: "atproto-client-attestation+jwt",
					kid: clientKey.kid,
				},
				{
					iss,
					sub: iss,
					aud: spaceHostAud(OPERATOR),
					jti: crypto.randomUUID(),
					iat: Math.floor(Date.now() / 1000),
					exp: Math.floor(Date.now() / 1000) + 60,
				},
			);
		const granted = await requestCredential(await makeAttestation(clientId));
		expect(granted.status).toBe(200);

		// An attested client that is not on the list is refused.
		const otherId = "https://other.test/client-metadata.json";
		setOutboundResponse((url) =>
			url === otherId || url === clientId
				? Response.json({ jwks: { keys: [clientJwk] } })
				: null,
		);
		const wrongClient = await requestCredential(
			await makeAttestation(otherId),
		);
		expect(wrongClient.status).toBe(403);
		expect(((await wrongClient.json()) as { error: string }).error).toBe(
			"AppNotAuthorized",
		);
	});

	it("consults the managing app and denies on failure", async () => {
		const managingApp = "did:web:forum.test#forum";
		const { host: maHost, outbound, setOutboundResponse } = makeHost();
		const maApp = createSpaceRoutes(maHost);
		const createRes = await maApp.request(
			"/xrpc/com.atproto.simplespace.createSpace",
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: "Bearer operator-session",
				},
				body: JSON.stringify({
					type: "app.bsky.group",
					skey: "managed",
					policy: {
						$type: "com.atproto.simplespace.defs#managingAppPolicy",
						managingApp,
					},
					appAccess: { $type: "com.atproto.simplespace.defs#open" },
				}),
			},
		);
		const { uri: space } = (await createRes.json()) as { uri: string };

		setOutboundResponse((url) =>
			url.includes("checkUserAccess")
				? Response.json({ authorized: true })
				: null,
		);
		const dpopKey = await JoseKey.generate(["ES256"]);
		const request = async () => {
			const delegation = await createSpaceToken(
				"delegation",
				{ iss: BOB, sub: space, aud: spaceHostAud(OPERATOR) },
				bobKeypair,
			);
			const proof = await createDpopProof(dpopKey, {
				htm: "POST",
				htu: `${ORIGIN}/xrpc/com.atproto.space.getSpaceCredential`,
			});
			return maApp.request("/xrpc/com.atproto.space.getSpaceCredential", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${delegation}`,
					DPoP: proof,
				},
				body: JSON.stringify({ space }),
			});
		};
		expect((await request()).status).toBe(200);
		const call = outbound.find((o) => o.url.includes("checkUserAccess"));
		expect(call?.url).toContain(`user=${encodeURIComponent(BOB)}`);

		// The managing app saying no (or erroring) denies.
		setOutboundResponse((url) =>
			url.includes("checkUserAccess")
				? Response.json({ authorized: false })
				: null,
		);
		expect((await request()).status).toBe(403);
	});
});

describe("space routes: sync (S2-S4)", () => {
	it("serves a verifiable signed commit", async () => {
		const space = await createSpace();
		await createRecord(space, { $type: "app.bsky.feed.post", text: "c" }, "c1");
		const res = await app.request(
			`/xrpc/com.atproto.space.getLatestCommit?space=${encodeURIComponent(space)}&repo=${OPERATOR}`,
			{ headers: { Authorization: "Bearer operator-session" } },
		);
		expect(res.status).toBe(200);
		const { commit } = (await res.json()) as {
			commit: Record<string, unknown>;
		};
		const signed = commitFromJson(commit);
		expect(
			await verifyCommit(
				signed,
				{ space, author: OPERATOR, rev: signed.rev },
				operatorKeypair.did(),
			),
		).toBe(true);
	});

	it("lets a syncer follow listRepoOps to a matching hash", async () => {
		const space = await createSpace();
		await createRecord(space, { $type: "app.bsky.feed.post", text: "1" }, "s1");
		await createRecord(space, { $type: "app.bsky.feed.post", text: "2" }, "s2");

		const res = await app.request(
			`/xrpc/com.atproto.space.listRepoOps?space=${encodeURIComponent(space)}&repo=${OPERATOR}`,
			{ headers: { Authorization: "Bearer operator-session" } },
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			ops: Array<{
				collection: string;
				rkey: string;
				cid: string | null;
				prev: string | null;
				value?: unknown;
			}>;
			commit: Record<string, unknown>;
			cursor?: string;
		};
		expect(body.cursor).toBeUndefined();
		expect(body.ops).toHaveLength(2);
		expect(body.ops[0]?.value).toBeDefined();

		// Syncer folds the ops into its own set hash and compares.
		const setHash = new LtHash();
		for (const op of body.ops) {
			if (op.prev) setHash.remove(`${op.collection}/${op.rkey}/${op.prev}`);
			if (op.cid) setHash.add(`${op.collection}/${op.rkey}/${op.cid}`);
		}
		const signed = commitFromJson(body.commit);
		expect(setHash.digest()).toEqual(signed.hash);
	});

	it("streams a CAR that the @atproto/space consumer verifies (S8)", async () => {
		const space = await createSpace();
		await createRecord(space, { $type: "app.bsky.feed.post", text: "car1" }, "k1");
		await createRecord(space, { $type: "app.bsky.feed.post", text: "car2" }, "k2");

		const res = await app.request(
			`/xrpc/com.atproto.space.getRepo?space=${encodeURIComponent(space)}&repo=${OPERATOR}`,
			{ headers: { Authorization: "Bearer operator-session" } },
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toBe("application/vnd.ipld.car");
		const car = new Uint8Array(await res.arrayBuffer());
		const verified = await verifyRepoCarFull([car], {
			space,
			author: OPERATOR,
			didKey: operatorKeypair.did(),
		});
		expect(verified.records).toHaveLength(2);
		expect(
			verified.records.map((r) => r.rkey).sort(),
		).toEqual(["k1", "k2"]);
	});

	it("records writers from inbound notifyWrite and serves listRepos", async () => {
		const space = await createSpace({
			$type: "com.atproto.simplespace.defs#publicPolicy",
		});
		await createRecord(space, { $type: "app.bsky.feed.post", text: "w" }, "w1");

		const hash = new LtHash().add("x").digest();
		const serviceJwt = (iss: string, aud: string, lxm: string) => {
			const enc = (o: unknown) =>
				btoa(JSON.stringify(o))
					.replace(/\+/g, "-")
					.replace(/\//g, "_")
					.replace(/=+$/, "");
			return `${enc({ alg: "ES256K", typ: "JWT" })}.${enc({ iss, aud, lxm })}.sig`;
		};

		const notify = async (iss: string, repo: string) =>
			app.request("/xrpc/com.atproto.space.notifyWrite", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${serviceJwt(iss, OPERATOR, "com.atproto.space.notifyWrite")}`,
				},
				body: JSON.stringify({
					space,
					repo,
					rev: "3kzzzzzzzzzz2",
					hash: { $bytes: btoa(String.fromCharCode(...hash)) },
				}),
			});

		// iss must match the claimed writer.
		const spoofed = await notify("did:web:mallory.test", BOB);
		expect(spoofed.status).toBe(403);

		const accepted = await notify(BOB, BOB);
		expect(accepted.status).toBe(200);

		// listRepos requires a space credential and shows both writers.
		const granted = await obtainCredential(space, bobKeypair, BOB);
		expect(granted.status).toBe(200);
		const proof = await createDpopProof(granted.dpopKey, {
			htm: "GET",
			htu: `${ORIGIN}/xrpc/com.atproto.space.listRepos`,
			credential: granted.credential,
		});
		const repos = await app.request(
			`/xrpc/com.atproto.space.listRepos?space=${encodeURIComponent(space)}`,
			{
				headers: {
					Authorization: `DPoP ${granted.credential}`,
					DPoP: proof,
				},
			},
		);
		expect(repos.status).toBe(200);
		const reposBody = (await repos.json()) as {
			repos: Array<{ did: string; rev: string }>;
		};
		const dids = reposBody.repos.map((r) => r.did);
		expect(dids).toContain(BOB);
		expect(dids).toContain(OPERATOR);
	});

	it("sends one best-effort notifyWrite for writes into foreign spaces (S3)", async () => {
		const authority = "did:web:elsewhere.test";
		const foreignSpace = `at://${authority}/space/app.bsky.group/forum1`;
		const { host: fHost, outbound } = makeHost();
		const fApp = createSpaceRoutes(fHost);

		const res = await fApp.request("/xrpc/com.atproto.space.createRecord", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer operator-session",
			},
			body: JSON.stringify({
				space: foreignSpace,
				repo: OPERATOR,
				collection: "app.bsky.feed.post",
				rkey: "foreign1",
				record: { $type: "app.bsky.feed.post", text: "posted elsewhere" },
			}),
		});
		expect(res.status).toBe(200);

		await vi.waitFor(() => {
			const call = outbound.find((o) =>
				o.url.includes("com.atproto.space.notifyWrite"),
			);
			expect(call).toBeDefined();
			expect(call!.url).toBe(
				"https://elsewhere.test/xrpc/com.atproto.space.notifyWrite",
			);
			const body = JSON.parse(String(call!.init?.body)) as {
				space: string;
				repo: string;
				rev: string;
				hash: { $bytes: string };
			};
			expect(body.space).toBe(foreignSpace);
			expect(body.repo).toBe(OPERATOR);
			expect(body.hash.$bytes).toBeTruthy();
		});

		// The foreign space is now registered and readable locally.
		const read = await fApp.request(
			`/xrpc/com.atproto.space.getRecord?space=${encodeURIComponent(foreignSpace)}&repo=${OPERATOR}&collection=app.bsky.feed.post&rkey=foreign1`,
			{ headers: { Authorization: "Bearer operator-session" } },
		);
		expect(read.status).toBe(200);
	});
});

describe("space routes: blobs (S6)", () => {
	it("serves space blobs only with authorisation and no-store headers", async () => {
		const space = await createSpace({
			$type: "com.atproto.simplespace.defs#publicPolicy",
		});
		const bytes = new Uint8Array([1, 2, 3, 4, 5]);
		const cidObj = await createCid(CODEC_RAW, bytes);
		const cid = cidToString(cidObj);
		// Simulate uploadBlob's staging write.
		await env.BLOBS.put(`${OPERATOR}/staged/${cid}`, bytes, {
			httpMetadata: { contentType: "image/png" },
		});

		await createRecord(
			space,
			{
				$type: "app.bsky.feed.post",
				embed: {
					$type: "app.bsky.embed.images",
					images: [
						{
							image: {
								$type: "blob",
								ref: { $link: cid },
								mimeType: "image/png",
								size: bytes.length,
							},
							alt: "",
						},
					],
				},
			},
			"withblob",
		);

		const path = `/xrpc/com.atproto.space.getBlob?space=${encodeURIComponent(space)}&repo=${OPERATOR}&cid=${cid}`;
		// No auth: refused.
		expect((await app.request(path)).status).toBe(401);

		// Session auth streams the blob with credential-safe cache headers.
		const res = await app.request(path, {
			headers: { Authorization: "Bearer operator-session" },
		});
		expect(res.status).toBe(200);
		expect(res.headers.get("Cache-Control")).toBe("private, no-store");
		expect(res.headers.get("Vary")).toBe("Authorization, DPoP");
		expect(res.headers.get("Content-Security-Policy")).toBe(
			"default-src 'none'; sandbox",
		);
		expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);

		// An unreferenced CID is BlobNotFound even though it sits in staging.
		const otherBytes = new Uint8Array([9, 9, 9]);
		const otherCid = cidToString(await createCid(CODEC_RAW, otherBytes));
		await env.BLOBS.put(`${OPERATOR}/staged/${otherCid}`, otherBytes);
		const unreferenced = await app.request(
			`/xrpc/com.atproto.space.getBlob?space=${encodeURIComponent(space)}&repo=${OPERATOR}&cid=${otherCid}`,
			{ headers: { Authorization: "Bearer operator-session" } },
		);
		expect(unreferenced.status).toBe(404);
		expect(((await unreferenced.json()) as { error: string }).error).toBe(
			"BlobNotFound",
		);

		// listBlobs enumerates the referenced blob.
		const list = await app.request(
			`/xrpc/com.atproto.space.listBlobs?space=${encodeURIComponent(space)}&repo=${OPERATOR}`,
			{ headers: { Authorization: "Bearer operator-session" } },
		);
		expect(((await list.json()) as { cids: string[] }).cids).toContain(cid);
	});
});

describe("space routes: lifecycle (S7-ish)", () => {
	it("deleteSpace tombstones: reads fail, credentials answer SpaceDeleted", async () => {
		const space = await createSpace({
			$type: "com.atproto.simplespace.defs#publicPolicy",
		});
		await createRecord(space, { $type: "app.bsky.feed.post", text: "x" }, "gone");

		const del = await app.request("/xrpc/com.atproto.simplespace.deleteSpace", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer operator-session",
			},
			body: JSON.stringify({ space }),
		});
		expect(del.status).toBe(200);

		const read = await app.request(
			`/xrpc/com.atproto.space.getRecord?space=${encodeURIComponent(space)}&repo=${OPERATOR}&collection=app.bsky.feed.post&rkey=gone`,
			{ headers: { Authorization: "Bearer operator-session" } },
		);
		expect(read.status).toBe(404);
		expect(((await read.json()) as { error: string }).error).toBe(
			"SpaceNotFound",
		);

		// A late getSpaceCredential gets SpaceDeleted, not SpaceNotFound.
		const late = await obtainCredential(space, bobKeypair, BOB);
		expect(late.status).toBe(400);
		expect((late.body as { error: string }).error).toBe("SpaceDeleted");
	});

	it("updateSpace changes policy and getSpace reflects it", async () => {
		const space = await createSpace();
		const update = await app.request(
			"/xrpc/com.atproto.simplespace.updateSpace",
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: "Bearer operator-session",
				},
				body: JSON.stringify({
					space,
					policy: { $type: "com.atproto.simplespace.defs#publicPolicy" },
				}),
			},
		);
		expect(update.status).toBe(200);
		const got = await app.request(
			`/xrpc/com.atproto.simplespace.getSpace?space=${encodeURIComponent(space)}`,
			{ headers: { Authorization: "Bearer operator-session" } },
		);
		expect(got.status).toBe(200);
		const body = (await got.json()) as {
			policy: { $type: string };
			appAccess: { $type: string };
		};
		expect(body.policy.$type).toBe(
			"com.atproto.simplespace.defs#publicPolicy",
		);
		expect(body.appAccess.$type).toBe("com.atproto.simplespace.defs#open");
	});

	it("manage scopes gate simplespace methods", async () => {
		const manageNone = `Bearer scoped:${JSON.stringify({ actions: ["read_self"] })}`;
		const refused = await app.request(
			"/xrpc/com.atproto.simplespace.createSpace",
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: manageNone,
				},
				body: JSON.stringify({
					type: "app.bsky.group",
					skey: "denied1",
					policy: { $type: "com.atproto.simplespace.defs#publicPolicy" },
					appAccess: { $type: "com.atproto.simplespace.defs#open" },
				}),
			},
		);
		expect(refused.status).toBe(403);

		const manageCreate = `Bearer scoped:${JSON.stringify({ manage: ["create"] })}`;
		const allowed = await app.request(
			"/xrpc/com.atproto.simplespace.createSpace",
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: manageCreate,
				},
				body: JSON.stringify({
					type: "app.bsky.group",
					skey: "allowed1",
					policy: { $type: "com.atproto.simplespace.defs#publicPolicy" },
					appAccess: { $type: "com.atproto.simplespace.defs#open" },
				}),
			},
		);
		expect(allowed.status).toBe(200);
	});

	it("rejects unsupported policy and appAccess variants", async () => {
		const res = await app.request(
			"/xrpc/com.atproto.simplespace.createSpace",
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: "Bearer operator-session",
				},
				body: JSON.stringify({
					type: "app.bsky.group",
					skey: "badpolicy",
					policy: { $type: "com.example.mysteryPolicy" },
					appAccess: { $type: "com.atproto.simplespace.defs#open" },
				}),
			},
		);
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toBe(
			"UnsupportedPolicy",
		);
	});
});
