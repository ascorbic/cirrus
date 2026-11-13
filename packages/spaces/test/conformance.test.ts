/**
 * The conformance suite, run in-process against Cirrus's own space routes.
 *
 * Every capability except the PDS-level ones runs here. Harness identities
 * are did:key, which self-describe their key, so this fixture resolves them
 * without a network. Every outbound call — the routes' own and the space
 * DO alarm's notification deliveries — is routed to an in-process syncer
 * inbox, so fan-out and managing-app checks see real deliveries.
 *
 * Blob isolation and delegation minting need PDS-level endpoints outside
 * the space routes (`pds-blobs`, `pds-delegation`); the PDS integration
 * test covers those.
 */

import { env } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { Context } from "hono";
import {
	P256Keypair,
	Secp256k1Keypair,
	verifySignature,
} from "@atproto/crypto";
import {
	ALPHA_BUILD,
	createSyncerInbox,
	filterCatalog,
	runChecks,
} from "@getcirrus/space-conformance";
import {
	KeypairIdentityProvider,
	fullCatalog,
} from "@getcirrus/space-conformance/full";
import { createSpaceRoutes } from "../src/routes";
import type { SpaceRoutesHost } from "../src/routes";
import {
	TEST_KEM_KEY,
	TEST_OPERATOR_DID,
	TEST_SIGNING_KEY,
} from "./fixtures/spaces-worker/index";

const OPERATOR = TEST_OPERATOR_DID;
const ORIGIN = "https://pds.test";
/** The harness syncer / managing app: a did:web whose host is the inbox. */
const INBOX_DID = "did:web:inbox.test";
const INBOX_ORIGIN = "https://inbox.test";
/** Where notifications to a harness (did:key) authority are delivered. */
const AUTHORITY_ORIGIN = "https://authority.test";

const operatorKeypair = await Secp256k1Keypair.import(TEST_SIGNING_KEY);
const kemKeypair = await P256Keypair.import(TEST_KEM_KEY);

/** The suite's syncer inbox, also answering managing-app queries. */
const { inbox, handle: inboxHandle } = createSyncerInbox({
	endpoint: INBOX_ORIGIN,
	service: `${INBOX_DID}#atproto_space_syncer`,
});

/** Outbound fetch: harness services are answered in-process. */
const routedFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
	const req = new Request(input as RequestInfo, init);
	const { origin } = new URL(req.url);
	if (origin === INBOX_ORIGIN || origin === AUTHORITY_ORIGIN) {
		return inboxHandle(req);
	}
	return new Response("unroutable in the conformance fixture", { status: 502 });
}) as typeof fetch;

/** did:key → itself; the operator from the env. */
async function signingKeyFor(iss: string): Promise<string> {
	if (iss === OPERATOR) return operatorKeypair.did();
	if (iss.startsWith("did:key:")) return iss;
	throw new Error(`unknown issuer: ${iss}`);
}

function b64urlDecode(part: string): Uint8Array {
	const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
	return Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
}

/** Real service-auth verification against the issuer's key. */
async function verifyServiceJwt(token: string, lxm: string) {
	const [header, payload, sig] = token.split(".") as [string, string, string];
	const claims = JSON.parse(
		new TextDecoder().decode(b64urlDecode(payload)),
	) as {
		iss: string;
		aud: string;
		lxm?: string;
		exp?: number;
	};
	if (claims.lxm !== lxm) throw new Error(`service JWT not bound to ${lxm}`);
	if (!claims.exp || claims.exp < Math.floor(Date.now() / 1000) - 5) {
		throw new Error("service JWT expired");
	}
	const valid = await verifySignature(
		await signingKeyFor(claims.iss),
		new TextEncoder().encode(`${header}.${payload}`),
		b64urlDecode(sig),
	);
	if (!valid) throw new Error("invalid service JWT signature");
	return { iss: claims.iss, aud: claims.aud };
}

function buildTarget() {
	const host: SpaceRoutesHost = {
		operatorDid: OPERATOR,
		// No blobs: the pds-blobs capability is not offered by this fixture.
		getKeypair: async () => operatorKeypair,
		getKemPrivateKey: () => TEST_KEM_KEY,
		getSigningKey: (iss) => signingKeyFor(iss),
		resolveServiceEndpoint: async (service) => {
			const did = service.split("#")[0]!;
			if (did === OPERATOR) return ORIGIN;
			if (did === INBOX_DID) return INBOX_ORIGIN;
			if (did.startsWith("did:key:")) return AUTHORITY_ORIGIN;
			return null;
		},
		verifyServiceJwt,
		authenticate: async (c: Context) => {
			if (c.req.header("Authorization") === "Bearer operator-session") {
				return { did: OPERATOR, fullTrust: true, allowsSpace: () => true };
			}
			return c.json({ error: "AuthMissing", message: "no session" }, 401);
		},
		validateRecord: ({ record }) => ({ record, status: "unknown" }),
		getSpaceDO: (uri) => env.SPACES.get(env.SPACES.idFromName(uri)) as never,
		getIndexDO: () =>
			env.SPACES_INDEX.get(env.SPACES_INDEX.idFromName("spaces")) as never,
		outboundFetch: routedFetch,
	};

	const app = new Hono();
	// The discovery document the suite probes: #atproto_pds, #atproto and
	// the P-256 #atproto_kem syncers derive MAC secrets against.
	app.get("/.well-known/did.json", (c) =>
		c.json({
			"@context": [
				"https://www.w3.org/ns/did/v1",
				"https://w3id.org/security/multikey/v1",
			],
			id: OPERATOR,
			verificationMethod: [
				{
					id: `${OPERATOR}#atproto`,
					type: "Multikey",
					controller: OPERATOR,
					publicKeyMultibase: operatorKeypair.did().slice("did:key:".length),
				},
				{
					id: `${OPERATOR}#atproto_kem`,
					type: "Multikey",
					controller: OPERATOR,
					publicKeyMultibase: kemKeypair.did().slice("did:key:".length),
				},
			],
			service: [
				{
					id: "#atproto_pds",
					type: "AtprotoPersonalDataServer",
					serviceEndpoint: ORIGIN,
				},
			],
		}),
	);
	app.route("/", createSpaceRoutes(host));

	const fetchAdapter: typeof fetch = (input, init) =>
		app.fetch(new Request(input as RequestInfo, init));
	return { fetchAdapter };
}

describe("conformance suite vs Cirrus space routes", () => {
	// The space DO's alarm delivers notifications with the global fetch.
	const realFetch = globalThis.fetch;
	beforeAll(() => {
		globalThis.fetch = routedFetch;
	});
	afterAll(() => {
		globalThis.fetch = realFetch;
	});

	it(
		"passes every runnable must and should check",
		{ timeout: 180_000 },
		async () => {
			const { fetchAdapter } = buildTarget();
			const catalog = filterCatalog(fullCatalog, {
				capabilities: ["operator", "identities", "syncer-inbox", "alpha-libs"],
				destructive: true,
			});
			const report = await runChecks({
				catalog,
				context: {
					target: { origin: ORIGIN, did: OPERATOR, implementation: "cirrus" },
					fetch: fetchAdapter,
					operator: {
						oauth: false,
						async authorize(reqInit) {
							reqInit.headers.set("Authorization", "Bearer operator-session");
						},
					},
					identities: new KeypairIdentityProvider(),
					syncerInbox: inbox,
				},
				suiteVersion: "in-process",
				alphaBuild: ALPHA_BUILD,
			});

			const failures = report.results.filter(
				(r) =>
					(r.status === "fail" || r.status === "error") && r.tier !== "info",
			);
			// Surface every failing check's detail so a regression is legible.
			if (failures.length > 0) {
				throw new Error(
					`conformance failures:\n${failures
						.map((f) => `  [${f.tier}] ${f.id}: ${f.status} — ${f.detail}`)
						.join("\n")}`,
				);
			}

			const byId = Object.fromEntries(
				report.results.map((r) => [r.id, r.status]),
			);
			// Everything this fixture can offer actually ran.
			const skipped = report.results
				.filter((r) => r.status === "skipped")
				.map((r) => r.id)
				.sort();
			expect(skipped).toEqual(
				[
					"blobs.listblobs-and-getblob",
					"blobs.space-blob-not-public",
					"credential.self-round-trip",
					"delegation.replay-refused",
					"delegation.signed-by-user",
					"delegation.token-claims",
					"delegation.wrong-space-refused",
					// Slow: waits out the real credential lifetime.
					"notify.registration-expired",
				].sort(),
			);
			for (const id of [
				"credential.member-gate",
				"sync.oplog-folds-to-commit",
				"sync.getrepo-star",
				"credential.deleted-space",
				"revocation.revoked-credential-refused",
				"notify.registration-confirmed",
				"notify.repo-write-delivered",
				"notify.repo-removed-delivered",
				"notify.space-deleted-delivered",
				"managedspace.check-access-account",
				"managedspace.unreachable-app-upstream-failure",
			]) {
				expect(byId[id], id).toBe("pass");
			}
		},
	);
});
