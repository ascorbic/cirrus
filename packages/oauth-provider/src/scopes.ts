/**
 * Scope parsing and matching, built on @atproto/oauth-scopes.
 *
 * Phase 1: granular scopes are parsed and enforced; `include:` (permission
 * sets) is rejected with invalid_scope. Phase 2 will resolve includes against
 * a lexicon-permission-set resolver and expand them inline at authorize-time.
 */

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

export { ScopeMissingError, ScopePermissionsTransition, ScopesSet };

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
};

/**
 * Validate a space-separated scope string. Returns the parsed ScopesSet on
 * success.
 *
 * In Phase 1 we reject `include:` here because we don't yet resolve permission
 * sets. The caller should turn this into an `invalid_scope` OAuth error.
 */
export function parseScope(input: string | undefined | null): ScopesSet {
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
			throw new ScopeParseError(
				`Permission sets are not yet supported: ${scope}`,
				scope,
			);
		}

		const colon = scope.indexOf(":");
		const resource = colon === -1 ? scope : scope.slice(0, colon);
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
 * Build a ScopePermissionsTransition for a token's stored scope string.
 *
 * The transitional flavor is the only one we hand out — it inherits all the
 * granular `allows*`/`assert*` methods from ScopePermissions and adds shims
 * so `transition:generic` etc. continue to work for legacy clients.
 */
export function permissionsFor(scope: string): ScopePermissionsTransition {
	return new ScopePermissionsTransition(scope);
}
