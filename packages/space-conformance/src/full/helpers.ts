/**
 * Crypto-bound helpers: tokens minted as harness-held identities
 * (delegation tokens as a reader, credentials as a foreign authority,
 * service auth as a writer's PDS) and the reference library's verifiers
 * for the MACs, commits and archives a target serves.
 *
 * Using the reference library to mint and verify is deliberate: "correctly
 * formed" is defined by the library every implementation must interoperate
 * with, so a token it mints is one the target must accept, and an artefact
 * it rejects is one no other implementation could consume.
 */

import {
	COMMIT_MAC_TYPE,
	RECORD_MAC_TYPE,
	createSpaceToken,
	parseMacHeader,
	spaceHostAud,
	type Commit,
} from "@atproto/space";
import type { CheckContext, HarnessIdentity } from "../model.js";
import { toBase64Url, utf8, lexBytes } from "../encoding.js";
import { MAC_HEADER } from "../space-auth.js";
import {
	requestCredential,
	spaceAuthority,
	type Credential,
	type CredentialResult,
} from "../checks/probe.js";
import type { XrpcResult } from "../http.js";

export {
	createProbeSpace,
	deleteProbeSpace,
	operatorCreateRecord,
	obtainCredentialViaDelegation,
	obtainPublicCredential,
	credentialGet,
	credentialCall,
	requestCredential,
} from "../checks/probe.js";
export type { Credential, ProbeSpace } from "../checks/probe.js";

/** Adapt a harness identity to the `Keypair` surface token minting uses. */
export function keypairFor(identity: HarnessIdentity) {
	return {
		jwtAlg: identity.jwtAlg,
		sign: (bytes: Uint8Array) => identity.sign(bytes),
		did: () => identity.did,
	} as never;
}

/**
 * Mint a delegation token for `identity` against `space`, addressed (by
 * default) to the space authority's `#atproto_pds` — the space host.
 */
export function mintDelegation(
	identity: HarnessIdentity,
	space: string,
	audOverride?: string,
): Promise<string> {
	return createSpaceToken(
		"delegation",
		{
			iss: identity.did,
			sub: space,
			aud: audOverride ?? spaceHostAud(spaceAuthority(space)),
		},
		keypairFor(identity),
	);
}

/**
 * The full obtain flow as a foreign user: mint a delegation token as
 * `identity` and exchange it for a credential bound to a fresh P-256 key.
 * Returns the raw result so callers can assert on refusals.
 */
export async function obtainCredential(
	ctx: CheckContext,
	identity: HarnessIdentity,
	space: string,
	opts: { audOverride?: string; clientAttestation?: string } = {},
): Promise<{ result: XrpcResult; credential?: Credential }> {
	return requestCredential(ctx, space, {
		delegationToken: await mintDelegation(identity, space, opts.audOverride),
		...(opts.clientAttestation
			? { clientAttestation: opts.clientAttestation }
			: {}),
	});
}

/**
 * Mint a credential as the authority of `space` — a harness identity
 * playing a foreign space authority whose credentials a repo host must
 * honour for reads of its repos in that space.
 */
export async function mintCredential(
	authority: HarnessIdentity,
	space: string,
	keyDid: string,
): Promise<string> {
	return createSpaceToken(
		"credential",
		{
			iss: authority.did,
			sub: space,
			keyId: keyDid as `did:${string}:${string}`,
		},
		keypairFor(authority),
	);
}

/** An inter-service auth JWT (`lxm`-scoped), signed as `identity`. */
export async function serviceJwt(
	identity: HarnessIdentity,
	opts: { aud: string; lxm: string; expiresInSec?: number },
): Promise<string> {
	const iat = Math.floor(Date.now() / 1000);
	const header = { typ: "JWT", alg: identity.jwtAlg };
	const payload = {
		iss: identity.did,
		aud: opts.aud,
		iat,
		exp: iat + (opts.expiresInSec ?? 60),
		lxm: opts.lxm,
		jti: toBase64Url(crypto.getRandomValues(new Uint8Array(16))),
	};
	const input = `${toBase64Url(utf8(JSON.stringify(header)))}.${toBase64Url(utf8(JSON.stringify(payload)))}`;
	const sig = await identity.sign(utf8(input));
	return `${input}.${toBase64Url(sig)}`;
}

/** A commit as the wire JSON carries it, with `data` decoded. */
export function commitFromJson(value: unknown): Commit | undefined {
	if (!value || typeof value !== "object") return undefined;
	const raw = value as Record<string, unknown>;
	const data = lexBytes(raw.data);
	if (!data) return undefined;
	return { ...(raw as Omit<Commit, "data">), data } as Commit;
}

/** The MAC a credentialed response carried, or undefined. */
export function responseMac(res: CredentialResult): Uint8Array | undefined {
	const header = res.headers.get(MAC_HEADER);
	if (!header) return undefined;
	try {
		return parseMacHeader(
			header,
			res.macType === RECORD_MAC_TYPE ? RECORD_MAC_TYPE : COMMIT_MAC_TYPE,
		);
	} catch {
		return undefined;
	}
}

/** Drain an async byte stream (an archive serializer) into one buffer. */
export async function collectBytes(
	chunks: AsyncIterable<Uint8Array>,
): Promise<Uint8Array> {
	const parts: Uint8Array[] = [];
	for await (const chunk of chunks) parts.push(chunk);
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
}
