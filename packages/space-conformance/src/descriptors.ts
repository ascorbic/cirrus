/**
 * Dependency-free descriptors of the crypto-bound checks.
 *
 * The browser adapter can't import the real crypto catalog (it pulls the
 * alpha libs and node streams), but it must still *list* those checks so a
 * viewer sees them reported as "not testable here" rather than silently
 * omitted — an omitted check reads as conformant, the exact failure this
 * suite exists to prevent.
 *
 * These are metadata only: id, tier, what the check needs. A drift test in
 * the full test suite asserts they match the real `cryptoChecks` exactly,
 * so adding a crypto check without a descriptor fails CI.
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

/**
 * Every crypto-bound check, by metadata. Keep in the same order and with
 * the same fields as `cryptoChecks` (enforced by the drift test).
 */
export const cryptoCheckDescriptors: CheckDescriptor[] = [
	{
		id: "credential.round-trip",
		title: "A member exchanges a delegation token for a credential and reads",
		tier: "must",
		needs: ["operator", "identities"],
		citations: [
			L("com.atproto.space.getSpaceCredential"),
			L("com.atproto.space.getRecord"),
		],
		destructive: true,
	},
	{
		id: "credential.cross-space-refused",
		title: "A credential for one space cannot read another",
		tier: "must",
		needs: ["operator", "identities"],
		citations: [L("com.atproto.space.getRecord")],
		destructive: true,
	},
	{
		id: "delegation.replay-refused",
		title: "A delegation token cannot be used twice",
		tier: "must",
		needs: ["operator", "identities"],
		citations: [
			L("com.atproto.space.getSpaceCredential@error:InvalidDelegationToken"),
		],
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
		id: "sync.oplog-folds-to-commit",
		title: "Folding the oplog reproduces the commit set-hash",
		tier: "must",
		needs: ["operator"],
		citations: [
			L("com.atproto.space.listRepoOps"),
			L("com.atproto.space.defs"),
		],
		destructive: true,
	},
	{
		id: "host.member-list-gates",
		title: "member-list policy refuses a non-member and admits a member",
		tier: "must",
		needs: ["operator", "identities"],
		citations: [
			L("com.atproto.space.getSpaceCredential@error:UserNotAuthorized"),
			L("com.atproto.simplespace.addMember"),
		],
		destructive: true,
	},
	{
		id: "host.delete-space-tombstone",
		title: "After deleteSpace, getSpaceCredential answers SpaceDeleted",
		tier: "must",
		needs: ["operator", "identities"],
		citations: [
			L("com.atproto.simplespace.deleteSpace"),
			L("com.atproto.space.getSpaceCredential@error:SpaceDeleted"),
		],
		destructive: true,
	},
];

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
