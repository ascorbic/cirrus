/**
 * The conformance suite, run in-process against Cirrus's own space routes.
 *
 * This is the runner that exercises the crypto-bound catalog end to end:
 * harness reader identities (did:key) are resolved by this fixture's
 * `getSigningKey`, so the full delegation → credential → read dance and the
 * host-role checks actually execute against the real route handlers.
 *
 * Blob isolation needs PDS-level endpoints outside the space routes, so it
 * declares the `pds-blobs` capability this fixture does not provide and is
 * reported as skipped here; the PDS integration test covers it.
 */

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { Context } from "hono";
import { Secp256k1Keypair } from "@atproto/crypto";
import { filterCatalog, runChecks } from "@getcirrus/space-conformance";
import {
	KeypairIdentityProvider,
	fullCatalog,
} from "@getcirrus/space-conformance/full";
import { createSpaceRoutes } from "../src/routes";
import type { SpaceRoutesHost } from "../src/routes";
import { TEST_OPERATOR_DID, TEST_SIGNING_KEY } from "./fixtures/spaces-worker/index";

const OPERATOR = TEST_OPERATOR_DID;
const ORIGIN = "https://pds.test";

const operatorKeypair = await Secp256k1Keypair.import(TEST_SIGNING_KEY);

function buildTarget() {
	const host: SpaceRoutesHost = {
		operatorDid: OPERATOR,
		publicOrigin: ORIGIN,
		// No blobs: the pds-blobs capability is not offered by this fixture.
		getKeypair: async () => operatorKeypair,
		getSigningKey: async (iss) => {
			if (iss === OPERATOR) return operatorKeypair.did();
			// Harness identities are did:key, which self-describe their key.
			if (iss.startsWith("did:key:")) return iss;
			throw new Error(`unknown issuer: ${iss}`);
		},
		resolveServiceEndpoint: async () => null,
		resolveAuthorityEndpoint: async () => null,
		verifyServiceJwt: async () => {
			throw new Error("service auth not exercised by the conformance run");
		},
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
	};

	const spaceApp = createSpaceRoutes(host);
	// Wrap the space routes with the discovery document the suite probes.
	const app = new Hono();
	app.get("/.well-known/did.json", (c) =>
		c.json({
			id: OPERATOR,
			service: [
				{
					id: "#atproto_space_host",
					type: "AtprotoSpaceHost",
					serviceEndpoint: ORIGIN,
				},
			],
			verificationMethod: [{ id: `${OPERATOR}#atproto` }],
		}),
	);
	app.route("/", spaceApp);

	const fetchAdapter: typeof fetch = (input, init) =>
		app.fetch(new Request(input as RequestInfo, init));
	return { fetchAdapter };
}

describe("conformance suite vs Cirrus space routes", () => {
	it("passes every runnable must and should check", async () => {
		const { fetchAdapter } = buildTarget();
		const catalog = filterCatalog(fullCatalog, {
			capabilities: ["operator", "identities"],
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
			},
			suiteVersion: "in-process",
			alphaBuild: "0.0.0-spaces-alpha-20260818163953",
		});

		const failures = report.results.filter(
			(r) => r.status === "fail" || r.status === "error",
		);
		// Surface every failing check's detail so a regression is legible.
		if (failures.length > 0) {
			throw new Error(
				`conformance failures:\n${failures
					.map((f) => `  [${f.tier}] ${f.id}: ${f.status} — ${f.detail}`)
					.join("\n")}`,
			);
		}

		// A meaningful number of checks actually ran (not all skipped).
		const ran = report.results.filter((r) => r.status === "pass");
		expect(ran.length).toBeGreaterThanOrEqual(15);
		// The credential dance, delegation refusals and host gating ran here.
		const byId = Object.fromEntries(report.results.map((r) => [r.id, r.status]));
		expect(byId["credential.round-trip"]).toBe("pass");
		expect(byId["delegation.replay-refused"]).toBe("pass");
		expect(byId["host.member-list-gates"]).toBe("pass");
		expect(byId["sync.oplog-folds-to-commit"]).toBe("pass");
		expect(byId["host.delete-space-tombstone"]).toBe("pass");
		// Blob isolation needs a full PDS — skipped here, covered elsewhere.
		expect(byId["blobs.space-blob-not-public"]).toBe("skipped");
	});
});
