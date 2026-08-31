/**
 * Crypto-bound helpers for the identity checks: minting delegation tokens
 * as harness-held reader/writer identities, and exchanging them for
 * credentials — built on `@atproto/space`'s token primitives.
 *
 * Note on using the reference lib to mint: these helpers generate tokens
 * with the same library the target is expected to interoperate with. That
 * is deliberate — the point of a credential check is that the *target's*
 * verification accepts a correctly-formed token, and "correctly formed" is
 * defined by the reference lib every implementation must interop with.
 *
 * Everything an operator session can do without foreign identities —
 * probe spaces, record writes, the self credential flow — lives in the
 * browser-safe `../checks/operator.js` and is re-exported here so the
 * full entry keeps its historical surface.
 */

import { createSpaceToken, spaceHostAud } from "@atproto/space";
import type { CheckContext, HarnessIdentity } from "../model.js";
import { createDpopProofJwt } from "../dpop.js";
import { xrpcPost, type XrpcResult } from "../http.js";
import type { Credential } from "../checks/operator.js";

export {
	createProbeSpace,
	deleteProbeSpace,
	operatorCreateRecord,
	obtainCredentialViaDelegation,
	credentialGet,
} from "../checks/operator.js";
export type { Credential, ProbeSpace } from "../checks/operator.js";

/** Adapt a harness identity to the `Keypair` surface token minting uses. */
function keypairFor(identity: HarnessIdentity) {
	return {
		jwtAlg: identity.jwtAlg,
		sign: (bytes: Uint8Array) => identity.sign(bytes),
		did: () => identity.did,
	} as never;
}

/** Mint a delegation token for `identity` against `space`. */
export async function mintDelegation(
	ctx: CheckContext,
	identity: HarnessIdentity,
	space: string,
	audOverride?: string,
): Promise<string> {
	return createSpaceToken(
		"delegation",
		{
			iss: identity.did,
			sub: space,
			aud: audOverride ?? spaceHostAud(ctx.target.did),
		},
		keypairFor(identity),
	);
}

/**
 * The full obtain flow: mint a delegation token as `identity`, exchange it
 * at the target for a credential bound to a fresh DPoP key. Returns the
 * raw XrpcResult alongside the credential so callers can assert on refusals.
 */
export async function obtainCredential(
	ctx: CheckContext,
	identity: HarnessIdentity,
	space: string,
	opts: { audOverride?: string; clientAttestation?: string } = {},
): Promise<{ result: XrpcResult; credential?: Credential }> {
	if (!ctx.identities)
		throw new Error("obtainCredential needs an identity provider");
	const dpopKey = await ctx.identities.dpopKey();
	const delegation = await mintDelegation(
		ctx,
		identity,
		space,
		opts.audOverride,
	);
	const proof = await createDpopProofJwt(dpopKey, {
		htm: "POST",
		htu: `${ctx.target.origin}/xrpc/com.atproto.space.getSpaceCredential`,
	});
	const result = await xrpcPost(
		ctx,
		"com.atproto.space.getSpaceCredential",
		{
			space,
			...(opts.clientAttestation
				? { clientAttestation: opts.clientAttestation }
				: {}),
		},
		{ Authorization: `Bearer ${delegation}`, DPoP: proof },
	);
	if (result.status === 200) {
		const credential = (result.json as { credential: string }).credential;
		return { result, credential: { credential, dpopKey } };
	}
	return { result };
}
