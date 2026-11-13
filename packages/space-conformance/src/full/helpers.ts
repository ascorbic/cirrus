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
	createDelegationToken,
	createSpaceCredential,
	spaceHostAud,
	type SpaceCommit,
} from "@atproto/space";
import type { CheckContext, HarnessIdentity } from "../model.js";
import { lexBytes, toBase64Url, utf8 } from "../encoding.js";
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

type Did = `did:${string}:${string}`;

/** Adapt a harness identity to the `Signer` surface token minting uses. */
function keypairFor(identity: HarnessIdentity) {
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
	return createDelegationToken({
		iss: identity.did as Did,
		sub: space as never,
		aud: audOverride ?? spaceHostAud(spaceAuthority(space) as Did),
		keypair: keypairFor(identity),
	});
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
export function mintCredential(
	authority: HarnessIdentity,
	space: string,
	keyDid: string,
): Promise<string> {
	return createSpaceCredential({
		iss: authority.did as Did,
		sub: space as never,
		keyId: keyDid as Did,
		keypair: keypairFor(authority),
	});
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
export function commitFromJson(value: unknown): SpaceCommit | undefined {
	if (!value || typeof value !== "object") return undefined;
	const raw = value as Record<string, unknown>;
	const data = lexBytes(raw.data);
	if (!data) return undefined;
	return { ...(raw as Omit<SpaceCommit, "data">), data } as SpaceCommit;
}

/** What `verifyCommit` / `verifyRecord` / `verifyRepoStar` need from a MAC'd response. */
export function macParams(res: CredentialResult) {
	if (!res.keyShare || !res.sharedSecret) {
		throw new Error("the response was not requested with a MAC");
	}
	return {
		keyShare: res.keyShare as Did,
		sharedSecret: res.sharedSecret,
		headers: res.headers,
	};
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
