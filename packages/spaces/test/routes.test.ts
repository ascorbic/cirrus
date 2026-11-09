import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { Context } from "hono";
import { P256Keypair, Secp256k1Keypair } from "@atproto/crypto";
import {
	COMMIT_MAC_TYPE,
	LtHash,
	RECORD_MAC_TYPE,
	createSpaceSigHeaders,
	createSpaceToken,
	encapsulate,
	formatWantMacHeader,
	parseMacHeader,
	readRepoStar,
	serializeRepo,
	spaceHostAud,
	verifyCommit,
	verifyRecord,
	verifyRepoStarFull,
} from "@atproto/space";
import type { Commit, MacType } from "@atproto/space";
import { JoseKey } from "@atproto/jwk-jose";
import { encode } from "@atproto/lex-cbor";
import { fromBase64 } from "@atproto/lex-data";
import { create as createCid, CODEC_RAW, toString as cidToString } from "@atcute/cid";
import { createSpaceRoutes } from "../src/routes";
import type { SpaceRoutesHost, SpaceScopeMatch } from "../src/routes";
import {
	TEST_KEM_KEY,
	TEST_OPERATOR_DID,
	TEST_SIGNING_KEY,
} from "./fixtures/spaces-worker/index";

const OPERATOR = TEST_OPERATOR_DID;
const BOB = "did:web:bob.test";
const CAROL = "did:web:carol.test";

const operatorKeypair = await Secp256k1Keypair.import(TEST_SIGNING_KEY);
const kemDid = (await P256Keypair.import(TEST_KEM_KEY)).did();
const bobKeypair = await Secp256k1Keypair.create();
const carolKeypair = await Secp256k1Keypair.create();

/** did → did:key registry standing in for DID-document resolution. */
const signingKeys = new Map<string, string>([
	[OPERATOR, operatorKeypair.did()],
	[BOB, bobKeypair.did()],
	[CAROL, carolKeypair.did()],
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
		blobs: env.BLOBS,
		getKeypair: async () => operatorKeypair,
		getKemPrivateKey: () => TEST_KEM_KEY,
		getSigningKey: async (iss) => {
			const key = signingKeys.get(iss);
			if (!key) throw new Error(`Unknown issuer: ${iss}`);
			return key;
		},
		resolveServiceEndpoint: async (service) =>
			`https://${service.split("#")[0]!.replace("did:web:", "")}`,
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
				return { did: OPERATOR, fullTrust: true, allowsSpace: () => true };
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
			return c.json({ error: "AuthenticationRequired", message: "No session" }, 401);
		},
		validateRecord: ({ record }) => ({ record, status: "unknown" }),
		getSpaceDO: (uri) => env.SPACES.get(env.SPACES.idFromName(uri)) as never,
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

const { host, outbound, setOutboundResponse } = makeHost();
const app = createSpaceRoutes(host);

const SESSION = { Authorization: "Bearer operator-session" };
const MEMBERSPACE = { $type: "com.atproto.memberspace.policy" };

let spaceN = 0;
async function createSpace(
	policy: Record<string, unknown> = MEMBERSPACE,
	spaceType = "app.bsky.group",
): Promise<string> {
	const res = await post("/xrpc/com.atproto.space.createSpace", {
		spaceType,
		skey: `route${spaceN++}x`,
		policy,
	});
	expect(res.status).toBe(200);
	return ((await res.json()) as { uri: string }).uri;
}

function post(
	path: string,
	body: unknown,
	headers: Record<string, string> = SESSION,
): Promise<Response> {
	return app.request(path, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...headers },
		body: JSON.stringify(body),
	});
}

function get(path: string, headers: Record<string, string> = SESSION): Promise<Response> {
	return app.request(path, { headers });
}

async function errorOf(res: Response): Promise<string> {
	return ((await res.json()) as { error: string }).error;
}

const q = encodeURIComponent;

async function createRecord(
	space: string,
	record: Record<string, unknown>,
	rkey?: string,
	collection = "app.bsky.feed.post",
): Promise<{ uri: string; cid: string }> {
	const res = await post("/xrpc/com.atproto.space.createRecord", {
		space,
		repo: OPERATOR,
		collection,
		...(rkey ? { rkey } : {}),
		record,
	});
	expect(res.status).toBe(200);
	return (await res.json()) as { uri: string; cid: string };
}

async function putMember(space: string, did: string, read = true, write = true) {
	const res = await post("/xrpc/com.atproto.memberspace.putMember", {
		space,
		did,
		read,
		write,
	});
	expect(res.status).toBe(200);
}

/** Request a credential bound to a fresh P-256 key. */
async function obtainCredential(
	space: string,
	opts: {
		user?: { did: string; keypair: Secp256k1Keypair };
		clientAttestation?: string;
	} = {},
): Promise<{ credential: string; key: P256Keypair; status: number; body: unknown }> {
	const key = await P256Keypair.create();
	const delegationToken = opts.user
		? await createSpaceToken(
				"delegation",
				{ iss: opts.user.did, sub: space, aud: spaceHostAud(OPERATOR) },
				opts.user.keypair,
			)
		: undefined;
	const res = await post(
		"/xrpc/com.atproto.space.getSpaceCredential",
		{
			space,
			credentialKid: key.did(),
			...(delegationToken ? { delegationToken } : {}),
			...(opts.clientAttestation
				? { clientAttestation: opts.clientAttestation }
				: {}),
		},
		{},
	);
	const body = (await res.json()) as { credential?: string };
	return { credential: body.credential ?? "", key, status: res.status, body };
}

/**
 * A credential-authenticated request: the credential, the audience header
 * and an HTTP message signature over both, plus a MAC request when asked.
 */
async function credentialRequest(
	path: string,
	credential: string,
	key: P256Keypair,
	opts: {
		mac?: MacType;
		audience?: string;
		scheme?: string;
		method?: "GET" | "POST";
		body?: unknown;
	} = {},
): Promise<{ res: Response; sharedSecret?: Uint8Array }> {
	const authorization = `${opts.scheme ?? "Atproto-Space-Credential"} ${credential}`;
	const headers: Record<string, string> = await createSpaceSigHeaders(key, {
		authorization,
		audience: (opts.audience ?? OPERATOR) as `did:${string}:${string}`,
	});
	let sharedSecret: Uint8Array | undefined;
	if (opts.mac) {
		const encapsulation = await encapsulate(kemDid);
		sharedSecret = encapsulation.sharedSecret;
		headers["atproto-space-want-mac"] = formatWantMacHeader(
			opts.mac,
			encapsulation.keyShare,
		);
	}
	const res = await app.request(path, {
		method: opts.method ?? "GET",
		headers: {
			...headers,
			...(opts.body ? { "Content-Type": "application/json" } : {}),
		},
		...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
	});
	return { res, sharedSecret };
}

function commitFromJson(json: Record<string, unknown>): Commit {
	return {
		ver: json.ver as number,
		repo: json.repo as Commit["repo"],
		space: json.space as Commit["space"],
		rev: json.rev as string,
		data: fromBase64((json.data as { $bytes: string }).$bytes),
	};
}

async function serviceJwt(iss: string, aud: string, lxm: string, keypair: Secp256k1Keypair) {
	const { createServiceJwt } = await import("../src/service-jwt");
	return createServiceJwt({ iss, aud, lxm }, keypair);
}

async function notifyWrite(
	space: string,
	writer: string,
	keypair: Secp256k1Keypair,
	repoRev: string,
	data: Uint8Array,
	aud = OPERATOR,
): Promise<Response> {
	const token = await serviceJwt(writer, aud, "com.atproto.space.notifyWrite", keypair);
	return post(
		"/xrpc/com.atproto.space.notifyWrite",
		{ space, repo: writer, repoRev, data: { $bytes: btoa(String.fromCharCode(...data)) } },
		{ Authorization: `Bearer ${token}` },
	);
}

const TID_CHARS = "234567abcdefghijklmnopqrstuvwxyz";
/** A TID for a given time, so tests control rev order and skew. */
function tidAt(ms: number, clock = 0): string {
	let value = (BigInt(Math.floor(ms)) * 1000n << 10n) | BigInt(clock);
	let out = "";
	for (let i = 0; i < 13; i++) {
		out = TID_CHARS[Number(value & 31n)] + out;
		value >>= 5n;
	}
	return out;
}

const repoData = (n: number) => new Uint8Array(32).fill(n);

// ---------------------------------------------------------------------

describe("space routes: personal data (S1)", () => {
	it("creates a space, writes and reads records with a session", async () => {
		const space = await createSpace();
		const created = await createRecord(space, {
			$type: "app.bsky.feed.post",
			text: "hello spaces",
		});
		const rkey = created.uri.split("/").pop()!;
		expect(created.uri).toBe(`${space}/${OPERATOR}/app.bsky.feed.post/${rkey}`);

		const res = await get(
			`/xrpc/com.atproto.space.getRecord?space=${q(space)}&repo=${OPERATOR}&collection=app.bsky.feed.post&rkey=${rkey}`,
		);
		expect(res.status).toBe(200);
		// A session reading its own data gets no MAC unless it asks.
		expect(res.headers.get("atproto-space-mac")).toBeNull();
		const body = (await res.json()) as { value: { text: string }; cid: string };
		expect(body.value.text).toBe("hello spaces");
		expect(body.cid).toBe(created.cid);
	});

	it("refuses an unauthenticated getRecord", async () => {
		const space = await createSpace();
		await createRecord(space, { $type: "app.bsky.feed.post", text: "x" }, "aaa");
		const res = await get(
			`/xrpc/com.atproto.space.getRecord?space=${q(space)}&repo=${OPERATOR}&collection=app.bsky.feed.post&rkey=aaa`,
			{},
		);
		expect(res.status).toBe(401);
	});

	it("returns RepoNotFound for a repo that is not the operator", async () => {
		const space = await createSpace();
		const res = await get(
			`/xrpc/com.atproto.space.getRecord?space=${q(space)}&repo=${BOB}&collection=app.bsky.feed.post&rkey=aaa`,
		);
		expect(res.status).toBe(404);
		expect(await errorOf(res)).toBe("RepoNotFound");
	});

	it("requires createSpace before writing into an own-authority space", async () => {
		const res = await post("/xrpc/com.atproto.space.createRecord", {
			space: `at://${OPERATOR}/space/app.bsky.group/nevercreated`,
			repo: OPERATOR,
			collection: "app.bsky.feed.post",
			record: { $type: "app.bsky.feed.post", text: "x" },
		});
		expect(res.status).toBe(404);
		expect(await errorOf(res)).toBe("SpaceNotFound");
	});

	it("enforces scoped sessions on writes and reads", async () => {
		const space = await createSpace();
		const writeOnly = `Bearer scoped:${JSON.stringify({ actions: ["create"] })}`;
		const write = await post(
			"/xrpc/com.atproto.space.createRecord",
			{
				space,
				repo: OPERATOR,
				collection: "app.bsky.feed.post",
				rkey: "scoped",
				record: { $type: "app.bsky.feed.post", text: "x" },
			},
			{ Authorization: writeOnly },
		);
		expect(write.status).toBe(200);
		const path = `/xrpc/com.atproto.space.getRecord?space=${q(space)}&repo=${OPERATOR}&collection=app.bsky.feed.post&rkey=scoped`;
		expect((await get(path, { Authorization: writeOnly })).status).toBe(403);
		const readOnly = `Bearer scoped:${JSON.stringify({ actions: ["read_self"] })}`;
		expect((await get(path, { Authorization: readOnly })).status).toBe(200);
	});

	it("applyWrites returns typed results in order", async () => {
		const space = await createSpace();
		const res = await post("/xrpc/com.atproto.space.applyWrites", {
			space,
			repo: OPERATOR,
			writes: [
				{
					$type: "com.atproto.space.applyWrites#create",
					collection: "app.bsky.feed.post",
					rkey: "one",
					value: { $type: "app.bsky.feed.post", text: "1" },
				},
				{
					$type: "com.atproto.space.applyWrites#update",
					collection: "app.bsky.feed.post",
					rkey: "one",
					value: { $type: "app.bsky.feed.post", text: "1b" },
				},
				{
					$type: "com.atproto.space.applyWrites#delete",
					collection: "app.bsky.feed.post",
					rkey: "one",
				},
			],
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { results: Array<{ $type: string }> };
		expect(body.results.map((r) => r.$type)).toEqual([
			"com.atproto.space.applyWrites#createResult",
			"com.atproto.space.applyWrites#updateResult",
			"com.atproto.space.applyWrites#deleteResult",
		]);
	});

	it("putRecord upserts and deleteRecord is idempotent", async () => {
		const space = await createSpace();
		const put = (text: string) =>
			post("/xrpc/com.atproto.space.putRecord", {
				space,
				repo: OPERATOR,
				collection: "app.bsky.feed.post",
				rkey: "p",
				record: { $type: "app.bsky.feed.post", text },
			});
		expect((await put("a")).status).toBe(200);
		expect((await put("b")).status).toBe(200);
		const del = () =>
			post("/xrpc/com.atproto.space.deleteRecord", {
				space,
				repo: OPERATOR,
				collection: "app.bsky.feed.post",
				rkey: "p",
			});
		expect((await del()).status).toBe(200);
		expect((await del()).status).toBe(200);
	});

	it("refuses oversized records and direct writes to published collections", async () => {
		const space = await createSpace();
		const big = await post("/xrpc/com.atproto.space.createRecord", {
			space,
			repo: OPERATOR,
			collection: "app.bsky.feed.post",
			record: { $type: "app.bsky.feed.post", text: "x".repeat(1024 * 1024 + 1) },
		});
		expect(big.status).toBe(400);
		expect(await errorOf(big)).toBe("InvalidRequest");

		for (const collection of [
			"com.atproto.space.policy",
			"com.atproto.memberspace.member",
		]) {
			const res = await post("/xrpc/com.atproto.space.createRecord", {
				space,
				repo: OPERATOR,
				collection,
				rkey: "self",
				record: { $type: collection },
			});
			expect(res.status).toBe(400);
		}
	});

	it("clearRecords empties the repo but keeps published configuration", async () => {
		const space = await createSpace({
			...MEMBERSPACE,
			publishPolicy: true,
		});
		await createRecord(space, { $type: "app.bsky.feed.post", text: "a" }, "a");
		await createRecord(space, { $type: "app.bsky.feed.like", subject: "x" }, "b", "app.bsky.feed.like");

		// A scoped session needs delete on every collection being cleared.
		const narrow = `Bearer scoped:${JSON.stringify({ actions: ["read_self"] })}`;
		const refused = await post(
			"/xrpc/com.atproto.space.clearRecords",
			{ space, repo: OPERATOR },
			{ Authorization: narrow },
		);
		expect(refused.status).toBe(403);

		const res = await post("/xrpc/com.atproto.space.clearRecords", {
			space,
			repo: OPERATOR,
		});
		expect(res.status).toBe(200);
		const list = await get(
			`/xrpc/com.atproto.space.listRecords?space=${q(space)}&repo=${OPERATOR}`,
		);
		const { records } = (await list.json()) as {
			records: Array<{ collection: string }>;
		};
		expect(records.map((r) => r.collection)).toEqual(["com.atproto.space.policy"]);

		const ops = await get(
			`/xrpc/com.atproto.space.listRepoOps?space=${q(space)}&repo=${OPERATOR}`,
		);
		const opsBody = (await ops.json()) as { ops: unknown[]; commit: Record<string, unknown> };
		expect(opsBody.ops).toEqual([]);
		// The digest is that of the records that remain.
		const commit = commitFromJson(opsBody.commit);
		const remaining = await get(
			`/xrpc/com.atproto.space.getRecord?space=${q(space)}&repo=${OPERATOR}&collection=com.atproto.space.policy&rkey=self`,
		);
		const { cid } = (await remaining.json()) as { cid: string };
		const expected = new LtHash();
		expected.add(`com.atproto.space.policy/self/${cid}`);
		expect(commit.data).toEqual(expected.digest());

		const other = await post(
			"/xrpc/com.atproto.space.clearRecords",
			{ space, repo: BOB },
		);
		expect(other.status).toBe(403);
	});
});

describe("space routes: credentials (S5)", () => {
	it("issues credentials to members, binds them to the request key and refuses others as SpaceNotFound", async () => {
		const space = await createSpace();
		await createRecord(space, { $type: "app.bsky.feed.post", text: "hi" }, "r1");

		const denied = await obtainCredential(space, {
			user: { did: BOB, keypair: bobKeypair },
		});
		expect(denied.status).toBe(404);
		expect((denied.body as { error: string }).error).toBe("SpaceNotFound");

		await putMember(space, BOB);
		const { credential, key, status } = await obtainCredential(space, {
			user: { did: BOB, keypair: bobKeypair },
		});
		expect(status).toBe(200);
		const payload = JSON.parse(
			atob(credential.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/")),
		) as { cnf: { kid: string }; iss: string; sub: string; aud?: string };
		expect(payload.cnf.kid).toBe(key.did());
		expect(payload.iss).toBe(OPERATOR);
		expect(payload.sub).toBe(space);
		expect(payload.aud).toBeUndefined();

		const path = `/xrpc/com.atproto.space.getRecord?space=${q(space)}&repo=${OPERATOR}&collection=app.bsky.feed.post&rkey=r1`;
		const { res, sharedSecret } = await credentialRequest(path, credential, key, {
			mac: RECORD_MAC_TYPE,
		});
		expect(res.status).toBe(200);
		const record = (await res.json()) as { uri: string; cid: string; value: Record<string, unknown> };
		const mac = parseMacHeader(res.headers.get("atproto-space-mac") ?? undefined, RECORD_MAC_TYPE);
		expect(
			await verifyRecord(record as never, { uri: record.uri, sharedSecret: sharedSecret!, mac }),
		).toBe(true);
		expect(res.headers.get("access-control-expose-headers")).toContain("atproto-space-mac");

		// A member without read access is refused like a stranger.
		await putMember(space, BOB, false, true);
		const noRead = await obtainCredential(space, { user: { did: BOB, keypair: bobKeypair } });
		expect(noRead.status).toBe(404);
	});

	it("validates credentialKid and the delegation token", async () => {
		const space = await createSpace({ ...MEMBERSPACE, publicRead: true });
		const k256 = await post(
			"/xrpc/com.atproto.space.getSpaceCredential",
			{ space, credentialKid: bobKeypair.did() },
			{},
		);
		expect(k256.status).toBe(400);
		expect(await errorOf(k256)).toBe("InvalidRequest");

		const key = await P256Keypair.create();
		const token = await createSpaceToken(
			"delegation",
			{ iss: BOB, sub: space, aud: spaceHostAud(OPERATOR) },
			bobKeypair,
		);
		const request = () =>
			post(
				"/xrpc/com.atproto.space.getSpaceCredential",
				{ space, credentialKid: key.did(), delegationToken: token },
				{},
			);
		expect((await request()).status).toBe(200);
		const replay = await request();
		expect(replay.status).toBe(400);
		expect(await errorOf(replay)).toBe("InvalidDelegationToken");

		const wrongAud = await createSpaceToken(
			"delegation",
			{ iss: BOB, sub: space, aud: `${OPERATOR}#atproto_space_host` },
			bobKeypair,
		);
		const badAud = await post(
			"/xrpc/com.atproto.space.getSpaceCredential",
			{ space, credentialKid: key.did(), delegationToken: wrongAud },
			{},
		);
		expect(await errorOf(badAud)).toBe("InvalidDelegationToken");
	});

	it("issues public-read credentials without a delegation token, and only those", async () => {
		const closed = await createSpace();
		const anon = await obtainCredential(closed);
		expect(anon.status).toBe(404);
		expect((anon.body as { error: string }).error).toBe("SpaceNotFound");

		const open = await createSpace({ ...MEMBERSPACE, publicRead: true });
		await createRecord(open, { $type: "app.bsky.feed.post", text: "public" }, "p");
		const { credential, key, status } = await obtainCredential(open);
		expect(status).toBe(200);
		const { res } = await credentialRequest(
			`/xrpc/com.atproto.space.listRecords?space=${q(open)}&repo=${OPERATOR}`,
			credential,
			key,
		);
		expect(res.status).toBe(200);
	});

	it("refuses bad signatures, audiences, spaces, schemes and revoked credentials", async () => {
		const space = await createSpace({ ...MEMBERSPACE, publicRead: true });
		await createRecord(space, { $type: "app.bsky.feed.post", text: "x" }, "x");
		const other = await createSpace({ ...MEMBERSPACE, publicRead: true });
		await createRecord(other, { $type: "app.bsky.feed.post", text: "y" }, "y");
		const { credential, key } = await obtainCredential(space);
		const path = `/xrpc/com.atproto.space.listRecords?space=${q(space)}&repo=${OPERATOR}`;

		const ok = await credentialRequest(path, credential, key, { scheme: "atproto-space-credential" });
		expect(ok.res.status).toBe(200);

		const wrongKey = await credentialRequest(path, credential, await P256Keypair.create());
		expect(wrongKey.res.status).toBe(401);
		expect(await errorOf(wrongKey.res)).toBe("BadSpaceSignature");

		const wrongAudience = await credentialRequest(path, credential, key, { audience: BOB });
		expect(wrongAudience.res.status).toBe(401);
		expect(await errorOf(wrongAudience.res)).toBe("BadSpaceAudience");

		const crossSpace = await credentialRequest(
			`/xrpc/com.atproto.space.listRecords?space=${q(other)}&repo=${OPERATOR}`,
			credential,
			key,
		);
		expect(crossSpace.res.status).toBe(400);
		expect(await errorOf(crossSpace.res)).toBe("InvalidCredential");

		// A credential read that returns a commit must ask for a MAC.
		const noMac = await credentialRequest(
			`/xrpc/com.atproto.space.getLatestCommit?space=${q(space)}&repo=${OPERATOR}`,
			credential,
			key,
		);
		expect(noMac.res.status).toBe(400);
		expect(await errorOf(noMac.res)).toBe("BadSpaceMac");

		// Revocation, by the authority, addressed to the repo DID.
		const jti = (
			JSON.parse(atob(credential.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/"))) as {
				jti: string;
			}
		).jti;
		const forged = await serviceJwt(BOB, OPERATOR, "com.atproto.space.notifyCredentialRevoked", bobKeypair);
		const forgedRes = await post(
			"/xrpc/com.atproto.space.notifyCredentialRevoked",
			{ space, credentials: [jti] },
			{ Authorization: `Bearer ${forged}` },
		);
		expect(forgedRes.status).toBe(403);
		const token = await serviceJwt(OPERATOR, OPERATOR, "com.atproto.space.notifyCredentialRevoked", operatorKeypair);
		const revoke = await post(
			"/xrpc/com.atproto.space.notifyCredentialRevoked",
			{ space, credentials: [jti] },
			{ Authorization: `Bearer ${token}` },
		);
		expect(revoke.status).toBe(200);
		const revoked = await credentialRequest(path, credential, key);
		expect(revoked.res.status).toBe(401);
		expect(await errorOf(revoked.res)).toBe("CredentialRevoked");
	});

	it("gates on allowedApps with client attestations, after the user", async () => {
		const clientId = "https://app.example/client-metadata.json";
		const jwk = await JoseKey.generate(["ES256"], "attest-key");
		const space = await createSpace({ ...MEMBERSPACE, publicRead: true, allowedApps: [clientId] });

		const { host: attestHost, setOutboundResponse: respond } = makeHost();
		const attestApp = createSpaceRoutes(attestHost);
		// Publish a clean JWKS entry (kty/crv/x/y/kid/alg): key_ops from the
		// generated key would be rejected by workerd's ECDSA import.
		const clientJwk = { ...jwk.bareJwk, kid: jwk.kid, alg: "ES256" };
		respond((url) =>
			url === clientId ? Response.json({ jwks: { keys: [clientJwk] } }) : null,
		);
		const attest = async (aud = spaceHostAud(OPERATOR), id = clientId) => {
			const iat = Math.floor(Date.now() / 1000);
			return jwk.createJwt(
				{ alg: "ES256", typ: "atproto-client-attestation+jwt", kid: jwk.kid },
				{ iss: id, sub: id, aud, iat, exp: iat + 60, jti: crypto.randomUUID() },
			);
		};
		const request = async (clientAttestation?: string) => {
			const key = await P256Keypair.create();
			return attestApp.request("/xrpc/com.atproto.space.getSpaceCredential", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					space,
					credentialKid: key.did(),
					...(clientAttestation ? { clientAttestation } : {}),
				}),
			});
		};

		const none = await request();
		expect(none.status).toBe(403);
		expect(await errorOf(none)).toBe("AppNotAuthorized");

		expect((await request(await attest())).status).toBe(200);

		const otherApp = await request(await attest(undefined, "https://other.example/client-metadata.json"));
		expect(await errorOf(otherApp)).toBe("AppNotAuthorized");

		const wrongAud = await request(await attest(`${OPERATOR}#atproto_space_host`));
		expect(await errorOf(wrongAud)).toBe("InvalidClientAttestation");
	});

	it("consults the managing app with the access kind and denies on failure", async () => {
		const space = await createSpace({
			$type: "com.atproto.managedspace.policy",
			managingApp: "did:web:manager.test#forum",
		});
		setOutboundResponse((url) => {
			if (!url.includes("checkUserAccess")) return null;
			const user = new URL(url).searchParams.get("user");
			return Response.json({ authorized: user === BOB });
		});
		try {
			const bob = await obtainCredential(space, { user: { did: BOB, keypair: bobKeypair } });
			expect(bob.status).toBe(200);
			const check = outbound.filter((call) => call.url.includes("checkUserAccess")).pop()!;
			const params = new URL(check.url).searchParams;
			expect(params.get("access")).toBe("read");
			expect(params.get("space")).toBe(space);

			const carol = await obtainCredential(space, { user: { did: CAROL, keypair: carolKeypair } });
			expect(carol.status).toBe(404);

			setOutboundResponse((url) =>
				url.includes("checkUserAccess") ? new Response("boom", { status: 500 }) : null,
			);
			const failing = await obtainCredential(space, { user: { did: BOB, keypair: bobKeypair } });
			expect(failing.status).toBe(404);
		} finally {
			setOutboundResponse(() => null);
		}
	});

	it("personalspace authorises only the authority", async () => {
		const space = await createSpace({ $type: "com.atproto.personalspace.policy" });
		const bob = await obtainCredential(space, { user: { did: BOB, keypair: bobKeypair } });
		expect(bob.status).toBe(404);
		const self = await obtainCredential(space, {
			user: { did: OPERATOR, keypair: operatorKeypair },
		});
		expect(self.status).toBe(200);
	});
});

describe("space routes: sync (S2-S4)", () => {
	async function syncerCredential(space: string) {
		await putMember(space, BOB);
		return obtainCredential(space, { user: { did: BOB, keypair: bobKeypair } });
	}

	it("serves a commit with a verifiable MAC", async () => {
		const space = await createSpace();
		await createRecord(space, { $type: "app.bsky.feed.post", text: "a" });
		const { credential, key } = await syncerCredential(space);
		const { res, sharedSecret } = await credentialRequest(
			`/xrpc/com.atproto.space.getLatestCommit?space=${q(space)}&repo=${OPERATOR}`,
			credential,
			key,
			{ mac: COMMIT_MAC_TYPE },
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("vary")).toContain("atproto-space-want-mac");
		const commit = commitFromJson(((await res.json()) as { commit: Record<string, unknown> }).commit);
		expect(commit.repo).toBe(OPERATOR);
		expect(commit.space).toBe(space);
		const mac = parseMacHeader(res.headers.get("atproto-space-mac") ?? undefined, COMMIT_MAC_TYPE);
		expect(verifyCommit(commit, { space, repo: OPERATOR, sharedSecret: sharedSecret!, mac })).toBe(true);
		// The MAC is per request: another shared secret does not verify it.
		const other = await encapsulate(kemDid);
		expect(
			verifyCommit(commit, { space, repo: OPERATOR, sharedSecret: other.sharedSecret, mac }),
		).toBe(false);
	});

	it("lets a syncer follow listRepoOps to the commit's data", async () => {
		const space = await createSpace();
		await createRecord(space, { $type: "app.bsky.feed.post", text: "a" }, "a");
		await createRecord(space, { $type: "app.bsky.feed.post", text: "b" }, "b");
		await post("/xrpc/com.atproto.space.deleteRecord", {
			space,
			repo: OPERATOR,
			collection: "app.bsky.feed.post",
			rkey: "a",
		});
		const { credential, key } = await syncerCredential(space);
		const { res, sharedSecret } = await credentialRequest(
			`/xrpc/com.atproto.space.listRepoOps?space=${q(space)}&repo=${OPERATOR}`,
			credential,
			key,
			{ mac: COMMIT_MAC_TYPE },
		);
		const body = (await res.json()) as {
			ops: Array<{ collection: string; rkey: string; cid: string | null; prev: string | null }>;
			commit: Record<string, unknown>;
		};
		const hash = new LtHash();
		for (const op of body.ops) {
			if (op.prev) hash.remove(`${op.collection}/${op.rkey}/${op.prev}`);
			if (op.cid) hash.add(`${op.collection}/${op.rkey}/${op.cid}`);
		}
		const commit = commitFromJson(body.commit);
		expect(hash.digest()).toEqual(commit.data);
		const mac = parseMacHeader(res.headers.get("atproto-space-mac") ?? undefined, COMMIT_MAC_TYPE);
		expect(verifyCommit(commit, { space, repo: OPERATOR, sharedSecret: sharedSecret!, mac })).toBe(true);
	});

	it("streams a STAR archive the @atproto/space consumer verifies (S8)", async () => {
		const space = await createSpace();
		// One collection NSID prefixes another: (collection, rkey) order and
		// byte order of the record path disagree, and the archive needs the
		// latter.
		await createRecord(space, { $type: "app.bsky.feed.post", text: "1" }, "z", "app.bsky.feed");
		await createRecord(space, { $type: "app.bsky.feed.post", text: "2" }, "a", "app.bsky.feed.post");
		for (let i = 0; i < 3; i++) {
			await createRecord(space, { $type: "app.bsky.feed.post", text: `n${i}` });
		}
		const { credential, key } = await syncerCredential(space);
		const { res, sharedSecret } = await credentialRequest(
			`/xrpc/com.atproto.space.getRepo?space=${q(space)}&repo=${OPERATOR}`,
			credential,
			key,
			{ mac: COMMIT_MAC_TYPE },
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("application/octet-stream");
		const mac = parseMacHeader(res.headers.get("atproto-space-mac") ?? undefined, COMMIT_MAC_TYPE);
		const bytes = new Uint8Array(await res.arrayBuffer());
		const verified = await verifyRepoStarFull([bytes], {
			space,
			repo: OPERATOR,
			sharedSecret: sharedSecret!,
			mac,
		});
		expect(verified.records).toHaveLength(5);
		expect(verified.records[0]!.collection).toBe("app.bsky.feed.post");
	});

	it("sequences writers from notifyWrite and serves listRepos by spaceRev", async () => {
		const space = await createSpace();
		await putMember(space, BOB);
		await putMember(space, CAROL);
		const registrar = await obtainCredential(space, { user: { did: BOB, keypair: bobKeypair } });
		const reg = await credentialRequest(
			"/xrpc/com.atproto.space.registerNotify",
			registrar.credential,
			registrar.key,
			{ method: "POST", body: { space, service: "did:web:syncer.test#atproto_space_syncer" } },
		);
		expect(reg.res.status).toBe(200);

		const before = outbound.length;
		const t = Date.now();
		expect((await notifyWrite(space, BOB, bobKeypair, tidAt(t - 3000), repoData(1))).status).toBe(200);
		expect(
			(await notifyWrite(space, CAROL, carolKeypair, tidAt(t - 2000), repoData(2), spaceHostAud(OPERATOR)))
				.status,
		).toBe(200);
		// Stale: does not advance and is not fanned out again.
		expect((await notifyWrite(space, BOB, bobKeypair, tidAt(t - 4000), repoData(9))).status).toBe(200);

		const list = await credentialRequest(
			`/xrpc/com.atproto.space.listRepos?space=${q(space)}&limit=1`,
			registrar.credential,
			registrar.key,
		);
		const page1 = (await list.res.json()) as {
			repos: Array<{ did: string; repoRev: string; data: { $bytes: string }; spaceRev: string }>;
			cursor?: string;
		};
		expect(page1.repos.map((r) => r.did)).toEqual([BOB]);
		expect(page1.cursor).toBe(page1.repos[0]!.spaceRev);
		expect(fromBase64(page1.repos[0]!.data.$bytes)).toEqual(repoData(1));
		const list2 = await credentialRequest(
			`/xrpc/com.atproto.space.listRepos?space=${q(space)}&cursor=${page1.cursor}`,
			registrar.credential,
			registrar.key,
		);
		const page2 = (await list2.res.json()) as typeof page1;
		expect(page2.repos.map((r) => r.did)).toEqual([CAROL]);
		expect(page2.repos[0]!.spaceRev > page1.repos[0]!.spaceRev).toBe(true);
		const list3 = await credentialRequest(
			`/xrpc/com.atproto.space.listRepos?space=${q(space)}&cursor=${page2.cursor}`,
			registrar.credential,
			registrar.key,
		);
		const page3 = (await list3.res.json()) as typeof page1;
		expect(page3.repos).toEqual([]);
		expect(page3.cursor).toBeUndefined();

		// Two accepted updates, two fan-outs queued with sequence numbers.
		const stub = env.SPACES.get(env.SPACES.idFromName(space));
		const status = await stub.rpcStatus();
		expect(status.queuedNotifications).toBe(2);
		expect(outbound.length).toBe(before);
	});

	it("refuses unauthorised, mismatched and future notifyWrites", async () => {
		const space = await createSpace();
		const now = Date.now();
		const stranger = await notifyWrite(space, BOB, bobKeypair, tidAt(now), repoData(1));
		expect(stranger.status).toBe(403);

		await putMember(space, BOB, true, false);
		const readOnly = await notifyWrite(space, BOB, bobKeypair, tidAt(now), repoData(1));
		expect(readOnly.status).toBe(403);

		const open = await createSpace({ ...MEMBERSPACE, publicWrite: true });
		expect((await notifyWrite(open, BOB, bobKeypair, tidAt(now), repoData(1))).status).toBe(200);
		const future = await notifyWrite(open, BOB, bobKeypair, tidAt(now + 10 * 60_000), repoData(1));
		expect(future.status).toBe(400);
		expect(await errorOf(future)).toBe("FutureRev");
		const wrongAud = await notifyWrite(open, BOB, bobKeypair, tidAt(now + 1), repoData(1), BOB);
		expect(wrongAud.status).toBe(403);

		const token = await serviceJwt(CAROL, OPERATOR, "com.atproto.space.notifyWrite", carolKeypair);
		const impersonation = await post(
			"/xrpc/com.atproto.space.notifyWrite",
			{ space: open, repo: BOB, repoRev: tidAt(now + 2), data: { $bytes: "AA==" } },
			{ Authorization: `Bearer ${token}` },
		);
		expect(impersonation.status).toBe(403);

		const unknown = await notifyWrite(
			`at://${OPERATOR}/space/app.bsky.group/notreal`,
			BOB,
			bobKeypair,
			tidAt(now),
			repoData(1),
		);
		expect(unknown.status).toBe(404);
		expect(await errorOf(unknown)).toBe("SpaceNotFound");
	});

	it("removeWriter and revoking write access drop writers from listRepos", async () => {
		const space = await createSpace();
		await putMember(space, BOB);
		await putMember(space, CAROL);
		const t = Date.now();
		await notifyWrite(space, BOB, bobKeypair, tidAt(t - 2000), repoData(1));
		await notifyWrite(space, CAROL, carolKeypair, tidAt(t - 1000), repoData(2));
		const { credential, key } = await obtainCredential(space, { user: { did: BOB, keypair: bobKeypair } });
		const writers = async () => {
			const { res } = await credentialRequest(
				`/xrpc/com.atproto.space.listRepos?space=${q(space)}`,
				credential,
				key,
			);
			return ((await res.json()) as { repos: Array<{ did: string }> }).repos.map((r) => r.did);
		};
		expect((await writers()).sort()).toEqual([BOB, CAROL].sort());
		expect((await post("/xrpc/com.atproto.space.removeWriter", { space, did: CAROL })).status).toBe(200);
		expect(await writers()).toEqual([BOB]);
		await putMember(space, BOB, true, false);
		expect(await writers()).toEqual([]);
	});

	it("requires notifySpaceDeleted to be addressed to this service", async () => {
		const foreign = `at://${BOB}/space/app.bsky.group/deleteme`;
		await post("/xrpc/com.atproto.space.createRecord", {
			space: foreign,
			repo: OPERATOR,
			collection: "app.bsky.feed.post",
			rkey: "d",
			record: { $type: "app.bsky.feed.post", text: "x" },
		});
		const send = async (aud: string, iss = BOB, keypair = bobKeypair) =>
			post(
				"/xrpc/com.atproto.space.notifySpaceDeleted",
				{ space: foreign },
				{ Authorization: `Bearer ${await serviceJwt(iss, aud, "com.atproto.space.notifySpaceDeleted", keypair)}` },
			);
		expect((await send("did:web:someone-else.test")).status).toBe(403);
		expect((await send(OPERATOR, CAROL, carolKeypair)).status).toBe(403);
		expect((await send(`${OPERATOR}#atproto_space_syncer`)).status).toBe(200);
		const read = await get(
			`/xrpc/com.atproto.space.getRecord?space=${q(foreign)}&repo=${OPERATOR}&collection=app.bsky.feed.post&rkey=d`,
		);
		expect(await errorOf(read)).toBe("SpaceNotFound");
	});

	it("delivers writes in foreign spaces to the authority, queueing retryable failures (S3)", async () => {
		const foreign = `at://${BOB}/space/app.bsky.group/writer${spaceN++}`;
		const stub = env.SPACES.get(env.SPACES.idFromName(foreign));
		const before = outbound.length;
		await post("/xrpc/com.atproto.space.createRecord", {
			space: foreign,
			repo: OPERATOR,
			collection: "app.bsky.feed.post",
			rkey: "w",
			record: { $type: "app.bsky.feed.post", text: "x" },
		});
		await vi.waitFor(() => expect(outbound.length).toBeGreaterThan(before));
		const call = outbound[outbound.length - 1]!;
		expect(call.url).toBe("https://bob.test/xrpc/com.atproto.space.notifyWrite");
		const body = JSON.parse(String(call.init!.body)) as Record<string, unknown>;
		expect(Object.keys(body).sort()).toEqual(["data", "repo", "repoRev", "space"]);
		expect(body.repo).toBe(OPERATOR);
		expect((await stub.rpcStatus()).queuedNotifications).toBe(0);

		setOutboundResponse((url) => (url.includes("notifyWrite") ? new Response("down", { status: 503 }) : null));
		try {
			for (const rkey of ["w2", "w3"]) {
				const count = outbound.length;
				await post("/xrpc/com.atproto.space.createRecord", {
					space: foreign,
					repo: OPERATOR,
					collection: "app.bsky.feed.post",
					rkey,
					record: { $type: "app.bsky.feed.post", text: rkey },
				});
				await vi.waitFor(() => expect(outbound.length).toBeGreaterThan(count));
				await vi.waitFor(async () =>
					expect((await stub.rpcStatus()).queuedNotifications).toBe(1),
				);
			}
		} finally {
			setOutboundResponse(() => null);
		}
		// Coalesced: one pending retry, for the newest revision.
		expect((await stub.rpcStatus()).queuedNotifications).toBe(1);
	});
});

describe("space routes: blobs (S6)", () => {
	async function stageBlob(text: string): Promise<string> {
		const bytes = new TextEncoder().encode(text);
		const cid = cidToString(await createCid(CODEC_RAW, bytes));
		await env.BLOBS.put(`${OPERATOR}/staged/${cid}`, bytes, {
			httpMetadata: { contentType: "text/plain" },
		});
		return cid;
	}

	const blobRecord = (cid: string) => ({
		$type: "app.bsky.feed.post",
		text: "with blob",
		embed: {
			$type: "blob",
			ref: { $link: cid },
			mimeType: "text/plain",
			size: 9,
		},
	});

	it("serves space blobs only with authorisation and no-store headers", async () => {
		const space = await createSpace();
		const cid = await stageBlob("blob data");
		await createRecord(space, blobRecord(cid), "b");
		const path = `/xrpc/com.atproto.space.getBlob?space=${q(space)}&repo=${OPERATOR}&cid=${cid}`;
		expect((await get(path, {})).status).toBe(401);
		const res = await get(path);
		expect(res.status).toBe(200);
		expect(res.headers.get("cache-control")).toBe("private, no-store");
		expect(await res.text()).toBe("blob data");

		const unreferenced = await stageBlob("not referenced");
		const missing = await get(
			`/xrpc/com.atproto.space.getBlob?space=${q(space)}&repo=${OPERATOR}&cid=${unreferenced}`,
		);
		expect(await errorOf(missing)).toBe("BlobNotFound");
	});
});

describe("space routes: lifecycle and management", () => {
	it("deleteSpace tombstones: reads fail, credentials answer SpaceDeleted", async () => {
		const space = await createSpace({ ...MEMBERSPACE, publicRead: true });
		await createRecord(space, { $type: "app.bsky.feed.post", text: "x" }, "x");
		await putMember(space, BOB);
		expect((await post("/xrpc/com.atproto.space.deleteSpace", { space })).status).toBe(200);
		expect((await post("/xrpc/com.atproto.space.deleteSpace", { space })).status).toBe(200);
		const read = await get(
			`/xrpc/com.atproto.space.getRecord?space=${q(space)}&repo=${OPERATOR}&collection=app.bsky.feed.post&rkey=x`,
		);
		expect(await errorOf(read)).toBe("SpaceNotFound");
		const withToken = await obtainCredential(space, { user: { did: BOB, keypair: bobKeypair } });
		expect((withToken.body as { error: string }).error).toBe("SpaceDeleted");
		const anon = await obtainCredential(space);
		expect((anon.body as { error: string }).error).toBe("SpaceDeleted");
	});

	it("updateSpace replaces the policy, and a new $type discards the member list", async () => {
		const space = await createSpace();
		await putMember(space, BOB);
		const getSpace = async () =>
			(await (await get(`/xrpc/com.atproto.space.getSpace?space=${q(space)}`)).json()) as {
				uri: string;
				policy: Record<string, unknown>;
			};
		expect((await getSpace()).policy).toEqual({
			$type: "com.atproto.memberspace.policy",
			publicRead: false,
			publicWrite: false,
			publishPolicy: false,
			publishMembers: false,
		});

		expect(
			(await post("/xrpc/com.atproto.space.updateSpace", {
				space,
				policy: { ...MEMBERSPACE, publicRead: true, extra: "dropped" },
			})).status,
		).toBe(200);
		expect((await getSpace()).policy.publicRead).toBe(true);
		expect((await getSpace()).policy.extra).toBeUndefined();
		const members = await get(`/xrpc/com.atproto.memberspace.listMembers?space=${q(space)}`);
		expect(((await members.json()) as { members: unknown[] }).members).toEqual([
			{ did: BOB, read: true, write: true },
		]);

		await post("/xrpc/com.atproto.space.updateSpace", {
			space,
			policy: { $type: "com.atproto.personalspace.policy" },
		});
		expect((await getSpace()).policy).toEqual({ $type: "com.atproto.personalspace.policy" });
		const mismatch = await get(`/xrpc/com.atproto.memberspace.listMembers?space=${q(space)}`);
		expect(await errorOf(mismatch)).toBe("PolicyMismatch");
		await post("/xrpc/com.atproto.space.updateSpace", { space, policy: MEMBERSPACE });
		const after = await get(`/xrpc/com.atproto.memberspace.listMembers?space=${q(space)}`);
		expect(((await after.json()) as { members: unknown[] }).members).toEqual([]);
	});

	it("getSpace is the owner's, by session only", async () => {
		const space = await createSpace({ ...MEMBERSPACE, publicRead: true });
		const { credential, key } = await obtainCredential(space);
		const { res } = await credentialRequest(
			`/xrpc/com.atproto.space.getSpace?space=${q(space)}`,
			credential,
			key,
		);
		expect(res.status).toBe(401);
	});

	it("manage scopes gate management methods", async () => {
		const space = await createSpace();
		const readOnly = `Bearer scoped:${JSON.stringify({ actions: ["read_self"] })}`;
		const update = await post(
			"/xrpc/com.atproto.space.updateSpace",
			{ space, policy: MEMBERSPACE },
			{ Authorization: readOnly },
		);
		expect(update.status).toBe(403);
		const manager = `Bearer scoped:${JSON.stringify({ manage: ["update"] })}`;
		const member = await post(
			"/xrpc/com.atproto.memberspace.putMember",
			{ space, did: BOB, read: true, write: false },
			{ Authorization: manager },
		);
		expect(member.status).toBe(200);
		const del = await post("/xrpc/com.atproto.space.deleteSpace", { space }, { Authorization: manager });
		expect(del.status).toBe(403);
	});

	it("refuses unsupported policies and memberspace methods elsewhere", async () => {
		const res = await post("/xrpc/com.atproto.space.createSpace", {
			spaceType: "app.bsky.group",
			policy: { $type: "com.example.custom.policy" },
		});
		expect(res.status).toBe(400);
		expect(await errorOf(res)).toBe("UnsupportedPolicy");

		const managed = await createSpace({
			$type: "com.atproto.managedspace.policy",
			managingApp: "did:web:manager.test",
		});
		const put = await post("/xrpc/com.atproto.memberspace.putMember", {
			space: managed,
			did: BOB,
			read: true,
			write: true,
		});
		expect(await errorOf(put)).toBe("PolicyMismatch");

		const notOwner = await post("/xrpc/com.atproto.space.updateSpace", {
			space: `at://${BOB}/space/app.bsky.group/x`,
			policy: MEMBERSPACE,
		});
		expect(notOwner.status).toBe(404);
	});

	it("publishes the policy and member list into the authority's repo", async () => {
		const space = await createSpace({ ...MEMBERSPACE, publishPolicy: true, publishMembers: true });
		await putMember(space, BOB, true, false);
		await putMember(space, CAROL);
		const list = async () => {
			const res = await get(
				`/xrpc/com.atproto.space.listRecords?space=${q(space)}&repo=${OPERATOR}&reverse=true`,
			);
			return ((await res.json()) as {
				records: Array<{ collection: string; rkey: string; value: Record<string, unknown> }>;
			}).records;
		};
		let records = await list();
		expect(records.map((r) => `${r.collection}/${r.rkey}`)).toEqual([
			`com.atproto.memberspace.member/${BOB}`,
			`com.atproto.memberspace.member/${CAROL}`,
			"com.atproto.space.policy/self",
		]);
		expect(records[0]!.value).toEqual({
			$type: "com.atproto.memberspace.member",
			read: true,
			write: false,
		});
		expect((records[2]!.value.policy as { publishMembers: boolean }).publishMembers).toBe(true);

		await post("/xrpc/com.atproto.memberspace.removeMember", { space, did: CAROL });
		await post("/xrpc/com.atproto.space.updateSpace", {
			space,
			policy: { ...MEMBERSPACE, publishPolicy: true },
		});
		records = await list();
		expect(records.map((r) => r.collection)).toEqual(["com.atproto.space.policy"]);
	});

	it("round-trips a space through exportSpaceMeta/getRepo and their imports", async () => {
		const space = await createSpace({ ...MEMBERSPACE, publishPolicy: true });
		await putMember(space, BOB, true, false);
		await putMember(space, CAROL);
		await notifyWrite(space, CAROL, carolKeypair, tidAt(Date.now() - 1000), repoData(7));
		await createRecord(space, { $type: "app.bsky.feed.post", text: "keep me" }, "k");

		const meta = await get(`/xrpc/com.atproto.space.exportSpaceMeta?space=${q(space)}`);
		expect(meta.status).toBe(200);
		const metaBytes = new Uint8Array(await meta.arrayBuffer());
		const repo = await get(`/xrpc/com.atproto.space.getRepo?space=${q(space)}&repo=${OPERATOR}`);
		const repoBytes = new Uint8Array(await repo.arrayBuffer());

		await post("/xrpc/com.atproto.space.deleteSpace", { space });

		// The authority's repo can't arrive before its space.
		const early = await app.request("/xrpc/com.atproto.space.importRepo", {
			method: "POST",
			headers: { ...SESSION, "Content-Type": "application/octet-stream" },
			body: repoBytes,
		});
		expect(await errorOf(early)).toBe("SpaceNotFound");

		const importMeta = await app.request("/xrpc/com.atproto.space.importSpaceMeta", {
			method: "POST",
			headers: { ...SESSION, "Content-Type": "application/octet-stream" },
			body: metaBytes,
		});
		expect(importMeta.status).toBe(200);
		const importRepo = await app.request("/xrpc/com.atproto.space.importRepo", {
			method: "POST",
			headers: { ...SESSION, "Content-Type": "application/octet-stream" },
			body: repoBytes,
		});
		expect(importRepo.status).toBe(200);

		const members = await get(`/xrpc/com.atproto.memberspace.listMembers?space=${q(space)}`);
		expect(((await members.json()) as { members: unknown[] }).members).toEqual([
			{ did: BOB, read: true, write: false },
			{ did: CAROL, read: true, write: true },
		]);
		const record = await get(
			`/xrpc/com.atproto.space.getRecord?space=${q(space)}&repo=${OPERATOR}&collection=app.bsky.feed.post&rkey=k`,
		);
		expect(((await record.json()) as { value: { text: string } }).value.text).toBe("keep me");
		const { credential, key } = await obtainCredential(space, { user: { did: CAROL, keypair: carolKeypair } });
		const { res } = await credentialRequest(
			`/xrpc/com.atproto.space.listRepos?space=${q(space)}`,
			credential,
			key,
		);
		const writers = ((await res.json()) as { repos: Array<{ did: string }> }).repos.map((r) => r.did);
		expect(writers).toContain(CAROL);
	});

	it("importRepo refuses another account's archive and non-canonical records", async () => {
		const space = `at://${BOB}/space/app.bsky.group/imp${spaceN++}`;
		const record = { $type: "app.bsky.feed.post", text: "x" };
		const bytes = encode(record);
		const { cidForCbor } = await import("@atproto/lex-data");
		const cid = await cidForCbor(bytes);
		const data = new LtHash().add(`app.bsky.feed.post/r/${cid.toString()}`).digest();
		const archive = async (repo: string) => {
			const chunks: Uint8Array[] = [];
			for await (const chunk of serializeRepo(
				{ ver: 1, repo: repo as never, space: space as never, rev: tidAt(Date.now()), data },
				[{ collection: "app.bsky.feed.post" as never, rkey: "r" as never, bytes }],
			)) {
				chunks.push(chunk);
			}
			return new Uint8Array(await new Blob(chunks).arrayBuffer());
		};
		const send = async (body: Uint8Array) =>
			app.request("/xrpc/com.atproto.space.importRepo", {
				method: "POST",
				headers: { ...SESSION, "Content-Type": "application/octet-stream" },
				body,
			});
		const theirs = await send(await archive(BOB));
		expect(theirs.status).toBe(400);
		const ours = await archive(OPERATOR);
		// Sanity: the archive is readable before import.
		const read = await readRepoStar([ours]);
		await read[Symbol.asyncDispose]();
		expect((await send(ours)).status).toBe(200);
	});
});
