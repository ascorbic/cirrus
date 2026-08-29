/**
 * Minimal atproto service-auth JWT creation, used for outbound
 * `com.atproto.space.notifyWrite` / `notifySpaceDeleted` calls. Matches the
 * shape `verifyServiceJwt` implementations expect: `{iss, aud, lxm?, jti,
 * iat, exp}` signed with the account signing key (alg from the keypair).
 */

import type { Keypair } from "@atproto/crypto";

const encoder = new TextEncoder();

function base64url(bytes: Uint8Array): string {
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export interface ServiceJwtParams {
	iss: string;
	aud: string;
	lxm?: string;
	/** Lifetime in seconds (default 60). */
	expiresInSec?: number;
}

export async function createServiceJwt(
	params: ServiceJwtParams,
	keypair: Keypair,
): Promise<string> {
	const iat = Math.floor(Date.now() / 1000);
	const header = { typ: "JWT", alg: keypair.jwtAlg };
	const payload: Record<string, unknown> = {
		iat,
		iss: params.iss,
		aud: params.aud,
		exp: iat + (params.expiresInSec ?? 60),
		jti: crypto.randomUUID(),
	};
	if (params.lxm) payload.lxm = params.lxm;

	const signingInput = `${base64url(encoder.encode(JSON.stringify(header)))}.${base64url(
		encoder.encode(JSON.stringify(payload)),
	)}`;
	const sig = await keypair.sign(encoder.encode(signingInput));
	return `${signingInput}.${base64url(sig)}`;
}
