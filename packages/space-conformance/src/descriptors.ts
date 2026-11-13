/**
 * Dependency-free descriptors of the crypto-bound checks.
 *
 * The browser adapter can't import the real crypto catalog (it pulls the
 * alpha libs and node streams), but it must still *list* those checks so a
 * viewer sees them reported as "not testable here" rather than silently
 * omitted — an omitted check reads as conformant, the exact failure this
 * suite exists to prevent.
 *
 * These are the single source of the crypto checks' metadata: each real
 * check in `./full/checks.ts` is defined by spreading its descriptor, so
 * the two cannot drift. A test still pins that every descriptor has a
 * check and vice versa.
 */

import type { Capability, Check, Citation, Tier } from "./model.js";
import { pass } from "./model.js";

export interface CheckDescriptor {
	id: string;
	title: string;
	tier: Tier;
	needs: Capability[];
	citations: Citation[];
	destructive?: boolean;
	slow?: boolean;
	timeoutMs?: number;
}

const L = (ref: string): Citation => ({ source: "lexicon", ref });
const C = (ref: string): Citation => ({ source: "changeset", ref });

const P = (ref: string): Citation => ({ source: "proposal", ref });

/** Refusals a policy may give an account it does not authorise. */
const ACCOUNT_REFUSALS = [
	L("com.atproto.space.authorizeSpaceSync@error:SpaceNotFound"),
	L("com.atproto.space.authorizeSpaceSync@error:AccountNotAuthorized"),
	L("com.atproto.space.authorizeSpaceSync@error:NotAuthorized"),
];

/** Every crypto-bound check, by metadata, in catalog order. */
export const cryptoCheckDescriptors: CheckDescriptor[] = [
	// --- MAC verification ------------------------------------------------
	{
		id: "mac.commit-verifies",
		title:
			"getLatestCommit's commit MAC verifies, under the requested label, with Vary: Accept-Signature",
		tier: "must",
		needs: ["operator"],
		citations: [
			L("com.atproto.space.getLatestCommit"),
			L("com.atproto.space.defs#commit"),
			P("0016#requesting-a-mac"),
			P("0016#commit-mac"),
		],
		destructive: true,
	},
	{
		id: "mac.record-verifies",
		title: "getRecord's record MAC verifies and its value encodes to its cid",
		tier: "must",
		needs: ["operator"],
		citations: [L("com.atproto.space.getRecord"), P("0016#record-mac")],
		destructive: true,
	},
	{
		id: "sync.oplog-folds-to-commit",
		title:
			"Every listRepoOps page carries a MAC-verified commit, and the ops fold to its data",
		tier: "must",
		needs: ["operator"],
		citations: [
			L("com.atproto.space.listRepoOps"),
			L("com.atproto.space.defs#commit"),
			P("0016#incremental-sync"),
		],
		destructive: true,
	},
	{
		id: "sync.getrepo-star",
		title:
			"getRepo serves a STAR archive (application/vnd.dasl.star) that verifies against its MAC",
		tier: "must",
		needs: ["operator"],
		citations: [L("com.atproto.space.getRepo"), P("0016#repo-serialization")],
		destructive: true,
	},
	// --- token signatures ------------------------------------------------
	{
		id: "credential.signed-by-authority",
		title: "A credential verifies against the authority's #atproto key",
		tier: "must",
		needs: ["operator"],
		citations: [
			L("com.atproto.space.authorizeSpaceSync"),
			P("0016#space-credential"),
		],
		destructive: true,
	},
	{
		id: "delegation.signed-by-user",
		title: "A delegation token verifies against the user's #atproto key",
		tier: "must",
		needs: ["operator", "pds-delegation"],
		citations: [
			L("com.atproto.space.getDelegationToken"),
			P("0016#delegation-token"),
		],
		destructive: true,
	},
	// --- migration -------------------------------------------------------
	{
		id: "migration.export-space-meta",
		title:
			"exportSpaceMeta serves the policy, members and live writers (with repoRev) as a STAR file",
		tier: "must",
		needs: ["operator"],
		citations: [
			L("com.atproto.space.exportSpaceMeta"),
			P("0016#space-meta-archive"),
			C("removed-writers-notify"),
		],
		destructive: true,
	},
	{
		id: "migration.import-space-meta",
		title: "importSpaceMeta replaces the space's policy and member list",
		tier: "must",
		needs: ["operator"],
		citations: [
			L("com.atproto.space.importSpaceMeta"),
			P("0016#space-meta-archive"),
		],
		destructive: true,
	},
	{
		id: "migration.import-space-meta-not-authority",
		title: "importSpaceMeta of another DID's space answers NotAuthorized",
		tier: "must",
		needs: ["operator"],
		citations: [L("com.atproto.space.importSpaceMeta@error:NotAuthorized")],
	},
	{
		id: "migration.import-space-meta-unsupported-policy",
		title:
			"importSpaceMeta of an unimplemented policy answers UnsupportedPolicy",
		tier: "must",
		needs: ["operator"],
		citations: [
			L("com.atproto.space.importSpaceMeta@error:UnsupportedPolicy"),
			P("0016#space-meta-archive"),
		],
		destructive: true,
	},
	{
		id: "migration.import-space-meta-invalid",
		title: "importSpaceMeta of a malformed archive answers InvalidSpaceMeta",
		tier: "must",
		needs: ["operator"],
		citations: [
			L("com.atproto.space.importSpaceMeta@error:InvalidSpaceMeta"),
			P("0016#space-meta-archive"),
		],
	},
	{
		id: "migration.import-repo",
		title:
			"importRepo of a getRepo archive keeps the records and data at a new rev",
		tier: "must",
		needs: ["operator"],
		citations: [
			L("com.atproto.space.importRepo"),
			L("com.atproto.space.getRepo"),
			P("0016#account-migration"),
		],
		destructive: true,
	},
	{
		id: "migration.import-repo-space-not-found",
		title:
			"importRepo into an own space that was never imported answers SpaceNotFound",
		tier: "must",
		needs: ["operator"],
		citations: [L("com.atproto.space.importRepo@error:SpaceNotFound")],
	},
	{
		id: "migration.import-repo-invalid",
		title: "importRepo of a malformed archive answers InvalidRepoFile",
		tier: "must",
		needs: ["operator"],
		citations: [L("com.atproto.space.importRepo@error:InvalidRepoFile")],
	},
	{
		id: "migration.import-repo-mismatch",
		title: "importRepo of another account's repo answers RepoMismatch",
		tier: "must",
		needs: ["operator"],
		citations: [L("com.atproto.space.importRepo@error:RepoMismatch")],
		destructive: true,
	},
	// --- foreign identities ----------------------------------------------
	{
		id: "credential.member-gate",
		title:
			"A memberspace refuses a non-member and a read:false member, and admits a reader",
		tier: "must",
		needs: ["operator", "identities"],
		citations: [
			...ACCOUNT_REFUSALS,
			L("com.atproto.memberspace.putMembers"),
			L("com.atproto.memberspace.policy"),
			P("0016#memberspace"),
		],
		destructive: true,
	},
	{
		id: "policy.personalspace-owner-only",
		title: "A personalspace refuses every account but its authority",
		tier: "must",
		needs: ["operator", "identities"],
		citations: [
			...ACCOUNT_REFUSALS,
			L("com.atproto.personalspace.policy"),
			P("0016#personalspace"),
		],
		destructive: true,
	},
	{
		id: "delegation.wrong-audience-refused",
		title: "A delegation token addressed to another host is refused",
		tier: "must",
		needs: ["operator", "identities"],
		citations: [
			L("com.atproto.space.authorizeSpaceSync@error:InvalidDelegationToken"),
			P("0016#delegation-token"),
		],
		destructive: true,
	},
	{
		id: "host.notifyrepoupdate-accepted",
		title: "An authorised writer's notifyRepoUpdate enters the writer set",
		tier: "must",
		needs: ["operator", "identities"],
		citations: [
			L("com.atproto.space.notifyRepoUpdate"),
			L("com.atproto.space.listWriters"),
			P("0016#write-notifications"),
		],
		destructive: true,
	},
	{
		id: "host.notifyrepoupdate-future-rev",
		title:
			"notifyRepoUpdate with a repoRev beyond clock skew answers FutureRev",
		tier: "must",
		needs: ["operator", "identities"],
		citations: [
			L("com.atproto.space.notifyRepoUpdate@error:FutureRev"),
			P("0016#write-notifications"),
		],
		destructive: true,
	},
	{
		id: "host.notifyrepoupdate-unknown-space",
		title:
			"notifyRepoUpdate for a space the authority does not have answers SpaceNotFound",
		tier: "must",
		needs: ["operator", "identities"],
		citations: [L("com.atproto.space.notifyRepoUpdate@error:SpaceNotFound")],
	},
	{
		id: "memberspace.write-revocation-removes-writer",
		title:
			"Revoking a member's write access removes it from the writer set, and its writes stop being tracked",
		tier: "should",
		needs: ["operator", "identities"],
		citations: [P("0016#memberspace"), P("0016#write-notifications")],
		destructive: true,
	},
	{
		id: "revocation.revoked-credential-refused",
		title:
			"A repo host accepts a foreign authority's credential until it is revoked",
		tier: "must",
		needs: ["operator", "identities"],
		citations: [
			L("com.atproto.space.notifyCredentialsRevoked"),
			L("com.atproto.space.getRecord"),
			P("0016#credential-expiration-and-revocation"),
		],
		destructive: true,
	},
	{
		id: "revocation.error-name",
		title: "A revoked credential is refused with CredentialRevoked",
		tier: "should",
		needs: ["operator", "identities"],
		citations: [
			{ source: "reference", ref: "pds auth-verifier spaceCredentialAuth" },
		],
		destructive: true,
	},
	{
		id: "revocation.non-authority-refused",
		title:
			"notifyCredentialsRevoked from anyone but the space authority is refused",
		tier: "must",
		needs: ["operator", "identities"],
		citations: [
			L("com.atproto.space.notifyCredentialsRevoked"),
			P("0016#credential-expiration-and-revocation"),
		],
		destructive: true,
	},
	{
		id: "managedspace.check-access-account",
		title: "A managedspace asks its managing app about the delegated account",
		tier: "must",
		needs: ["operator", "identities", "syncer-inbox"],
		citations: [
			L("com.atproto.managedspace.checkAccess"),
			L("com.atproto.managedspace.policy"),
			P("0016#managedspace"),
		],
		destructive: true,
	},
];

export function descriptor(id: string): CheckDescriptor {
	const found = cryptoCheckDescriptors.find((d) => d.id === id);
	if (!found) throw new Error(`no crypto check descriptor ${id}`);
	return found;
}

/**
 * Turn a descriptor into a listable Check. Its run() is never invoked —
 * beyond the descriptor's own needs, the stub declares `alpha-libs` (the
 * ability to execute the alpha crypto code), which no browser harness
 * provides, so the runner always filters it into `skipped` — but it
 * throws if reached, so a mistaken run surfaces loudly rather than
 * passing.
 */
export function descriptorToStub(d: CheckDescriptor): Check {
	return {
		id: d.id,
		title: d.title,
		tier: d.tier,
		needs: [...d.needs, "alpha-libs"],
		citations: d.citations,
		...(d.destructive ? { destructive: true } : {}),
		...(d.slow ? { slow: true } : {}),
		run: async () => {
			throw new Error(
				`${d.id} is a metadata stub and cannot run in this transport`,
			);
			// unreachable; satisfies the return type
			return pass("");
		},
	};
}
