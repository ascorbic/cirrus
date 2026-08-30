/**
 * Browser-safe DPoP: WebCrypto ES256 keys and RFC 9449 proofs.
 *
 * This is deliberately dependency-free so the checks that only need a
 * DPoP-bound credential exchange — the operator's own delegation →
 * credential → read flow — can run in a browser bundle. The proof format
 * mirrors `@atproto/space`'s `createDpopProof` exactly (same claims, same
 * htu normalization, same `ath` hash), which the fixture adapters and the
 * reference matrix verify end-to-end: a proof the servers reject fails
 * those runs loudly.
 */

import type { DpopKey } from "./model.js";

function b64url(bytes: Uint8Array): string {
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * WebCrypto ES256 DPoP key implementing the minimal surface a DPoP proof
 * needs (`bareJwk`, `algorithms`, `createJwt`) plus the RFC 7638
 * thumbprint. Hand-rolled to avoid `@atproto/jwk-jose`, whose bundled jose
 * resolves to its Node build under the workers test pool and cannot sign.
 */
export async function createDpopKey(): Promise<DpopKey> {
	const pair = await crypto.subtle.generateKey(
		{ name: "ECDSA", namedCurve: "P-256" },
		true,
		["sign"],
	);
	const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
	// Canonical JWK for an EC key, RFC 7638 member order.
	const bareJwk = { crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y } as Record<
		string,
		unknown
	>;
	const thumbInput = new TextEncoder().encode(JSON.stringify(bareJwk));
	const jkt = b64url(
		new Uint8Array(await crypto.subtle.digest("SHA-256", thumbInput)),
	);
	const encode = (obj: unknown) =>
		b64url(new TextEncoder().encode(JSON.stringify(obj)));
	return {
		bareJwk,
		algorithms: ["ES256"],
		jkt,
		async createJwt(header, payload) {
			const input = `${encode(header)}.${encode(payload)}`;
			const sig = new Uint8Array(
				await crypto.subtle.sign(
					{ name: "ECDSA", hash: "SHA-256" },
					pair.privateKey,
					new TextEncoder().encode(input),
				),
			);
			return `${input}.${b64url(sig)}`;
		},
	};
}

/**
 * An RFC 9449 DPoP proof over `key`, matching the reference verifier:
 * header `{alg, typ: "dpop+jwt", jwk}`; claims `jti` (random), `htm`,
 * `htu` (query and fragment stripped, RFC 9449 §4.2), `iat`, and — only
 * when presenting a credential — `ath`, the base64url SHA-256 of it.
 */
export async function createDpopProofJwt(
	key: DpopKey,
	opts: { htm: string; htu: string; credential?: string },
): Promise<string> {
	const htuUrl = new URL(opts.htu);
	const jti = b64url(crypto.getRandomValues(new Uint8Array(16)));
	const ath =
		opts.credential !== undefined
			? b64url(
					new Uint8Array(
						await crypto.subtle.digest(
							"SHA-256",
							new TextEncoder().encode(opts.credential),
						),
					),
				)
			: undefined;
	return key.createJwt(
		{ alg: "ES256", typ: "dpop+jwt", jwk: key.bareJwk },
		{
			jti,
			htm: opts.htm,
			htu: htuUrl.origin + htuUrl.pathname,
			...(ath !== undefined ? { ath } : {}),
			iat: Math.floor(Date.now() / 1000),
		},
	);
}
