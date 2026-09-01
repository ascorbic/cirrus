import { Secp256k1Keypair } from "@atproto/crypto";
import {
	MemoryBlockstore,
	Repo,
	WriteOpAction,
	getRecords,
} from "@atproto/repo";
import type { DidDocumentResolver } from "@atcute/identity-resolver";
import type { Nsid } from "@atcute/lexicons/syntax";
import { beforeAll, describe, expect, it } from "vitest";
import { createAtcutePermissionSetResolver } from "../src/permission-sets.js";

/**
 * These tests cover the spaces-alpha workaround in `resolveSpaceDeclaration`:
 * `@atcute/lexicon-resolver` can't parse a `type: "space"` lexicon document
 * (its def-type whitelist has no "space"), so the resolver replicates the
 * fetch + signature-proof steps itself. The fixtures below build a real
 * proof CAR with `@atproto/repo` (exactly what `com.atproto.sync.getRecord`
 * returns) and feed it through a mocked network so we exercise the true
 * `@atcute/repo` verification path — not a stub.
 */

const LEXICON_COLLECTION = "com.atproto.lexicon.schema";
const NSID = "earth.cirrus.check.space" as Nsid;
const AUTHORITY_DID = "did:web:pds.example";
const PDS_ENDPOINT = "https://pds.example/";
const DOH_URL = "https://doh.example/dns-query";

const SPACE_RECORD = {
	$type: LEXICON_COLLECTION,
	lexicon: 1,
	id: NSID,
	defs: {
		main: {
			type: "space",
			name: "Cirrus Check",
			collections: ["earth.cirrus.check.item", "earth.cirrus.check.result"],
		},
	},
};

/** Build the signed proof CAR a PDS would return for `record`. */
async function buildProofCar(
	keypair: Secp256k1Keypair,
	record: Record<string, unknown>,
): Promise<Uint8Array> {
	const storage = new MemoryBlockstore();
	const repo = await Repo.create(storage, AUTHORITY_DID, keypair, [
		{
			action: WriteOpAction.Create,
			collection: LEXICON_COLLECTION,
			rkey: NSID,
			record,
		},
	]);
	const chunks: Uint8Array[] = [];
	for await (const chunk of getRecords(storage, repo.cid, [
		{ collection: LEXICON_COLLECTION, rkey: NSID },
	])) {
		chunks.push(chunk);
	}
	const total = chunks.reduce((n, c) => n + c.length, 0);
	const car = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		car.set(chunk, offset);
		offset += chunk.length;
	}
	return car;
}

/** A DID document exposing `publicKeyMultibase` as its `#atproto` key. */
function didDocument(publicKeyMultibase: string) {
	return {
		id: AUTHORITY_DID,
		verificationMethod: [
			{
				id: `${AUTHORITY_DID}#atproto`,
				type: "Multikey",
				controller: AUTHORITY_DID,
				publicKeyMultibase,
			},
		],
		service: [
			{
				id: `${AUTHORITY_DID}#atproto_pds`,
				type: "AtprotoPersonalDataServer",
				serviceEndpoint: PDS_ENDPOINT,
			},
		],
	};
}

function dohResponse(): Response {
	return new Response(
		JSON.stringify({
			Status: 0,
			TC: false,
			RD: true,
			RA: true,
			AD: false,
			CD: false,
			Question: [{ name: `_lexicon.check.cirrus.earth`, type: 16 }],
			Answer: [
				{
					name: `_lexicon.check.cirrus.earth`,
					type: 16,
					TTL: 300,
					data: `did=${AUTHORITY_DID}`,
				},
			],
		}),
		{ headers: { "content-type": "application/dns-json" } },
	);
}

/**
 * Wire up the resolver with a fetch mock that answers the DoH authority
 * lookup and the `com.atproto.sync.getRecord` CAR fetch, plus a DID-document
 * resolver returning `didDoc`.
 */
function makeResolver(car: Uint8Array, publicKeyMultibase: string) {
	const didDocumentResolver: DidDocumentResolver = {
		resolve: async () =>
			didDocument(publicKeyMultibase) as unknown as Awaited<
				ReturnType<DidDocumentResolver["resolve"]>
			>,
	};
	const fetch: typeof globalThis.fetch = async (input) => {
		const url = new URL(
			typeof input === "string" || input instanceof URL ? input : input.url,
		);
		if (url.pathname === "/xrpc/com.atproto.sync.getRecord") {
			return new Response(car, {
				headers: { "content-type": "application/vnd.ipld.car" },
			});
		}
		if (url.searchParams.get("type") === "TXT") {
			return dohResponse();
		}
		throw new Error(`unexpected fetch: ${url}`);
	};
	return createAtcutePermissionSetResolver({
		dohUrl: DOH_URL,
		didDocumentResolver,
		fetch,
	});
}

let keypair: Secp256k1Keypair;
let multikey: string;

beforeAll(async () => {
	keypair = await Secp256k1Keypair.create();
	multikey = keypair.did().slice("did:key:".length);
});

describe("resolveSpaceDeclaration", () => {
	it('resolves a proof-verified `type: "space"` declaration', async () => {
		const car = await buildProofCar(keypair, SPACE_RECORD);
		const resolver = makeResolver(car, multikey);

		const decl = await resolver.resolveSpaceDeclaration!(NSID);

		expect(decl).not.toBeNull();
		expect(decl?.type).toBe("space");
		expect(decl?.name).toBe("Cirrus Check");
		expect(decl?.collections).toEqual([
			"earth.cirrus.check.item",
			"earth.cirrus.check.result",
		]);
	});

	it("rejects an unproven record signed by a different key", async () => {
		const car = await buildProofCar(keypair, SPACE_RECORD);
		// DID document advertises someone else's key, so the commit signature
		// won't verify — proving we didn't drop proof verification.
		const attacker = await Secp256k1Keypair.create();
		const resolver = makeResolver(car, attacker.did().slice("did:key:".length));

		await expect(resolver.resolveSpaceDeclaration!(NSID)).rejects.toThrow(
			/signature verification failed/,
		);
	});

	it("rejects a tampered proof CAR", async () => {
		const car = await buildProofCar(keypair, SPACE_RECORD);
		const last = car.length - 1;
		car[last] = (car[last] ?? 0) ^ 0xff;
		const resolver = makeResolver(car, multikey);

		await expect(resolver.resolveSpaceDeclaration!(NSID)).rejects.toThrow();
	});

	it("returns null for a non-space declaration", async () => {
		const permissionSet = {
			$type: LEXICON_COLLECTION,
			lexicon: 1,
			id: NSID,
			defs: {
				main: {
					type: "permission-set",
					permissions: [{ type: "repo", collection: "app.bsky.feed.post" }],
				},
			},
		};
		const car = await buildProofCar(keypair, permissionSet);
		const resolver = makeResolver(car, multikey);

		expect(await resolver.resolveSpaceDeclaration!(NSID)).toBeNull();
	});

	it("rejects a space declaration with non-NSID collections", async () => {
		const bad = {
			$type: LEXICON_COLLECTION,
			lexicon: 1,
			id: NSID,
			defs: {
				main: {
					type: "space",
					name: "Broken",
					collections: ["not a valid nsid"],
				},
			},
		};
		const car = await buildProofCar(keypair, bad);
		const resolver = makeResolver(car, multikey);

		await expect(resolver.resolveSpaceDeclaration!(NSID)).rejects.toThrow(
			/invalid collections/,
		);
	});
});
