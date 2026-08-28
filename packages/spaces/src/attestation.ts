/**
 * Client attestation verification (app-identity gating, `allowList` app
 * access). The attestation is a short-lived JWT signed by the OAuth
 * client's published JWKS key, with `iss` = `sub` = client_id and `aud`
 * the space host. Verified against the client's `client-metadata.json`.
 */

import { createLocalJWKSet, createRemoteJWKSet, jwtVerify } from "jose";
import { SPACE_TOKEN_TYPES, parseSpaceToken } from "@atproto/space";
import { SpaceError } from "./errors.js";
import type { CheckReplay } from "./auth.js";

export interface VerifyAttestationOpts {
	/** Expected audience: `spaceHostAud(authorityDid)`. */
	expectedAud: string;
	checkReplay: CheckReplay;
	/** Fetch override for tests. */
	fetch?: typeof fetch;
}

/**
 * Verify a client attestation and return the attested client_id.
 * Single-use by `(clientId, jti)`.
 */
export async function verifyClientAttestation(
	attestation: string,
	opts: VerifyAttestationOpts,
): Promise<string> {
	let parsed;
	try {
		parsed = parseSpaceToken("clientAttestation", attestation);
	} catch (err) {
		throw invalid(err);
	}
	const clientId = parsed.payload.iss;
	if (parsed.payload.aud !== opts.expectedAud) {
		throw new SpaceError(
			"InvalidClientAttestation",
			"Attestation audience does not match this space host",
		);
	}

	const doFetch = opts.fetch ?? fetch;
	let metadata: { jwks?: unknown; jwks_uri?: string };
	try {
		const res = await doFetch(clientId, {
			headers: { Accept: "application/json" },
		});
		if (!res.ok) {
			throw new Error(`client metadata fetch returned ${res.status}`);
		}
		metadata = (await res.json()) as typeof metadata;
	} catch {
		throw new SpaceError(
			"InvalidClientAttestation",
			"Could not resolve client metadata",
		);
	}

	const keySet = metadata.jwks
		? createLocalJWKSet(metadata.jwks as Parameters<typeof createLocalJWKSet>[0])
		: metadata.jwks_uri
			? createRemoteJWKSet(new URL(metadata.jwks_uri), {
					[Symbol.for("jose.jwks.fetch")]: doFetch,
				} as never)
			: null;
	if (!keySet) {
		throw new SpaceError(
			"InvalidClientAttestation",
			"Client metadata declares no JWKS",
		);
	}

	try {
		await jwtVerify(attestation, keySet, {
			issuer: clientId,
			subject: clientId,
			audience: opts.expectedAud,
			typ: SPACE_TOKEN_TYPES.clientAttestation.typ,
			requiredClaims: ["jti", "exp"],
			clockTolerance: 5,
		});
	} catch (err) {
		throw invalid(err);
	}

	const fresh = await opts.checkReplay(
		"attestation",
		`${clientId}:${parsed.payload.jti}`,
		parsed.payload.exp,
	);
	if (!fresh) {
		throw new SpaceError(
			"InvalidClientAttestation",
			"Client attestation has already been used",
		);
	}
	return clientId;
}

function invalid(err: unknown): SpaceError {
	return new SpaceError(
		"InvalidClientAttestation",
		err instanceof Error ? err.message : "Invalid client attestation",
	);
}
