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
}

const L = (ref: string): Citation => ({ source: "lexicon", ref });
const C = (ref: string): Citation => ({ source: "changeset", ref });

/** Refusals a policy may give a user it does not authorise. */
const USER_REFUSALS = [
	L("com.atproto.space.getSpaceCredential@error:SpaceNotFound"),
	L("com.atproto.space.getSpaceCredential@error:UserNotAuthorized"),
	L("com.atproto.space.getSpaceCredential@error:NotAuthorized"),
];

/** Every crypto-bound check, by metadata, in catalog order. */
export const cryptoCheckDescriptors: CheckDescriptor[] = [
	// --- MAC verification ------------------------------------------------
	{
		id: "mac.commit-verifies",
		title:
			"getLatestCommit's commit has the specified shape and its MAC verifies",
		tier: "must",
		needs: ["operator"],
		citations: [
			L("com.atproto.space.getLatestCommit"),
			L("com.atproto.space.defs#commit"),
			C("quiet-spaces-mac"),
		],
		destructive: true,
	},
	{
		id: "mac.record-verifies",
		title: "getRecord's record MAC verifies and its value encodes to its cid",
		tier: "must",
		needs: ["operator"],
		citations: [L("com.atproto.space.getRecord"), C("quiet-spaces-mac")],
		destructive: true,
	},
	{
		id: "sync.oplog-folds-to-commit",
		title: "listRepoOps' head commit MAC verifies and the ops fold to its data",
		tier: "must",
		needs: ["operator"],
		citations: [
			L("com.atproto.space.listRepoOps"),
			L("com.atproto.space.defs#commit"),
		],
		destructive: true,
	},
	{
		id: "sync.getrepo-star",
		title: "getRepo serves a STAR archive that verifies against its MAC",
		tier: "must",
		needs: ["operator"],
		citations: [
			L("com.atproto.space.getRepo"),
			L("com.atproto.space.defs#commit"),
			C("star-spaces-shine"),
		],
		destructive: true,
	},
	// --- token signatures ------------------------------------------------
	{
		id: "credential.signed-by-authority",
		title: "A credential verifies against the authority's #atproto key",
		tier: "must",
		needs: ["operator"],
		citations: [
			L("com.atproto.space.getSpaceCredential"),
			C("plain-keys-resolve"),
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
			C("plain-keys-resolve"),
		],
		destructive: true,
	},
	// --- migration -------------------------------------------------------
	{
		id: "migration.export-space-meta",
		title: "exportSpaceMeta serves the space's policy, members and writers",
		tier: "must",
		needs: ["operator"],
		citations: [L("com.atproto.space.exportSpaceMeta"), C("olive-crabs-fly")],
		destructive: true,
	},
	{
		id: "migration.import-space-meta",
		title: "importSpaceMeta replaces the space's policy and member list",
		tier: "must",
		needs: ["operator"],
		citations: [L("com.atproto.space.importSpaceMeta"), C("olive-crabs-fly")],
		destructive: true,
	},
	{
		id: "migration.import-space-meta-not-owner",
		title: "importSpaceMeta of another DID's space answers NotSpaceOwner",
		tier: "must",
		needs: ["operator"],
		citations: [L("com.atproto.space.importSpaceMeta@error:NotSpaceOwner")],
	},
	{
		id: "migration.import-space-meta-unsupported-policy",
		title:
			"importSpaceMeta of an unimplemented policy answers UnsupportedPolicy",
		tier: "must",
		needs: ["operator"],
		citations: [L("com.atproto.space.importSpaceMeta@error:UnsupportedPolicy")],
		destructive: true,
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
			C("olive-crabs-fly"),
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
	// --- foreign identities ----------------------------------------------
	{
		id: "credential.member-gate",
		title:
			"A memberspace refuses a non-member and a read:false member, and admits a reader",
		tier: "must",
		needs: ["operator", "identities"],
		citations: [
			...USER_REFUSALS,
			L("com.atproto.memberspace.putMember"),
			L("com.atproto.memberspace.policy"),
		],
		destructive: true,
	},
	{
		id: "policy.personalspace-owner-only",
		title: "A personalspace refuses every user but its authority",
		tier: "must",
		needs: ["operator", "identities"],
		citations: [...USER_REFUSALS, L("com.atproto.personalspace.policy")],
		destructive: true,
	},
	{
		id: "delegation.wrong-audience-refused",
		title: "A delegation token addressed to another host is refused",
		tier: "must",
		needs: ["operator", "identities"],
		citations: [
			L("com.atproto.space.getSpaceCredential@error:InvalidDelegationToken"),
		],
		destructive: true,
	},
	{
		id: "host.notifywrite-accepted",
		title: "An authorised writer's notifyWrite enters the writer set",
		tier: "must",
		needs: ["operator", "identities"],
		citations: [
			L("com.atproto.space.notifyWrite"),
			L("com.atproto.space.listRepos"),
		],
		destructive: true,
	},
	{
		id: "host.notifywrite-future-rev",
		title: "notifyWrite with a repoRev beyond clock skew answers FutureRev",
		tier: "must",
		needs: ["operator", "identities"],
		citations: [L("com.atproto.space.notifyWrite@error:FutureRev")],
		destructive: true,
	},
	{
		id: "host.notifywrite-unknown-space",
		title:
			"notifyWrite for a space the authority does not have answers SpaceNotFound",
		tier: "must",
		needs: ["operator", "identities"],
		citations: [L("com.atproto.space.notifyWrite@error:SpaceNotFound")],
	},
	{
		id: "revocation.revoked-credential-refused",
		title:
			"A repo host accepts a foreign authority's credential until it is revoked",
		tier: "must",
		needs: ["operator", "identities"],
		citations: [
			L("com.atproto.space.notifyCredentialRevoked"),
			L("com.atproto.space.getRecord"),
			C("funky-dryers-draw"),
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
			"notifyCredentialRevoked from anyone but the space authority is refused",
		tier: "must",
		needs: ["operator", "identities"],
		citations: [L("com.atproto.space.notifyCredentialRevoked")],
		destructive: true,
	},
	{
		id: "managedspace.checkuseraccess",
		title: "A managedspace defers each credential decision to its managing app",
		tier: "must",
		needs: ["operator", "identities", "syncer-inbox"],
		citations: [
			L("com.atproto.managedspace.checkUserAccess"),
			L("com.atproto.managedspace.policy"),
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
