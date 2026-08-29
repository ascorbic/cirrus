/**
 * Scope parsing and matching, built on @atproto/oauth-scopes.
 *
 * Granular scopes (`repo:`, `rpc:`, `blob:`, `account:`, `identity:`) are
 * parsed structurally. Permission-set includes (`include:NSID?aud=...`) are
 * resolved at authorize-time via an injected {@link PermissionSetResolver}
 * and expanded into concrete granular scopes inline before the auth code is
 * stored — so resource-server checks never need network access.
 */

import type { Nsid as AtcuteNsid } from "@atcute/lexicons/syntax";
import {
	AccountPermission,
	BlobPermission,
	IdentityPermission,
	IncludeScope,
	RepoPermission,
	RpcPermission,
	ScopeMissingError,
	ScopePermissionsTransition,
	ScopesSet,
} from "@atproto/oauth-scopes";
import * as oauthScopes from "@atproto/oauth-scopes";
import type { PermissionSetResolver } from "./permission-sets.js";

export { IncludeScope, ScopeMissingError, ScopePermissionsTransition, ScopesSet };

/**
 * `SpacePermission` is only present in the `spaces-alpha` builds of
 * `@atproto/oauth-scopes`. Accessed via the namespace so a build without it
 * rejects `space:` scopes outright instead of accepting an approximation.
 */
const SpacePermission = (
	oauthScopes as {
		SpacePermission?: typeof import("@atproto/oauth-scopes").SpacePermission;
	}
).SpacePermission;

export type SpacePermissionType =
	import("@atproto/oauth-scopes").SpacePermission;

/**
 * Resources known to the spec. Used in OAuth metadata advertisement and to
 * decide whether a scope token is structurally a granular permission.
 */
export const GRANULAR_RESOURCES = [
	"repo",
	"rpc",
	"blob",
	"account",
	"identity",
	"space",
] as const;

/**
 * Legacy "transitional" scopes recognized for back-compat.
 *
 * `ScopePermissionsTransition` treats these as broad shims: `transition:generic`
 * covers everything except account perms, `transition:email` adds account:email,
 * `transition:chat.bsky` adds RPC for chat.bsky.
 */
export const TRANSITION_SCOPES = [
	"transition:generic",
	"transition:email",
	"transition:chat.bsky",
] as const;

/**
 * The base scope every atproto OAuth token must carry.
 */
export const ATPROTO_SCOPE = "atproto";

export class ScopeParseError extends Error {
	constructor(
		message: string,
		readonly scope: string,
	) {
		super(message);
		this.name = "ScopeParseError";
	}
}

const STRUCTURAL_PARSERS: Record<
	(typeof GRANULAR_RESOURCES)[number],
	(s: string) => unknown
> = {
	repo: (s) => RepoPermission.fromString(s),
	rpc: (s) => RpcPermission.fromString(s),
	blob: (s) => BlobPermission.fromString(s),
	account: (s) => AccountPermission.fromString(s),
	identity: (s) => IdentityPermission.fromString(s),
	space: (s) => (SpacePermission ? SpacePermission.fromString(s) : null),
};

export interface ParseScopeOptions {
	/**
	 * When true, `include:` scopes are accepted (and structurally validated)
	 * but not expanded — the returned ScopesSet may still contain them.
	 * Use this at authorize-time, then call {@link expandScope} to resolve
	 * the includes before storing.
	 *
	 * When false (default), `include:` scopes throw a ScopeParseError. Use
	 * this on already-expanded scope strings (e.g. when re-validating a
	 * stored token's scope).
	 */
	allowIncludes?: boolean;
	/**
	 * When true, `space:` scopes are accepted (structurally validated with
	 * `SpacePermission`). When false (default), any `space:` scope throws a
	 * ScopeParseError — the host has not enabled atproto spaces.
	 */
	allowSpaceScopes?: boolean;
}

/**
 * Validate a space-separated scope string. Returns the parsed ScopesSet on
 * success.
 */
export function parseScope(
	input: string | undefined | null,
	{ allowIncludes = false, allowSpaceScopes = false }: ParseScopeOptions = {},
): ScopesSet {
	const set = ScopesSet.fromString(input ?? "");

	if (!set.has(ATPROTO_SCOPE)) {
		throw new ScopeParseError(
			`Scope must include "${ATPROTO_SCOPE}"`,
			input ?? "",
		);
	}

	for (const scope of set) {
		if (scope === ATPROTO_SCOPE) continue;
		if ((TRANSITION_SCOPES as readonly string[]).includes(scope)) continue;

		if (scope.startsWith("include:")) {
			if (!IncludeScope.fromString(scope)) {
				throw new ScopeParseError(`Malformed include scope: ${scope}`, scope);
			}
			if (!allowIncludes) {
				throw new ScopeParseError(
					`Permission sets cannot be requested in this context: ${scope}`,
					scope,
				);
			}
			continue;
		}

		const colon = scope.indexOf(":");
		const question = scope.indexOf("?");
		const end =
			colon === -1 ? question : question === -1 ? colon : Math.min(colon, question);
		const resource = end === -1 ? scope : scope.slice(0, end);
		if (resource === "space" && !allowSpaceScopes) {
			throw new ScopeParseError(
				`Space scopes are not enabled on this server: ${scope}`,
				scope,
			);
		}
		const parser =
			STRUCTURAL_PARSERS[
				resource as (typeof GRANULAR_RESOURCES)[number]
			];
		if (!parser) {
			throw new ScopeParseError(`Unknown scope resource: ${scope}`, scope);
		}
		if (!parser(scope)) {
			throw new ScopeParseError(`Malformed scope: ${scope}`, scope);
		}
	}

	return set;
}

/**
 * Expand any `include:` scopes in the input by resolving each NSID against
 * the supplied {@link PermissionSetResolver} and replacing the include with
 * the bundle's concrete granular scopes (per the spec — only `repo:` / `rpc:`
 * inside the include's namespace authority are kept).
 *
 * Returns the rewritten space-separated scope string. Throws a
 * {@link ScopeParseError} when an include cannot be resolved.
 */
export async function expandScope(
	scope: string,
	resolver: PermissionSetResolver | undefined,
): Promise<string> {
	const tokens = scope.split(" ").filter(Boolean);
	const out = new Set<string>();

	for (const token of tokens) {
		if (!token.startsWith("include:")) {
			out.add(token);
			continue;
		}

		if (!resolver) {
			throw new ScopeParseError(
				`Permission sets are not supported: no resolver configured`,
				token,
			);
		}

		const include = IncludeScope.fromString(token);
		if (!include) {
			throw new ScopeParseError(`Malformed include scope: ${token}`, token);
		}

		let permissionSet;
		try {
			permissionSet = await resolver.resolve(
				include.nsid as unknown as AtcuteNsid,
			);
		} catch (err) {
			throw new ScopeParseError(
				`Failed to resolve permission set ${include.nsid}: ${
					err instanceof Error ? err.message : String(err)
				}`,
				token,
			);
		}

		if (!permissionSet) {
			throw new ScopeParseError(
				`Permission set ${include.nsid} is not a permission-set lexicon`,
				token,
			);
		}

		for (const expanded of include.toScopes(permissionSet)) {
			out.add(expanded);
		}
	}

	return Array.from(out).join(" ");
}

/**
 * Parse a scope token as a space permission. Returns null for non-space
 * tokens, malformed space scopes, or builds of `@atproto/oauth-scopes`
 * without `SpacePermission`.
 */
export function parseSpaceScope(token: string): SpacePermissionType | null {
	if (
		token !== "space" &&
		!token.startsWith("space:") &&
		!token.startsWith("space?")
	) {
		return null;
	}
	return SpacePermission ? SpacePermission.fromString(token) : null;
}

export interface FinalizeSpaceScopesOptions {
	/** The authenticated user's DID; replaces `authority=self`. */
	userDid: string;
	/**
	 * Resolve a space type NSID to its lexicon space declaration's
	 * `collections` list, used as the default write collections when the
	 * grant names none. Absent or failing resolution leaves the scope
	 * without default collections (reads unaffected, writes constrained to
	 * the explicitly requested collections).
	 */
	resolveSpaceCollections?: (
		nsid: string,
	) => Promise<readonly string[] | null>;
}

/**
 * Rewrite the `space:` tokens of an expanded scope string into their stored
 * form, per the proposal's grant-time requirements:
 *
 * - `authority=self` is resolved to the authenticated user's DID, so a
 *   stored grant never contains `self`.
 * - A grant with no explicit collections inherits the space type
 *   declaration's `collections` as its default write set.
 *
 * Call at code-issuance time, after `include:` expansion and before the
 * scope is stored.
 */
export async function finalizeSpaceScopes(
	scope: string,
	{ userDid, resolveSpaceCollections }: FinalizeSpaceScopesOptions,
): Promise<string> {
	const tokens = scope.split(" ").filter(Boolean);
	const out: string[] = [];

	for (const token of tokens) {
		let perm = parseSpaceScope(token);
		if (!perm) {
			out.push(token);
			continue;
		}

		if (perm.isSelfAuthority) {
			perm = perm.withResolvedAuthority(
				userDid as `did:${string}:${string}`,
			);
		}

		if (
			!perm.hasCollections &&
			perm.type !== "*" &&
			resolveSpaceCollections
		) {
			try {
				const collections = await resolveSpaceCollections(perm.type);
				if (collections && collections.length > 0) {
					perm = perm.withDefaultCollections(
						collections as readonly (
							| "*"
							| `${string}.${string}.${string}`
						)[],
					);
				}
			} catch {
				// Leave the scope without default collections; the grant still
				// covers reads and any explicitly requested collections.
			}
		}

		out.push(perm.toString());
	}

	return out.join(" ");
}

/**
 * Build a ScopePermissionsTransition for a token's stored scope string.
 *
 * The transitional flavor is the only one we hand out — it inherits all the
 * granular `allows*`/`assert*` methods from ScopePermissions and adds shims
 * so `transition:generic` etc. continue to work for legacy clients.
 */
export function permissionsFor(scope: string): ScopePermissionsTransition {
	return new ScopePermissionsTransition(scope);
}
