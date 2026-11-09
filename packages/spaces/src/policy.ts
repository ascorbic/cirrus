/**
 * Space policies: the three baseline policies every PDS supports, as
 * `com.atproto.space.createSpace` / `updateSpace` take them. A policy is an
 * open union discriminated by `$type` that both selects the policy and
 * carries its configuration.
 *
 * What is stored is exactly what is enforced: {@link normalizePolicy}
 * refuses a policy this host doesn't implement and fills in every default.
 * Unknown fields are dropped, as Lexicon evolution allows.
 */

import { SpaceError } from "./errors.js";
import {
	MANAGEDSPACE_POLICY,
	MEMBERSPACE_POLICY,
	PERSONALSPACE_POLICY,
	type SpacePolicy,
} from "./types.js";

/** The collection a published policy record lives in (rkey `self`). */
export const POLICY_COLLECTION = "com.atproto.space.policy";
export const POLICY_RKEY = "self";
/** The collection published member records live in (rkey = member DID). */
export const MEMBER_COLLECTION = "com.atproto.memberspace.member";
/** The collections the host publishes a space's configuration to. */
export const PUBLISHED_COLLECTIONS: readonly string[] = [
	POLICY_COLLECTION,
	MEMBER_COLLECTION,
];

const isBool = (value: unknown): value is boolean => typeof value === "boolean";

function optionalBool(input: Record<string, unknown>, key: string): boolean {
	const value = input[key];
	if (value === undefined) return false;
	if (!isBool(value)) {
		throw new SpaceError("InvalidRequest", `Policy ${key} must be a boolean`);
	}
	return value;
}

/** Validate and normalise a policy from a request or an archive. */
export function normalizePolicy(input: unknown): SpacePolicy {
	if (!input || typeof input !== "object" || Array.isArray(input)) {
		throw new SpaceError("InvalidRequest", "policy must be an object");
	}
	const policy = input as Record<string, unknown>;
	switch (policy.$type) {
		case PERSONALSPACE_POLICY:
			return { $type: PERSONALSPACE_POLICY };
		case MEMBERSPACE_POLICY: {
			const allowedApps = policy.allowedApps;
			if (
				allowedApps !== undefined &&
				(!Array.isArray(allowedApps) ||
					allowedApps.some((app) => typeof app !== "string"))
			) {
				throw new SpaceError(
					"InvalidRequest",
					"allowedApps must be an array of client IDs",
				);
			}
			return {
				$type: MEMBERSPACE_POLICY,
				publicRead: optionalBool(policy, "publicRead"),
				publicWrite: optionalBool(policy, "publicWrite"),
				...(allowedApps !== undefined
					? { allowedApps: [...(allowedApps as string[])] }
					: {}),
				publishPolicy: optionalBool(policy, "publishPolicy"),
				publishMembers: optionalBool(policy, "publishMembers"),
			};
		}
		case MANAGEDSPACE_POLICY: {
			const managingApp = policy.managingApp;
			if (typeof managingApp !== "string" || !managingApp.startsWith("did:")) {
				throw new SpaceError(
					"InvalidRequest",
					"managingApp must be a DID with an optional service fragment",
				);
			}
			return {
				$type: MANAGEDSPACE_POLICY,
				managingApp,
				publishPolicy: optionalBool(policy, "publishPolicy"),
			};
		}
		default:
			throw new SpaceError(
				"UnsupportedPolicy",
				`Unsupported policy: ${String(policy.$type)}`,
			);
	}
}

/** The member list and its methods belong to the memberspace policy. */
export function assertMemberspace(
	policy: SpacePolicy,
): asserts policy is Extract<
	SpacePolicy,
	{ $type: typeof MEMBERSPACE_POLICY }
> {
	if (policy.$type !== MEMBERSPACE_POLICY) {
		throw new SpaceError(
			"PolicyMismatch",
			"Space is not governed by the memberspace policy",
		);
	}
}

/**
 * Whether any user may read. Only then can a credential be minted without
 * a delegation token saying who the user is.
 */
export function isPublicRead(policy: SpacePolicy): boolean {
	return policy.$type === MEMBERSPACE_POLICY && policy.publicRead;
}

export function isPolicyPublished(policy: SpacePolicy): boolean {
	return policy.$type !== PERSONALSPACE_POLICY && policy.publishPolicy;
}

export function areMembersPublished(policy: SpacePolicy): boolean {
	return policy.$type === MEMBERSPACE_POLICY && policy.publishMembers;
}

/**
 * Only memberspace restricts apps, against the attested client_id, so an
 * app that presents no attestation is never one of the allowed apps.
 */
export function isAppAuthorized(
	policy: SpacePolicy,
	clientId: string | undefined,
): boolean {
	if (policy.$type !== MEMBERSPACE_POLICY || !policy.allowedApps) return true;
	return clientId !== undefined && policy.allowedApps.includes(clientId);
}

/**
 * A DID as a record key, for published member records. A record key can't
 * contain `%`, so the percent-encoded port of a localhost did:web is left
 * unencoded, as the reference does. Unambiguous because the unencoded form
 * would otherwise be a did:web path, which atproto doesn't support.
 */
export function didToRecordKey(did: string): string {
	return did.replace("%3A", ":");
}

export function recordKeyToDid(rkey: string): string {
	return rkey.replace(/^(did:web:[^:]+):(\d+)$/, "$1%3A$2");
}

/** Records published from a space's configuration are the host's to write. */
export function assertNotPublishedCollection(collection: string): void {
	if (PUBLISHED_COLLECTIONS.includes(collection)) {
		throw new SpaceError(
			"InvalidRequest",
			`${collection} records are published by the PDS from a space's configuration and cannot be written directly`,
		);
	}
}
