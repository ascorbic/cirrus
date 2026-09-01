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
	getPublicKeyFromDidController,
	P256PublicKey,
	Secp256k1PublicKey,
	type PublicKey,
} from "@atcute/crypto";
import {
	getAtprotoVerificationMaterial,
	getPdsEndpoint,
} from "@atcute/identity";
import type { DidDocumentResolver } from "@atcute/identity-resolver";
import {
	DohJsonLexiconAuthorityResolver,
	LexiconSchemaResolver,
} from "@atcute/lexicon-resolver";
import { isNsid, type AtprotoDid, type Nsid } from "@atcute/lexicons/syntax";
import { verifyRecord } from "@atcute/repo";
import type { LexiconPermissionSet } from "@atproto/oauth-scopes";

export type { LexiconPermissionSet };

/** Collection that lexicon schema records (permission sets, spaces) live in. */
const LEXICON_SCHEMA_COLLECTION = "com.atproto.lexicon.schema";

/**
 * A lexicon space type declaration (`type: 'space'`), per the permissioned
 * data proposal. Mirrors `@atproto/oauth-scopes`'s internal `LexiconSpace`
 * type, which the alpha build does not re-export from its entry point.
 */
export type LexiconSpace = {
	readonly type: "space";
	readonly name: string;
	readonly "name:lang"?: Readonly<Record<string, string>>;
	readonly collections: readonly string[];
	readonly description?: string;
};

export interface PermissionSetResolver {
	/**
	 * Resolve an NSID to its permission-set lexicon definition. Returns null
	 * when the lexicon exists but is not a permission-set document, and throws
	 * when resolution itself fails (network, signature, etc.).
	 */
	resolve(nsid: Nsid): Promise<LexiconPermissionSet | null>;
	/**
	 * Resolve an NSID to its lexicon space declaration (`type: 'space'`).
	 * Returns null when the lexicon exists but is not a space declaration,
	 * and throws when resolution itself fails. Used by the consent UI to
	 * show a space type's human name, and at grant time to default a space
	 * scope's write collections. Optional for backwards compatibility.
	 */
	resolveSpaceDeclaration?(nsid: Nsid): Promise<LexiconSpace | null>;
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
	const fetchImpl = opts.fetch ?? globalThis.fetch;
	const authority = new DohJsonLexiconAuthorityResolver({
		dohUrl: opts.dohUrl,
		fetch: opts.fetch,
	});
	const schema = new LexiconSchemaResolver({
		didDocumentResolver: opts.didDocumentResolver,
		fetch: opts.fetch,
	});

	const resolveMain = async (nsid: Nsid) => {
		const did = await authority.resolve(nsid);
		const resolved = await schema.resolve(did, nsid);
		return (resolved.schema as { defs?: Record<string, unknown> }).defs
			?.main as { type?: string } | undefined;
	};

	/**
	 * Resolve a lexicon record's `defs.main` with the SAME proof guarantees as
	 * {@link LexiconSchemaResolver.resolve} — resolve the DID document, find the
	 * PDS, fetch the record as a proof CAR, and verify the commit signature
	 * against the key in the DID document — but WITHOUT its final
	 * whole-document validation.
	 *
	 * WORKAROUND: `@atcute/lexicon-resolver` finishes by parsing the fetched
	 * document with `@atcute/lexicon-doc`, whose def-type whitelist has no
	 * `type: "space"` (as of lexicon-doc 2.2.0). A correctly published
	 * spaces-alpha type declaration therefore throws `InvalidLexiconSchemaError`
	 * (invalid_literal at `.defs.main.type`) and never returns, so the consent
	 * UI shows "could not resolve space type declaration" for every space
	 * scope. Replicating steps 1–3 here keeps full proof verification on the
	 * space path while letting us validate `defs.main` against our own
	 * {@link LexiconSpace} shape instead.
	 *
	 * Deliberately NOT an unauthenticated `com.atproto.repo.getRecord`: the
	 * signature proof is part of the lexicon-resolution contract.
	 *
	 * Remove this and route the space path back through
	 * `LexiconSchemaResolver.resolve()` once lexicon-doc gains the `space` def
	 * type (upstream: https://github.com/mary-ext/atcute).
	 */
	const resolveVerifiedMain = async (
		did: AtprotoDid,
		nsid: Nsid,
	): Promise<unknown> => {
		// Step 1: DID document → PDS service endpoint.
		const didDocument = await opts.didDocumentResolver.resolve(did);
		const pdsEndpoint = getPdsEndpoint(didDocument);
		if (!pdsEndpoint) {
			throw new Error(`no atproto PDS in DID document; did=${did}`);
		}

		// Step 2: fetch the lexicon record as a proof CAR.
		const url = new URL("/xrpc/com.atproto.sync.getRecord", pdsEndpoint);
		url.searchParams.set("did", did);
		url.searchParams.set("collection", LEXICON_SCHEMA_COLLECTION);
		url.searchParams.set("rkey", nsid);
		const response = await fetchImpl(url, {
			headers: { accept: "application/vnd.ipld.car" },
		});
		if (!response.ok) {
			throw new Error(
				`failed to fetch lexicon record; nsid=${nsid}; status=${response.status}`,
			);
		}
		const carBytes = new Uint8Array(await response.arrayBuffer());

		// Step 3: verify the record's commit signature against the DID
		// document's atproto key — identical to LexiconSchemaResolver's proof
		// check, so this path is no weaker than the permission-set path.
		const material = getAtprotoVerificationMaterial(didDocument);
		if (!material) {
			throw new Error(
				`DID document has no atproto verification material; did=${did}`,
			);
		}
		const found = getPublicKeyFromDidController(material);
		const publicKey: PublicKey =
			found.type === "p256"
				? await P256PublicKey.importRaw(found.publicKeyBytes)
				: await Secp256k1PublicKey.importRaw(found.publicKeyBytes);
		const verified = await verifyRecord({
			did,
			collection: LEXICON_SCHEMA_COLLECTION,
			rkey: nsid,
			publicKey,
			carBytes,
		});

		// Sanity-check the record envelope (mirrors the resolver) before
		// trusting `defs.main`.
		const raw = verified.record;
		if (
			typeof raw !== "object" ||
			raw === null ||
			(raw as { $type?: unknown }).$type !== LEXICON_SCHEMA_COLLECTION ||
			(raw as { id?: unknown }).id !== nsid
		) {
			throw new Error(`invalid lexicon schema record; nsid=${nsid}`);
		}
		return (raw as { defs?: Record<string, unknown> }).defs?.main;
	};

	return {
		async resolve(nsid) {
			const main = await resolveMain(nsid);
			if (!main || main.type !== "permission-set") return null;
			return main as unknown as LexiconPermissionSet;
		},
		async resolveSpaceDeclaration(nsid) {
			const did = await authority.resolve(nsid);
			const main = await resolveVerifiedMain(did, nsid);
			if (
				typeof main !== "object" ||
				main === null ||
				(main as { type?: unknown }).type !== "space"
			) {
				// Not a space type declaration (e.g. a permission set). The
				// caller treats null as "no space metadata", not an error.
				return null;
			}
			// Validate against the local LexiconSpace shape. The record itself
			// is already proof-verified above; this only guards the fields the
			// consent UI and grant-time collection defaulting rely on.
			const decl = main as Record<string, unknown>;
			if (typeof decl.name !== "string") {
				throw new Error(
					`space type declaration is missing a name; nsid=${nsid}`,
				);
			}
			if (
				!Array.isArray(decl.collections) ||
				!decl.collections.every((c) => isNsid(c))
			) {
				throw new Error(
					`space type declaration has invalid collections; nsid=${nsid}`,
				);
			}
			return main as unknown as LexiconSpace;
		},
	};
}
