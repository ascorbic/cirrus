/**
 * The PDS's own spaces host adapter (src/spaces.ts), end to end through the
 * worker: foreign service-auth verification, foreign DID resolution for
 * delegation tokens and managing apps, OAuth `space:` scopes, and the
 * deactivated-account gate.
 *
 * The engine's route tests use test doubles for all of these, and the PDS
 * conformance run has no foreign identities, so this is the only place the
 * production implementations run. Foreign DID documents and the managing
 * app are served by a stubbed global fetch: the DID resolver goes through
 * `globalThis.fetch` at call time for exactly this reason. Each test uses
 * its own DIDs, because resolved documents are cached across tests.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { P256Keypair, Secp256k1Keypair } from "@atproto/crypto";
import {
	LtHash,
	createDelegationToken,
	spaceHostAud,
	writeRepoStar,
} from "@atproto/space";
import { encode } from "@atproto/lex-cbor";
import {
	CODEC_DCBOR,
	create as createCid,
	toString as cidToString,
} from "@atcute/cid";
import { now as tidNow } from "@atcute/tid";
import {
	SignJWT,
	base64url,
	calculateJwkThumbprint,
	exportJWK,
	generateKeyPair,
} from "jose";
import { createServiceJwt } from "../src/service-auth";
import { env, worker } from "./helpers";

type Did = `did:${string}:${string}`;
const OPERATOR = env.DID as Did;
const ORIGIN = "http://pds.test";
const operator = {
	"Content-Type": "application/json",
	Authorization: `Bearer ${env.AUTH_TOKEN}`,
};

afterEach(() => {
	vi.unstubAllGlobals();
});

function call(path: string, init: RequestInit = {}) {
	return worker.fetch(new Request(`${ORIGIN}${path}`, init), env);
}
function post(path: string, body: unknown, headers: Record<string, string>) {
	return call(path, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...headers },
		body: JSON.stringify(body),
	});
}
async function errorOf(res: Response): Promise<string | undefined> {
	return ((await res.clone().json()) as { error?: string }).error;
}

let n = 0;
async function createSpace(
	policy: Record<string, unknown>,
	spaceType = "app.bsky.group",
): Promise<string> {
	const res = await post(
		"/xrpc/com.atproto.space.createSpace",
		{ spaceType, skey: `adapter${n++}x`, policy },
		operator,
	);
	expect(res.status).toBe(200);
	return ((await res.json()) as { space: string }).space;
}
const memberspace = (extra: Record<string, unknown> = {}) => ({
	$type: "com.atproto.memberspace.policy",
	...extra,
});

/** A did:web whose document the stubbed fetch serves. */
interface Foreign {
	did: Did;
	host: string;
	keypair: Secp256k1Keypair;
	services?: Array<{ id: string; type: string; serviceEndpoint: string }>;
}
async function foreign(name: string): Promise<Foreign> {
	const host = `${name}-${n++}.adapter.test`;
	return {
		did: `did:web:${host}` as Did,
		host,
		keypair: await Secp256k1Keypair.create(),
	};
}
function didDocument(f: Foreign) {
	return {
		"@context": [
			"https://www.w3.org/ns/did/v1",
			"https://w3id.org/security/multikey/v1",
		],
		id: f.did,
		verificationMethod: [
			{
				id: `${f.did}#atproto`,
				type: "Multikey",
				controller: f.did,
				publicKeyMultibase: f.keypair.did().slice("did:key:".length),
			},
		],
		service: f.services ?? [],
	};
}

interface Served {
	url: string;
	init?: RequestInit;
}
/**
 * Stub the global fetch: DID documents for the given identities, plus any
 * extra routes. Everything else is a network error, as for an unknown host.
 */
function serve(
	identities: Foreign[],
	routes: Record<string, (req: Request) => Response | Promise<Response>> = {},
): Served[] {
	const seen: Served[] = [];
	vi.stubGlobal(
		"fetch",
		async (input: RequestInfo | URL, init?: RequestInit) => {
			// Validate the init the way workerd does, so unsupported options fail.
			const req = new Request(input as RequestInfo, init);
			seen.push({ url: req.url, init });
			for (const f of identities) {
				if (req.url === `https://${f.host}/.well-known/did.json`) {
					return Response.json(didDocument(f));
				}
			}
			const route = routes[req.url.split("?")[0]!];
			if (route) return route(req);
			throw new TypeError(`fetch failed: no route to ${req.url}`);
		},
	);
	return seen;
}

function notifyRepoUpdate(
	space: string,
	repo: Did,
	token: string,
): Promise<Response> {
	return post(
		"/xrpc/com.atproto.space.notifyRepoUpdate",
		{
			space,
			repo,
			repoRev: tidNow(),
			data: {
				$bytes: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))),
			},
		},
		{ Authorization: `Bearer ${token}` },
	);
}
const NOTIFY_LXM = "com.atproto.space.notifyRepoUpdate";

async function putMember(space: string, did: Did) {
	const res = await post(
		"/xrpc/com.atproto.memberspace.putMembers",
		{ space, members: [{ did, read: true, write: true }] },
		operator,
	);
	expect(res.status).toBe(200);
}

async function authorizeSpaceSync(
	space: string,
	delegationToken?: string,
): Promise<Response> {
	const key = await P256Keypair.create();
	return post(
		"/xrpc/com.atproto.space.authorizeSpaceSync",
		{
			space,
			credentialKey: key.did(),
			...(delegationToken ? { delegationToken } : {}),
		},
		{},
	);
}

describe("spaces host adapter: inbound service auth", () => {
	it("accepts a foreign notifyRepoUpdate signed with the writer's #atproto key, and refuses a forged one", async () => {
		const bob = await foreign("bob");
		const space = await createSpace(memberspace());
		await putMember(space, bob.did);
		serve([bob]);

		const signed = await createServiceJwt({
			iss: bob.did,
			aud: OPERATOR,
			lxm: NOTIFY_LXM,
			keypair: bob.keypair,
		});
		const ok = await notifyRepoUpdate(space, bob.did, signed);
		expect(ok.status).toBe(200);

		const forged = await createServiceJwt({
			iss: bob.did,
			aud: OPERATOR,
			lxm: NOTIFY_LXM,
			keypair: await Secp256k1Keypair.create(),
		});
		const refused = await notifyRepoUpdate(space, bob.did, forged);
		expect(refused.status).toBe(401);
		expect(await errorOf(refused)).toBe("AuthenticationRequired");

		const wrongLxm = await createServiceJwt({
			iss: bob.did,
			aud: OPERATOR,
			lxm: "com.atproto.space.notifyCredentialsRevoked",
			keypair: bob.keypair,
		});
		expect((await notifyRepoUpdate(space, bob.did, wrongLxm)).status).toBe(401);
	});

	it("re-resolves the writer's DID document when a signature fails, so key rotation verifies", async () => {
		const bob = await foreign("rotating");
		const space = await createSpace(memberspace());
		await putMember(space, bob.did);
		serve([bob]);
		const sign = (keypair: Secp256k1Keypair) =>
			createServiceJwt({
				iss: bob.did,
				aud: OPERATOR,
				lxm: NOTIFY_LXM,
				keypair,
			});

		// First call resolves and caches the document with the original key.
		expect(
			(await notifyRepoUpdate(space, bob.did, await sign(bob.keypair))).status,
		).toBe(200);

		// The writer rotates: the published document now has a new key, the
		// cache still has the old one.
		bob.keypair = await Secp256k1Keypair.create();
		expect(
			(await notifyRepoUpdate(space, bob.did, await sign(bob.keypair))).status,
		).toBe(200);

		// A key in neither document still fails after the refresh.
		const stranger = await Secp256k1Keypair.create();
		expect(
			(await notifyRepoUpdate(space, bob.did, await sign(stranger))).status,
		).toBe(401);
	});
});

describe("spaces host adapter: foreign DID resolution", () => {
	it("verifies a foreign member's delegation token against their DID document", async () => {
		const bob = await foreign("member");
		const space = await createSpace(memberspace());
		await putMember(space, bob.did);
		serve([bob]);

		const token = await createDelegationToken({
			iss: bob.did,
			sub: space as never,
			aud: spaceHostAud(OPERATOR),
			keypair: bob.keypair,
		});
		const res = await authorizeSpaceSync(space, token);
		expect(res.status).toBe(200);
		expect(
			((await res.json()) as { credential?: string }).credential,
		).toBeTruthy();

		// Signed by a key the document doesn't publish.
		const forged = await createDelegationToken({
			iss: bob.did,
			sub: space as never,
			aud: spaceHostAud(OPERATOR),
			keypair: await Secp256k1Keypair.create(),
		});
		const refused = await authorizeSpaceSync(space, forged);
		expect(refused.status).toBe(400);
		expect(await errorOf(refused)).toBe("InvalidDelegationToken");
	});

	it("resolves a managing app's did#service endpoint and asks it with service auth", async () => {
		const app = await foreign("forum");
		app.services = [
			{
				id: "#forum",
				type: "ForumService",
				serviceEndpoint: `https://api.${app.host}`,
			},
		];
		const bob = await foreign("forumgoer");
		const managingApp = `${app.did}#forum`;
		const space = await createSpace({
			$type: "com.atproto.managedspace.policy",
			managingApp,
		});
		const checkAccessUrl = `https://api.${app.host}/xrpc/com.atproto.managedspace.checkAccess`;
		const seen = serve([app, bob], {
			[checkAccessUrl]: (req) => {
				const repo = new URL(req.url).searchParams.get("repo");
				return Response.json({ read: repo === bob.did, write: false });
			},
		});

		const token = await createDelegationToken({
			iss: bob.did,
			sub: space as never,
			aud: spaceHostAud(OPERATOR),
			keypair: bob.keypair,
		});
		const granted = await authorizeSpaceSync(space, token);
		expect(granted.status).toBe(200);

		const check = seen.find((s) => s.url.startsWith(checkAccessUrl));
		expect(check).toBeDefined();
		const auth = new Headers(check!.init?.headers).get("Authorization") ?? "";
		const claims = JSON.parse(
			atob(
				auth
					.slice("Bearer ".length)
					.split(".")[1]!
					.replace(/-/g, "+")
					.replace(/_/g, "/"),
			),
		) as { iss: string; aud: string; lxm: string };
		expect(claims).toMatchObject({
			iss: OPERATOR,
			aud: managingApp,
			lxm: "com.atproto.managedspace.checkAccess",
		});

		// The app says no to an anonymous reader.
		expect((await authorizeSpaceSync(space)).status).toBe(404);
	});
});

describe("spaces host adapter: OAuth space scopes", () => {
	async function dpopSession(scope: string) {
		const { privateKey, publicKey } = await generateKeyPair("ES256");
		const jwk = await exportJWK(publicKey);
		delete jwk.key_ops;
		delete jwk.ext;
		const accessToken = `space-scope-${crypto.randomUUID()}`;
		const now = Date.now();
		const stub = env.ACCOUNT.get(env.ACCOUNT.idFromName("account"));
		await (
			await stub.authStore()
		).saveTokens({
			accessToken,
			refreshToken: `${accessToken}-refresh`,
			clientId: "https://app.example/client-metadata.json",
			sub: OPERATOR,
			scope,
			dpopJkt: await calculateJwkThumbprint(jwk, "sha256"),
			issuedAt: now,
			accessExpiresAt: now + 60 * 60 * 1000,
			refreshExpiresAt: now + 24 * 60 * 60 * 1000,
			revoked: false,
		});
		return async (
			method: string,
			url: string,
		): Promise<Record<string, string>> => {
			const ath = base64url.encode(
				new Uint8Array(
					await crypto.subtle.digest(
						"SHA-256",
						new TextEncoder().encode(accessToken),
					),
				),
			);
			const proof = await new SignJWT({
				jti: crypto.randomUUID(),
				htm: method,
				htu: url,
				iat: Math.floor(Date.now() / 1000),
				ath,
			})
				.setProtectedHeader({ typ: "dpop+jwt", alg: "ES256", jwk })
				.sign(privateKey);
			return { Authorization: `DPoP ${accessToken}`, DPoP: proof };
		};
	}

	it("allows writes the space: grant covers and refuses other space types and collections", async () => {
		const granted = await createSpace(memberspace(), "app.bsky.group");
		const other = await createSpace(memberspace(), "app.bsky.othergroup");
		const headers = await dpopSession(
			`atproto space:app.bsky.group?authority=${OPERATOR}&collection=test.cirrus.note`,
		);
		const url = `${ORIGIN}/xrpc/com.atproto.space.createRecord`;
		const write = async (space: string, collection: string) =>
			post(
				"/xrpc/com.atproto.space.createRecord",
				{
					space,
					repo: OPERATOR,
					collection,
					record: { $type: collection, text: "x" },
				},
				await headers("POST", url),
			);

		expect((await write(granted, "test.cirrus.note")).status).toBe(200);
		const wrongType = await write(other, "test.cirrus.note");
		expect(wrongType.status).toBe(403);
		const wrongCollection = await write(granted, "test.cirrus.other");
		expect(wrongCollection.status).toBe(403);
	});

	it("importRepo needs a grant covering every collection of the space", async () => {
		// A repo for a space hosted elsewhere, as an account migration moves it.
		const space = `at:space/did:web:elsewhere-${n++}.adapter.test/app.bsky.group/imported`;
		const record = { $type: "test.cirrus.note", text: "migrated" };
		const recordBytes = encode(record as never);
		const recordCid = cidToString(await createCid(CODEC_DCBOR, recordBytes));
		const data = new LtHash().add(`test.cirrus.note/n/${recordCid}`).digest();
		const chunks: Uint8Array[] = [];
		for await (const chunk of writeRepoStar(
			{
				ver: 1,
				repo: OPERATOR,
				space: space as never,
				rev: tidNow() as never,
				data,
			},
			[
				{
					collection: "test.cirrus.note" as never,
					rkey: "n" as never,
					bytes: recordBytes,
				},
			],
		)) {
			chunks.push(chunk);
		}
		const archive = new Uint8Array(await new Blob(chunks).arrayBuffer());
		const url = `${ORIGIN}/xrpc/com.atproto.space.importRepo`;
		const importWith = async (scope: string) => {
			const headers = await dpopSession(scope);
			return call("/xrpc/com.atproto.space.importRepo", {
				method: "POST",
				headers: {
					"Content-Type": "application/vnd.dasl.star",
					...(await headers("POST", url)),
				},
				body: archive,
			});
		};
		const authority = space.split("/")[1]!;

		// Writes to the archive's one collection are not enough.
		const narrow = await importWith(
			`atproto space:app.bsky.group?authority=${authority}&collection=test.cirrus.note`,
		);
		expect(narrow.status).toBe(403);
		expect(await errorOf(narrow)).toBe("InsufficientScope");

		// collection=* covers every collection, which "*" checks require.
		const full = await importWith(
			`atproto space:app.bsky.group?authority=${authority}&collection=*`,
		);
		expect(full.status).toBe(200);
	});
});

describe("spaces host adapter: account status", () => {
	it("refuses to issue credentials while the account is deactivated", async () => {
		const space = await createSpace(memberspace({ publicRead: true }));
		expect((await authorizeSpaceSync(space)).status).toBe(200);
		const deactivate = await post(
			"/xrpc/com.atproto.server.deactivateAccount",
			{},
			operator,
		);
		expect(deactivate.status).toBe(200);
		try {
			const refused = await authorizeSpaceSync(space);
			expect(await errorOf(refused)).toBe("RepoDeactivated");
		} finally {
			const activate = await post(
				"/xrpc/com.atproto.server.activateAccount",
				{},
				operator,
			);
			expect(activate.status).toBe(200);
		}
		expect((await authorizeSpaceSync(space)).status).toBe(200);
	});
});
