/**
 * Permission set resolution.
 *
 * Permission sets are Lexicon documents (`type: 'permission-set'`) that bundle
 * granular `repo:` / `rpc:` permissions under one NSID. Clients reference them
 * via `include:NSID?aud=...` in their requested scope; the authorization
 * server resolves the NSID, expands the bundled permissions inline, and
 * stores the expanded form in the issued token.
 *
 * This module provides:
 *   - {@link PermissionSetResolver}: the abstract interface.
 *   - {@link createAtcutePermissionSetResolver}: a default resolver wrapping
 *     `@atcute/lexicon-resolver` (DNS-based authority + AT-URI schema fetch).
 */

import {
	DohJsonLexiconAuthorityResolver,
	LexiconSchemaResolver,
} from "@atcute/lexicon-resolver";
import type { DidDocumentResolver } from "@atcute/identity-resolver";
import type { Nsid } from "@atcute/lexicons/syntax";
import type { LexiconPermissionSet } from "@atproto/oauth-scopes";

export type { LexiconPermissionSet };

export interface PermissionSetResolver {
	/**
	 * Resolve an NSID to its permission-set lexicon definition. Returns null
	 * when the lexicon exists but is not a permission-set document, and throws
	 * when resolution itself fails (network, signature, etc.).
	 */
	resolve(nsid: Nsid): Promise<LexiconPermissionSet | null>;
}

export interface CreateAtcutePermissionSetResolverOptions {
	/**
	 * DNS-over-HTTPS endpoint for resolving the authority DID for a lexicon
	 * NSID. Cloudflare's `https://mozilla.cloudflare-dns.com/dns-query` is a
	 * reasonable default.
	 */
	dohUrl: string;
	/**
	 * DID document resolver, used to find the PDS hosting the lexicon record.
	 */
	didDocumentResolver: DidDocumentResolver;
	/** Optional fetch override (e.g. for tests). */
	fetch?: typeof fetch;
}

/**
 * Build a permission-set resolver backed by `@atcute/lexicon-resolver`. Two
 * stages:
 *   1. NSID → authority DID via DoH.
 *   2. (DID, NSID) → ResolvedSchema (lexicon doc) by fetching from the PDS.
 *
 * The returned `LexiconPermissionSet` is the `defs.main` entry of the lexicon
 * if and only if it has `type: 'permission-set'`. Anything else returns null.
 */
export function createAtcutePermissionSetResolver(
	opts: CreateAtcutePermissionSetResolverOptions,
): PermissionSetResolver {
	const authority = new DohJsonLexiconAuthorityResolver({
		dohUrl: opts.dohUrl,
		fetch: opts.fetch,
	});
	const schema = new LexiconSchemaResolver({
		didDocumentResolver: opts.didDocumentResolver,
		fetch: opts.fetch,
	});

	return {
		async resolve(nsid) {
			const did = await authority.resolve(nsid);
			const resolved = await schema.resolve(did, nsid);
			const main = (resolved.schema as { defs?: Record<string, unknown> })
				.defs?.main as { type?: string } | undefined;
			if (!main || main.type !== "permission-set") return null;
			return main as unknown as LexiconPermissionSet;
		},
	};
}
