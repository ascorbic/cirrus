/**
 * Delegation tokens, minted by the user's PDS for a space hosted anywhere.
 *
 * Thin wrappers over `@atproto/space`, which is bundled into this package
 * (consumers must never resolve its alpha dependency ranges), so a host
 * gets them without depending on that build or its types.
 */

import {
	createDelegationToken as upstreamCreateDelegationToken,
	spaceHostAud as upstreamSpaceHostAud,
} from "@atproto/space";
import type { SpaceSigningKeypair } from "./types.js";

/**
 * How a space authority is addressed as the space host: its `#atproto_pds`
 * service entry, the audience of delegation tokens and client attestations.
 */
export function spaceHostAud(authority: string): string {
	return upstreamSpaceHostAud(authority as `did:${string}:${string}`);
}

/**
 * Mint a delegation token: the user's PDS vouching, for 60 seconds and one
 * use, that `iss` wants a credential for `space` from its authority.
 */
export function createDelegationToken(
	params: { iss: string; space: string; authority: string },
	keypair: SpaceSigningKeypair,
): Promise<string> {
	return upstreamCreateDelegationToken({
		iss: params.iss as `did:${string}:${string}`,
		sub: params.space as never,
		aud: spaceHostAud(params.authority) as never,
		keypair: keypair as never,
	});
}
