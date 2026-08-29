/**
 * Client attestation verification (app-identity gating, `allowList` app
 * access). The attestation is a short-lived JWT signed by the OAuth
 * client's published JWKS key, with `iss` = `sub` = client_id and `aud`
 * the space host. Verified against the client's `client-metadata.json`.
 *
 * The client_id in the payload is attacker-controlled until the signature
 * verifies, so nothing is fetched before it has been validated as an
 * https client-metadata URL and checked against the caller's allow-list —
 * a space gated on an allow-list never performs network I/O for a client
 * that could not be authorized anyway. All fetches are bounded by a
 * timeout.
 */

import { createLocalJWKSet, jwtVerify } from "jose";
import { SPACE_TOKEN_TYPES, parseSpaceToken } from "@atproto/space";
import { SpaceError } from "./errors.js";
import type { CheckReplay } from "./auth.js";

/** Upper bound for each outbound metadata/JWKS fetch. */
const FETCH_TIMEOUT_MS = 5000;

export interface VerifyAttestationOpts {
	/** Expected audience: `spaceHostAud(authorityDid)`. */
	expectedAud: string;
	/**
	 * When set, an (unverified) client_id outside this list is rejected
	 * before any network I/O. The membership check runs regardless of
	 * signature state because the caller re-derives authorization from the
	 * returned client_id after full verification.
	 */
	allowedClientIds?: readonly string[];
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

	// Everything below this point costs network I/O, so gate on what can be
	// decided statically first: the client_id must be a plausible https
	// client-metadata URL, and must be one the space could authorize at all.
	let clientUrl: URL;
	try {
		clientUrl = new URL(clientId);
	} catch {
		throw new SpaceError(
			"InvalidClientAttestation",
			"Attestation client_id is not a URL",
		);
	}
	if (clientUrl.protocol !== "https:" || clientUrl.username || clientUrl.password) {
		throw new SpaceError(
			"InvalidClientAttestation",
			"Attestation client_id must be a plain https URL",
		);
	}
	if (opts.allowedClientIds && !opts.allowedClientIds.includes(clientId)) {
		throw new SpaceError(
			"AppNotAuthorized",
			"App is not authorized for this space",
		);
	}

	const doFetch = opts.fetch ?? fetch;
	const boundedJson = async (url: string): Promise<unknown> => {
		const res = await doFetch(url, {
			headers: { Accept: "application/json" },
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
			redirect: "error",
		});
		if (!res.ok) {
			throw new Error(`fetch of ${url} returned ${res.status}`);
		}
		return res.json();
	};

	let metadata: { jwks?: unknown; jwks_uri?: string };
	try {
		metadata = (await boundedJson(clientId)) as typeof metadata;
	} catch {
		throw new SpaceError(
			"InvalidClientAttestation",
			"Could not resolve client metadata",
		);
	}

	let jwks = metadata.jwks;
	if (!jwks && typeof metadata.jwks_uri === "string") {
		let jwksUrl: URL;
		try {
			jwksUrl = new URL(metadata.jwks_uri);
		} catch {
			jwksUrl = null as never;
		}
		if (!jwksUrl || jwksUrl.protocol !== "https:") {
			throw new SpaceError(
				"InvalidClientAttestation",
				"Client metadata jwks_uri must be an https URL",
			);
		}
		try {
			jwks = await boundedJson(metadata.jwks_uri);
		} catch {
			throw new SpaceError(
				"InvalidClientAttestation",
				"Could not resolve client JWKS",
			);
		}
	}
	if (!jwks) {
		throw new SpaceError(
			"InvalidClientAttestation",
			"Client metadata declares no JWKS",
		);
	}

	try {
		const keySet = createLocalJWKSet(
			jwks as Parameters<typeof createLocalJWKSet>[0],
		);
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
