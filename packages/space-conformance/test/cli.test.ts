import { describe, expect, it } from "vitest";
import { runConformance } from "../src/cli/run";
import { originGatedFetch } from "../src/cli/oauth";

const DID = "did:web:target.test";

/**
 * A minimal fake target: a valid DID document plus refusing auth
 * endpoints. Enough to exercise the base (no-crypto) checks and prove the
 * crypto checks skip cleanly when no operator/identities are supplied.
 */
function fakeTarget(): typeof fetch {
	return (async (input: RequestInfo | URL) => {
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
				verificationMethod: [{ id: `${DID}#atproto` }],
			});
		}
		if (url.pathname.startsWith("/xrpc/com.atproto.space.getLatestCommit")) {
			return Response.json({ error: "InvalidRequest" }, { status: 400 });
		}
		// Everything else (space reads, credential requests) is unauthenticated.
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
		expect(byId["discovery.space-host-service"]!.status).toBe("pass");
		expect(byId["auth.getrecord-unauthenticated-refused"]!.status).toBe("pass");
		expect(byId["request.invalid-space-uri-rejected"]!.status).toBe("pass");
		// Crypto checks skipped for want of operator/identities — reported,
		// not silently passed.
		expect(byId["credential.round-trip"]!.status).toBe("skipped");
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
				return Response.json({
					id: DID,
					service: [
						{
							id: "#atproto_space_host",
							type: "AtprotoSpaceHost",
							serviceEndpoint: "https://target.test",
						},
					],
					verificationMethod: [{ id: `${DID}#atproto` }],
				});
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
			if (url.pathname === "/xrpc/com.atproto.simplespace.createSpace") {
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
		// A target whose DID document lacks the space host entry must fail
		// discovery.
		const brokenTarget = (async (input: RequestInfo | URL) => {
			const url = new URL(String(input));
			if (url.pathname === "/.well-known/did.json") {
				return Response.json({
					id: DID,
					service: [],
					verificationMethod: [{ id: `${DID}#atproto` }],
				});
			}
			return Response.json({ error: "AuthMissing" }, { status: 401 });
		}) as typeof fetch;
		const report = await runConformance({
			origin: "https://target.test",
			fetch: brokenTarget,
			suiteVersion: "0.0.0-test",
		});
		const discovery = report.results.find(
			(r) => r.id === "discovery.space-host-service",
		);
		expect(discovery!.status).toBe("fail");
		expect(report.summary.mustFail).toBeGreaterThan(0);
	});

	it("counts must-tier errors so an unreachable target does not pass green", async () => {
		// did.json resolves, but every XRPC call throws (target down). The
		// base must-checks error rather than fail — the CLI must still gate.
		const halfDown = (async (input: RequestInfo | URL) => {
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
					verificationMethod: [{ id: `${DID}#atproto` }],
				});
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
