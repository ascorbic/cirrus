/**
 * The conformance suite run against the real, integrated PDS worker.
 *
 * This complements the in-process space-routes run in @getcirrus/spaces:
 * here the target is the whole worker (discovery document, blob endpoints,
 * space routes together), so the operator-tier checks — including blob
 * isolation, which needs com.atproto.repo.uploadBlob and
 * com.atproto.sync.getBlob — execute against production code paths.
 *
 * Foreign harness identities are not resolvable by the worker's real DID
 * resolver, so the identity-requiring credential/delegation checks skip
 * here; the space-routes run covers those with a wired resolver.
 */

import { describe, expect, it } from "vitest";
import {
	ALPHA_BUILD,
	filterCatalog,
	runChecks,
} from "@getcirrus/space-conformance";
import { fullCatalog } from "@getcirrus/space-conformance/full";
import { env, worker } from "./helpers";

describe("conformance suite vs the integrated PDS", () => {
	it(
		"passes the operator-tier and discovery checks, blobs included",
		{
			// The catalogue runs ~10s alone; leave room for a loaded machine.
			timeout: 60_000,
		},
		async () => {
			const fetchAdapter: typeof fetch = (input, init) =>
				worker.fetch(new Request(input as RequestInfo, init), env);

			const catalog = filterCatalog(fullCatalog, {
				// A full PDS: operator session, the public blob endpoints, and its
				// own getDelegationToken — so the operator can mint a credential for
				// its own space (the bulletin self-flow) without a foreign identity.
				capabilities: ["operator", "pds-blobs", "pds-delegation", "alpha-libs"],
				destructive: true,
			});
			const report = await runChecks({
				catalog,
				context: {
					target: {
						origin: `https://${env.PDS_HOSTNAME}`,
						did: env.DID,
						implementation: "cirrus-pds",
					},
					fetch: fetchAdapter,
					operator: {
						oauth: false,
						async authorize(reqInit) {
							reqInit.headers.set("Authorization", `Bearer ${env.AUTH_TOKEN}`);
						},
					},
				},
				suiteVersion: "in-process",
				alphaBuild: ALPHA_BUILD,
			});

			const failures = report.results.filter(
				(r) =>
					(r.status === "fail" || r.status === "error") && r.tier !== "info",
			);
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
			// Discovery (including the published #atproto_kem) and blob
			// isolation ran against the real worker.
			expect(byId["discovery.pds-service"]).toBe("pass");
			expect(byId["discovery.kem-key"]).toBe("pass");
			expect(byId["blobs.space-blob-not-public"]).toBe("pass");
			expect(byId["writes.create-and-read"]).toBe("pass");
			expect(byId["sync.getrepo-star"]).toBe("pass");
			// The self-flow credential round-trip runs end-to-end: the worker mints
			// its own delegation token, exchanges it for a credential bound to a
			// P-256 key, and serves the signed, MAC'd read. This is the
			// interop-critical path the reference matrix also exercises.
			expect(byId["credential.self-round-trip"]).toBe("pass");
			// Identity-requiring checks skip here (no foreign resolution).
			expect(byId["credential.member-gate"]).toBe("skipped");
		},
	);
});
