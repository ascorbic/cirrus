import { beforeAll, describe, expect, it } from "vitest";
import { P256Keypair, Secp256k1Keypair } from "@atproto/crypto";
import { runConformance } from "../src/cli/run";
import { OAUTH_SCOPE, originGatedFetch } from "../src/cli/oauth";

const DID = "did:web:target.test";

/** A DID document carrying everything the alpha requires of an authority. */
let didDoc: Record<string, unknown>;
beforeAll(async () => {
	const signing = await Secp256k1Keypair.create();
	const kem = await P256Keypair.create();
	didDoc = {
		id: DID,
		verificationMethod: [
			{
				id: `${DID}#atproto`,
				type: "Multikey",
				controller: DID,
				publicKeyMultibase: signing.did().slice(8),
			},
			{
				id: `${DID}#atproto_kem`,
				type: "Multikey",
				controller: DID,
				publicKeyMultibase: kem.did().slice(8),
			},
		],
		service: [
			{
				id: "#atproto_pds",
				type: "AtprotoPersonalDataServer",
				serviceEndpoint: "https://target.test",
			},
		],
	};
});

/**
 * A minimal fake target: a valid DID document plus refusing endpoints.
 * Enough to exercise the base (no-crypto) checks and prove the crypto
 * checks skip cleanly when no operator/identities are supplied.
 */
function fakeTarget(): typeof fetch {
	return (async (input: RequestInfo | URL) => {
		const url = new URL(String(input));
		if (url.pathname === "/.well-known/did.json") {
			return Response.json(didDoc);
		}
		if (url.pathname.startsWith("/xrpc/com.atproto.space.getLatestCommit")) {
			return Response.json({ error: "InvalidRequest" }, { status: 400 });
		}
		if (url.pathname === "/xrpc/com.atproto.space.authorizeSpaceSync") {
			return Response.json({ error: "SpaceNotFound" }, { status: 400 });
		}
		// Everything else (space reads) is unauthenticated.
		return Response.json({ error: "AuthMissing" }, { status: 401 });
	}) as typeof fetch;
}

describe("runConformance (CLI core)", () => {
	it("runs base checks against a target and skips crypto checks without capabilities", async () => {
		const report = await runConformance({
			origin: "https://target.test",
			fetch: fakeTarget(),
			suiteVersion: "0.0.0-test",
			implementation: "fake",
		});
		// DID resolved from did.json.
		expect(report.target.did).toBe(DID);
		const byId = Object.fromEntries(report.results.map((r) => [r.id, r]));
		// Base checks ran and passed.
		for (const id of [
			"discovery.pds-service",
			"discovery.signing-key",
			"discovery.kem-key",
			"auth.getrecord-unauthenticated-refused",
			"credential.tokenless-unknown-space",
			"request.invalid-space-uri-rejected",
		]) {
			expect(byId[id]!.status, id).toBe("pass");
		}
		// Crypto checks skipped for want of operator/identities — reported,
		// not silently passed.
		expect(byId["credential.member-gate"]!.status).toBe("skipped");
		expect(byId["writes.create-and-read"]!.status).toBe("skipped");
		expect(report.summary.mustFail).toBe(0);
		expect(report.summary.skipped).toBeGreaterThan(0);
	});

	it("respects an explicit --did and tier filter", async () => {
		const report = await runConformance({
			origin: "https://target.test",
			did: "did:plc:abc123",
			tiers: ["must"],
			fetch: fakeTarget(),
			suiteVersion: "0.0.0-test",
		});
		expect(report.target.did).toBe("did:plc:abc123");
		// should-tier checks are excluded from running — they appear only as
		// skipped results (their tier is retained for the report).
		const should = report.results.filter((r) => r.tier === "should");
		expect(should.length).toBeGreaterThan(0);
		expect(should.every((r) => r.status === "skipped")).toBe(true);
	});

	it("mints a session from --handle + env password and sends it as the operator bearer", async () => {
		// The portable auth path: createSession at the target, then every
		// operator call carries the minted accessJwt. A static token is
		// deployment-specific; this works against any standard PDS.
		const authHeaders: Array<string | null> = [];
		const sessionTarget = (async (
			input: RequestInfo | URL,
			init?: RequestInit,
		) => {
			const url = new URL(String(input));
			if (url.pathname === "/.well-known/did.json") {
				return Response.json(didDoc);
			}
			if (url.pathname === "/xrpc/com.atproto.server.createSession") {
				const body = JSON.parse(String(init?.body)) as {
					identifier: string;
					password: string;
				};
				expect(body).toEqual({
					identifier: "alice.example.com",
					password: "hunter2",
				});
				return Response.json({ accessJwt: "sess-tok", did: DID });
			}
			if (url.pathname === "/xrpc/com.atproto.space.createSpace") {
				authHeaders.push(new Headers(init?.headers).get("Authorization"));
			}
			return Response.json({ error: "AuthMissing" }, { status: 401 });
		}) as typeof fetch;

		const report = await runConformance({
			origin: "https://target.test",
			handle: "alice.example.com",
			password: "hunter2",
			destructive: true,
			fetch: sessionTarget,
			suiteVersion: "0.0.0-test",
		});
		// The minted token authenticated the operator calls.
		expect(authHeaders.length).toBeGreaterThan(0);
		expect(authHeaders.every((h) => h === "Bearer sess-tok")).toBe(true);
		// Operator auth against a (presumed) full PDS also enables the blob
		// and delegation capabilities, so those checks ran (they fail against
		// this refusing fake — the point is they were not skipped).
		const byId = Object.fromEntries(report.results.map((r) => [r.id, r]));
		expect(byId["credential.self-round-trip"]!.status).not.toBe("skipped");
		expect(byId["blobs.space-blob-not-public"]!.status).not.toBe("skipped");
	});

	it("withholds the full-PDS capabilities for a standalone space host", async () => {
		const report = await runConformance({
			origin: "https://target.test",
			operatorToken: "static-tok",
			standaloneHost: true,
			destructive: true,
			fetch: fakeTarget(),
			suiteVersion: "0.0.0-test",
		});
		const byId = Object.fromEntries(report.results.map((r) => [r.id, r]));
		expect(byId["credential.self-round-trip"]!.status).toBe("skipped");
		expect(byId["blobs.space-blob-not-public"]!.status).toBe("skipped");
	});

	it("origin-gates the OAuth signing fetch: target requests sign, others stay anonymous", async () => {
		// The deliberately-anonymous probes (unauth reads, public getBlob)
		// must NOT pick up the session — only same-origin operator calls do.
		const signed: string[] = [];
		const gated = originGatedFetch(async (pathname) => {
			signed.push(pathname);
			return Response.json({ ok: true });
		}, "https://target.test");
		await gated("https://target.test/xrpc/com.atproto.space.createRecord?x=1");
		// A cross-origin request falls through to the global fetch — which in
		// this test environment will fail to connect; the point is it was NOT
		// routed through the signer.
		await gated("https://elsewhere.test/xrpc/whatever").catch(() => {});
		expect(signed).toEqual(["/xrpc/com.atproto.space.createRecord?x=1"]);
	});

	it("refuses --handle without the env password, naming the variable", async () => {
		await expect(
			runConformance({
				origin: "https://target.test",
				handle: "alice.example.com",
				fetch: fakeTarget(),
				suiteVersion: "0.0.0-test",
			}),
		).rejects.toThrow(/SPACE_CONFORMANCE_PASSWORD/);
	});

	it("surfaces a target that fails a base check as a must failure", async () => {
		// A pre-alpha DID document: #atproto_space_host instead of a
		// #atproto_pds that routes here, and no #atproto_kem key.
		const brokenTarget = (async (input: RequestInfo | URL) => {
			const url = new URL(String(input));
			if (url.pathname === "/.well-known/did.json") {
				return Response.json({
					id: DID,
					service: [
						{
							id: "#atproto_space_host",
							type: "AtprotoSpaceHost",
							serviceEndpoint: "https://target.test",
						},
					],
					verificationMethod: (didDoc.verificationMethod as unknown[]).slice(
						0,
						1,
					),
				});
			}
			return Response.json({ error: "AuthMissing" }, { status: 401 });
		}) as typeof fetch;
		const report = await runConformance({
			origin: "https://target.test",
			fetch: brokenTarget,
			suiteVersion: "0.0.0-test",
		});
		const status = (id: string) =>
			report.results.find((r) => r.id === id)!.status;
		expect(status("discovery.pds-service")).toBe("fail");
		expect(status("discovery.kem-key")).toBe("fail");
		expect(status("discovery.signing-key")).toBe("pass");
		expect(report.summary.mustFail).toBeGreaterThan(0);
	});

	it("resolves a did:plc target through --plc", async () => {
		const plcDid = "did:plc:abcdefghijklmnopqrstuvwx";
		const requested: string[] = [];
		const plcFetch = (async (input: RequestInfo | URL) => {
			const url = String(input);
			requested.push(url);
			if (url === `https://plc.test/${plcDid}`) {
				// Relative fragment ids, as PLC renders them.
				const methods = didDoc.verificationMethod as Array<{ id: string }>;
				return Response.json({
					...didDoc,
					id: plcDid,
					verificationMethod: methods.map((m) => ({
						...m,
						id: m.id.slice(m.id.indexOf("#")),
						controller: plcDid,
					})),
				});
			}
			return Response.json({ error: "AuthMissing" }, { status: 401 });
		}) as typeof fetch;
		const report = await runConformance({
			origin: "https://target.test",
			did: plcDid,
			plcDirectory: "https://plc.test",
			fetch: plcFetch,
			suiteVersion: "0.0.0-test",
		});
		expect(report.target.plcDirectory).toBe("https://plc.test");
		expect(
			report.results.find((r) => r.id === "discovery.kem-key")!.status,
		).toBe("pass");
		expect(requested).toContain(`https://plc.test/${plcDid}`);
	});

	it("signs in with a scope that reaches spaces the operator does not own", () => {
		// NotSpaceOwner probes and writes into a foreign authority's space
		// need authority=*, still confined to the probe space type.
		expect(OAUTH_SCOPE).toContain("space:earth.cirrus.check.space?authority=*");
	});

	it("counts must-tier errors so an unreachable target does not pass green", async () => {
		// did.json resolves, but every XRPC call throws (target down). The
		// base must-checks error rather than fail — the CLI must still gate.
		const halfDown = (async (input: RequestInfo | URL) => {
			const url = new URL(String(input));
			if (url.pathname === "/.well-known/did.json") {
				return Response.json(didDoc);
			}
			throw new Error("connection refused");
		}) as typeof fetch;
		const report = await runConformance({
			origin: "https://target.test",
			fetch: halfDown,
			suiteVersion: "0.0.0-test",
		});
		// Some base must-checks errored; the CLI gates on mustFail OR mustError.
		expect(report.summary.mustError).toBeGreaterThan(0);
		const wouldExitNonZero =
			report.summary.mustFail > 0 || report.summary.mustError > 0;
		expect(wouldExitNonZero).toBe(true);
	});

	it("tolerates a trailing slash on the target origin", async () => {
		const report = await runConformance({
			origin: "https://target.test/",
			fetch: fakeTarget(),
			suiteVersion: "0.0.0-test",
		});
		// Resolved (no double-slash 404) and the origin is normalized.
		expect(report.target.did).toBe(DID);
		expect(report.target.origin).toBe("https://target.test");
	});

	it("errors clearly when the DID cannot be resolved", async () => {
		const noDoc = (async () =>
			Response.json({ error: "not found" }, { status: 404 })) as typeof fetch;
		await expect(
			runConformance({
				origin: "https://target.test",
				fetch: noDoc,
				suiteVersion: "0.0.0-test",
			}),
		).rejects.toThrow(/could not resolve target DID/);
	});
});
