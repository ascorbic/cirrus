/**
 * The reference matrix: run the conformance suite against the atproto
 * reference PDS and pin, exactly, how the reference behaves on every check.
 *
 * Why this exists. A conformance suite that only ever runs against its own
 * author's implementation proves nothing — it can encode Cirrus's habits as
 * if they were the protocol. Running the same checks against the reference
 * PDS (the implementation every space must interoperate with) is the control:
 *
 *   - A `must` check that the reference *passes* is genuinely universal.
 *   - A `must` check that the reference *fails* is either a real gap in the
 *     alpha reference or an over-specification in our check. Each such case is
 *     named below with a citation, so "the reference fails this" is a recorded,
 *     reviewed fact rather than a surprise.
 *
 * The assertion pins the whole partition. If a pinned-passing check regresses,
 * CI fails. If a pinned-divergence check starts *passing* — the reference
 * caught up, or our check quietly weakened — CI also fails, forcing this list
 * to be re-examined rather than silently drifting. That two-way pin is the
 * point: the matrix is only worth having if it can't rot.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	filterCatalog,
	runChecks,
	type RunReport,
} from "@getcirrus/space-conformance";
import { fullCatalog } from "@getcirrus/space-conformance/full";
import { startReferencePds, type ReferencePds } from "../src/reference.js";

/**
 * Checks the reference PDS is known to fail, with the reason it diverges from
 * the behaviour the check requires. Every entry is a deliberate, cited
 * statement about the alpha reference — not a check we distrust.
 *
 * The pin is on status, not on the reason: a divergence starting to *pass* is
 * caught (the partition assertion fails), but one that keeps failing for a new
 * reason is not. That blind spot is narrow — three checks with distinctive
 * failure modes — so the reason lives in the comment, and a change of reason
 * is expected to be noticed in review of whatever moved the reference.
 */
const EXPECTED_DIVERGENCES: Record<string, string> = {
	// The reference is a multi-tenant did:plc host: accounts resolve through
	// PLC and it serves no DID document at `${origin}/.well-known/did.json`,
	// so a check that reads the space-host service entry from that document
	// cannot evaluate it. On Cirrus (single-tenant did:web) it applies and
	// passes. Proposal 0016 §space-authority.
	"discovery.space-host-service":
		"reference is multi-tenant did:plc; no DID document at the origin",
	"discovery.verification-key":
		"reference is multi-tenant did:plc; no DID document at the origin",
	// The reference alpha refuses an *unreferenced* uploaded blob on the
	// public sync.getBlob (the check's first probe passes there), but a
	// reference from a space record promotes the blob to public availability
	// exactly as a public-record reference would — so the private write is
	// what leaks the bytes to anyone who learns the CID. The protocol intends
	// space blobs to be fetched via the credential-gated space.getBlob
	// (proposal 0016 §blob-sync); Cirrus enforces that with a separate
	// per-space blob key layout, which is exactly the gate this check guards.
	"blobs.space-blob-not-public":
		"reference alpha promotes space-referenced blobs to the public sync.getBlob",
};

/**
 * Checks that need harness identities the reference cannot resolve (foreign
 * reader/writer DIDs). They are exercised in-process by the @getcirrus/spaces
 * fixture adapter, which wires a did:key resolver; here they skip. The
 * operator's own credential flow is still covered end-to-end by
 * credential.self-round-trip, which needs no foreign identity.
 */
const IDENTITY_GATED = new Set([
	"credential.round-trip",
	"credential.cross-space-refused",
	"delegation.replay-refused",
	"delegation.wrong-audience-refused",
	"host.member-list-gates",
	"host.delete-space-tombstone",
]);

describe("conformance suite vs the atproto reference PDS", () => {
	let ref: ReferencePds;
	let report: RunReport;

	beforeAll(async () => {
		ref = await startReferencePds();
		const catalog = filterCatalog(fullCatalog, {
			// A full reference PDS: an operator session, the public blob
			// endpoints, and its own getDelegationToken (the self credential
			// flow). Identities are deliberately withheld — see IDENTITY_GATED.
			capabilities: ["operator", "pds-blobs", "pds-delegation"],
			destructive: true,
		});
		report = await runChecks({
			catalog,
			context: {
				target: {
					origin: ref.origin,
					did: ref.operatorDid,
					implementation: "atproto-reference-pds",
				},
				fetch,
				operator: {
					oauth: false,
					async authorize(init) {
						init.headers.set("Authorization", `Bearer ${ref.operatorToken}`);
					},
				},
			},
			suiteVersion: "reference-matrix",
			alphaBuild: "0.0.0-spaces-alpha-20260818163953",
		});
	}, 120_000);

	afterAll(async () => {
		await ref?.close();
	});

	const expectedStatus = (id: string): string =>
		id in EXPECTED_DIVERGENCES
			? "fail"
			: IDENTITY_GATED.has(id)
				? "skipped"
				: "pass";

	it("behaves exactly as pinned on every check", () => {
		const wrong = report.results.filter(
			(r) => r.status !== expectedStatus(r.id),
		);

		expect(
			wrong.map(
				(r) =>
					`${r.id}: ${r.status} — ${r.detail}${
						r.id in EXPECTED_DIVERGENCES
							? ` [divergence no longer holds: ${EXPECTED_DIVERGENCES[r.id]}]`
							: ""
					}`,
			),
		).toEqual([]);
	});

	it("passes every interop-critical must check the reference supports", () => {
		// The load-bearing ones, named so a regression reads clearly. These are
		// the write, sync, policy and credential mechanics that two independent
		// implementations must agree on to interoperate at all.
		const byId = Object.fromEntries(
			report.results.map((r) => [r.id, r.status]),
		);
		for (const id of [
			"writes.create-and-read",
			"writes.duplicate-rejected",
			"writes.applywrites-atomic",
			"credential.self-round-trip",
			"sync.oplog-folds-to-commit",
			"sync.getrepo-two-roots",
			"host.listrepos-requires-credential",
			"simplespace.unsupported-policy-rejected",
			"simplespace.getspace-reflects-config",
		]) {
			expect(byId[id], `${id} against the reference`).toBe("pass");
		}
	});

	it("every pinned divergence is a real must/should check, not a typo", () => {
		// Guard the pin against bit-rot: an id in EXPECTED_DIVERGENCES that no
		// longer exists in the catalog would silently do nothing.
		const ids = new Set(fullCatalog.map((c) => c.id));
		for (const id of Object.keys(EXPECTED_DIVERGENCES)) {
			expect(ids.has(id), `${id} is not a known check`).toBe(true);
		}
		for (const id of IDENTITY_GATED) {
			expect(ids.has(id), `${id} is not a known check`).toBe(true);
		}
	});
});
