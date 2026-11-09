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
	ALPHA_BUILD,
	filterCatalog,
	runChecks,
	type RunReport,
} from "@getcirrus/space-conformance";
import { fullCatalog } from "@getcirrus/space-conformance/full";
import { startReferencePds, type ReferencePds } from "../src/reference.js";
import {
	startHarnessServices,
	type HarnessServices,
} from "../src/harness.js";

/** The alpha build this partition was calibrated against. */
const CALIBRATED_ALPHA = "0.0.0-spaces-alpha-20261105160032";

/**
 * Checks the reference PDS is known to fail, with the reason it diverges from
 * the behaviour the check requires. Every entry is a deliberate, cited
 * statement about the alpha reference — not a check we distrust.
 *
 * The pin is on status, not on the reason: a divergence starting to *pass* is
 * caught (the partition assertion fails), but one that keeps failing for a new
 * reason is not. That blind spot is narrow — three checks with distinctive
 * failure modes — so the reason lives here, and a change of reason is expected
 * to be noticed in review of whatever moved the reference.
 */
const EXPECTED_DIVERGENCES: Record<string, string> = {
	// deleteRecord declares SpaceNotFound, and deleteSpace's description says
	// "afterwards, reads and writes fail with SpaceNotFound". The reference's
	// deleteRecord handler checks whether the record exists *before* anything
	// touches the space (`hasRecord` → return null, for idempotency), so a delete
	// in a missing or deleted space is a silent 200 and the space check in
	// `ensureRepo` (changeset brave-spaces-exist) is never reached. Its create,
	// put and applyWrites do answer SpaceNotFound (writes.space-not-found passes).
	"writes.delete-in-missing-space":
		"reference deleteRecord short-circuits on an absent record before checking the space, answering 200",
	// Same deleteSpace sentence, read side. The reference's read handlers never
	// consult the space row: after deletion the owner's repo is gone, so they
	// answer RecordNotFound / RepoNotFound / BlobNotFound or an empty 200 listing,
	// never the SpaceNotFound each of them declares.
	"space.reads-after-delete-not-found":
		"reference reads ignore the space tombstone and answer RecordNotFound/RepoNotFound/BlobNotFound or an empty 200",
	// ClientAttestationVerifier.verify calls parseSpaceToken outside its
	// invalid() wrapper, so a structurally malformed attestation escapes as an
	// uncaught SpaceTokenError: 500 InternalServerError, where the lexicon
	// declares InvalidClientAttestation. A well-formed but unverifiable one is
	// refused correctly (credential.unverifiable-attestation-refused passes).
	"credential.garbage-attestation-refused":
		"reference answers 500 for a malformed client attestation (parseSpaceToken throws outside invalid())",
};

describe("conformance suite vs the atproto reference PDS", () => {
	let ref: ReferencePds;
	let harness: HarnessServices;
	let report: RunReport;

	beforeAll(async () => {
		ref = await startReferencePds();
		harness = await startHarnessServices();
		const catalog = filterCatalog(fullCatalog, {
			// Everything: an operator session, the public blob endpoints, the
			// reference's own getDelegationToken, harness identities it can
			// resolve (did:web on localhost) and a syncer inbox it can reach.
			capabilities: [
				"operator",
				"pds-blobs",
				"pds-delegation",
				"identities",
				"syncer-inbox",
			],
			destructive: true,
		});
		report = await runChecks({
			catalog,
			context: {
				target: {
					origin: ref.origin,
					did: ref.operatorDid,
					implementation: "atproto-reference-pds",
					plcDirectory: ref.plcUrl,
				},
				fetch,
				operator: {
					oauth: false,
					async authorize(init) {
						init.headers.set("Authorization", `Bearer ${ref.operatorToken}`);
					},
				},
				identities: harness.identities,
				syncerInbox: harness.inbox,
			},
			suiteVersion: "reference-matrix",
			alphaBuild: ALPHA_BUILD,
		});
	}, 300_000);

	afterAll(async () => {
		await harness?.close();
		await ref?.close();
	});

	it("is calibrated against the alpha the suite is pinned to", () => {
		// Bumping the alpha without re-running and re-pinning this matrix must
		// fail here, not silently carry the old partition forward.
		expect(ALPHA_BUILD).toBe(CALIBRATED_ALPHA);
	});

	const expectedStatus = (id: string): string =>
		id in EXPECTED_DIVERGENCES ? "fail" : "pass";

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

	it("runs the whole catalog — nothing skipped", () => {
		// Every capability is provided, so a skip means a check grew a need the
		// harness doesn't meet; it must be wired here, not quietly dropped.
		expect(report.results.filter((r) => r.status === "skipped")).toEqual([]);
		expect(report.results).toHaveLength(fullCatalog.length);
	});

	it("passes every interop-critical must check", () => {
		// The load-bearing ones, named so a regression reads clearly: the write,
		// credential, signature, MAC, sync and policy mechanics two independent
		// implementations must agree on to interoperate at all.
		const byId = Object.fromEntries(
			report.results.map((r) => [r.id, r.status]),
		);
		for (const id of [
			"discovery.kem-key",
			"writes.create-and-read",
			"writes.applywrites-atomic",
			"credential.self-round-trip",
			"credential.claims",
			"credential.signature-required",
			"credential.audience-bound",
			"mac.want-mac-required",
			"mac.commit-verifies",
			"mac.record-verifies",
			"sync.oplog-folds-to-commit",
			"sync.getrepo-star",
			"sync.listrepos-shape",
			"credential.member-gate",
			"revocation.revoked-credential-refused",
			"notify.forwarded-notifywrite",
			"managedspace.checkuseraccess",
			"migration.import-repo",
		]) {
			expect(byId[id], `${id} against the reference`).toBe("pass");
		}
	});

	it("every pinned divergence is a real must check, not a typo", () => {
		// Guard the pin against bit-rot: an id in EXPECTED_DIVERGENCES that no
		// longer exists in the catalog would silently do nothing. A should check
		// the reference fails is stale by definition and belongs out of the
		// catalog, not in this list.
		const byId = new Map(fullCatalog.map((c) => [c.id, c]));
		for (const id of Object.keys(EXPECTED_DIVERGENCES)) {
			expect(byId.has(id), `${id} is not a known check`).toBe(true);
			expect(byId.get(id)?.tier, `${id} must be a must check`).toBe("must");
		}
	});
});
