/**
 * Browser-safe DID resolution, just enough for the suite: fetch a DID
 * document (did:web from its host, did:plc from a PLC directory) and read
 * the keys and service entries the spaces protocol relies on — `#atproto`
 * (signs space tokens), `#atproto_kem` (the repo's KEM key) and
 * `#atproto_pds` (the account's host, which is also its space host).
 *
 * Resolution goes through `ctx.fetch`, so an in-process fixture that
 * serves its own did:web document resolves without a network. A harness
 * with unusual resolution supplies `ctx.resolveDid` instead.
 */

import type { CheckContext } from "./model.js";
import { fromBase58 } from "./encoding.js";
import { compressP256, formatDidKey } from "./space-auth.js";

export const DEFAULT_PLC_DIRECTORY = "https://plc.directory";

export interface DidDocument {
	id: string;
	alsoKnownAs?: string[];
	verificationMethod?: Array<{
		id: string;
		type: string;
		controller?: string;
		publicKeyMultibase?: string;
	}>;
	service?: Array<{ id: string; type: string; serviceEndpoint: unknown }>;
}

/** The URL a DID document is fetched from, mirroring the reference resolver. */
export function didDocumentUrl(did: string, plcDirectory?: string): string {
	if (did.startsWith("did:web:")) {
		const host = decodeURIComponent(did.slice("did:web:".length));
		if (host.includes(":") && !/^localhost:\d+$/.test(host)) {
			throw new Error(`did:web with a path is not supported: ${did}`);
		}
		const scheme = host.split(":")[0] === "localhost" ? "http" : "https";
		return `${scheme}://${host}/.well-known/did.json`;
	}
	if (did.startsWith("did:plc:")) {
		return `${(plcDirectory ?? DEFAULT_PLC_DIRECTORY).replace(/\/+$/, "")}/${did}`;
	}
	throw new Error(`unsupported DID method: ${did}`);
}

export async function resolveDidDocument(
	ctx: Pick<CheckContext, "fetch" | "target" | "resolveDid">,
	did: string,
): Promise<DidDocument> {
	if (ctx.resolveDid) {
		const doc = await ctx.resolveDid(did);
		if (!doc) throw new Error(`could not resolve ${did}`);
		return doc as DidDocument;
	}
	const url = didDocumentUrl(did, ctx.target.plcDirectory);
	const res = await ctx.fetch(url, {
		headers: { accept: "application/did+ld+json,application/json" },
	});
	if (!res.ok) throw new Error(`resolving ${did}: ${url} returned ${res.status}`);
	const doc = (await res.json()) as DidDocument;
	if (doc.id !== did) {
		throw new Error(`DID document for ${did} names itself ${doc.id}`);
	}
	return doc;
}

const matchesFragment = (id: string, did: string, fragment: string) =>
	id === `#${fragment}` || id === `${did}#${fragment}`;

/**
 * A verification method as a did:key, accepting the `Multikey` form and
 * the legacy 2019 types PLC still emits (raw key bytes, no multicodec).
 */
export function verificationMethodDidKey(
	doc: DidDocument,
	fragment: string,
): string | undefined {
	const method = (doc.verificationMethod ?? []).find((m) =>
		matchesFragment(m.id, doc.id, fragment),
	);
	const multibase = method?.publicKeyMultibase;
	if (!method || !multibase?.startsWith("z")) return undefined;
	try {
		if (method.type === "Multikey") {
			return `did:key:${multibase}`;
		}
		const raw = fromBase58(multibase.slice(1));
		if (method.type === "EcdsaSecp256r1VerificationKey2019") {
			return formatDidKey("ES256", raw.length === 65 ? compressP256(raw) : raw);
		}
		if (method.type === "EcdsaSecp256k1VerificationKey2019") {
			// Point compression is curve-agnostic: parity of y, then x.
			return formatDidKey("ES256K", raw.length === 65 ? compressP256(raw) : raw);
		}
	} catch {
		return undefined;
	}
	return undefined;
}

export function serviceEndpoint(
	doc: DidDocument,
	fragment: string,
): string | undefined {
	const entry = (doc.service ?? []).find((s) =>
		matchesFragment(s.id, doc.id, fragment),
	);
	return typeof entry?.serviceEndpoint === "string"
		? entry.serviceEndpoint
		: undefined;
}

/**
 * The repo's `#atproto_kem` key, cached per run: every MAC request against
 * a repo needs it, and a run reads the same few repos many times.
 */
export async function kemKeyFor(
	ctx: Pick<CheckContext, "fetch" | "target" | "resolveDid" | "state">,
	did: string,
): Promise<string> {
	const cacheKey = `did.kem.${did}`;
	const cached = ctx.state.get(cacheKey);
	if (typeof cached === "string") return cached;
	const doc = await resolveDidDocument(ctx, did);
	const kem = verificationMethodDidKey(doc, "atproto_kem");
	if (!kem) throw new Error(`${did} publishes no #atproto_kem key`);
	ctx.state.set(cacheKey, kem);
	return kem;
}
