import { Secp256k1Keypair, randomStr, verifySignature } from "@atproto/crypto";

const MINUTE = 60;

// Service JWTs for external services (like video.bsky.app) need longer expiry
// because video processing can take several minutes before the callback arrives.
const SERVICE_JWT_EXPIRY_SECONDS = 5 * MINUTE;

/**
 * Shared keypair cache for signing and verification.
 */
let cachedKeypair: Secp256k1Keypair | null = null;
let cachedSigningKey: string | null = null;

/**
 * Get the signing keypair, with caching.
 * Used for creating service JWTs and verifying them.
 */
export async function getSigningKeypair(
	signingKey: string,
): Promise<Secp256k1Keypair> {
	if (cachedKeypair && cachedSigningKey === signingKey) {
		return cachedKeypair;
	}
	cachedKeypair = await Secp256k1Keypair.import(signingKey);
	cachedSigningKey = signingKey;
	return cachedKeypair;
}

/**
 * Service JWT payload structure
 */
export interface ServiceJwtPayload {
	iss: string; // Issuer (user's DID)
	aud: string; // Audience (PDS DID)
	exp: number; // Expiration timestamp
	iat?: number; // Issued at timestamp
	lxm?: string; // Lexicon method (optional)
	jti?: string; // Token ID (optional)
}

type ServiceJwtParams = {
	iss: string;
	aud: string;
	lxm: string | null;
	keypair: Secp256k1Keypair;
};

function jsonToB64Url(json: Record<string, unknown>): string {
	return Buffer.from(JSON.stringify(json)).toString("base64url");
}

function noUndefinedVals<T extends Record<string, unknown>>(
	obj: T,
): Partial<T> {
	const result: Partial<T> = {};
	for (const [key, val] of Object.entries(obj)) {
		if (val !== undefined) {
			result[key as keyof T] = val as T[keyof T];
		}
	}
	return result;
}

/**
 * Create a service JWT for proxied requests to AppView.
 * The JWT asserts that the PDS vouches for the user identified by `iss`.
 */
export async function createServiceJwt(
	params: ServiceJwtParams,
): Promise<string> {
	const { iss, aud, keypair } = params;
	const iat = Math.floor(Date.now() / 1000);
	const exp = iat + SERVICE_JWT_EXPIRY_SECONDS;
	const lxm = params.lxm ?? undefined;
	const jti = randomStr(16, "hex");

	const header = {
		typ: "JWT",
		alg: keypair.jwtAlg,
	};

	const payload = noUndefinedVals({
		iat,
		iss,
		aud,
		exp,
		lxm,
		jti,
	});

	const toSignStr = `${jsonToB64Url(header)}.${jsonToB64Url(payload as Record<string, unknown>)}`;
	const toSign = Buffer.from(toSignStr, "utf8");
	const sig = Buffer.from(await keypair.sign(toSign));

	return `${toSignStr}.${sig.toString("base64url")}`;
}

/**
 * Verify a service JWT signed with our signing key.
 * These are issued by getServiceAuth and used by external services
 * (like video.bsky.app) to call back to our PDS.
 */
export async function verifyServiceJwt(
	token: string,
	signingKey: string,
	expectedAudience: string,
	expectedIssuer: string,
): Promise<ServiceJwtPayload> {
	const parts = token.split(".");
	if (parts.length !== 3) {
		throw new Error("Invalid JWT format");
	}

	const headerB64 = parts[0]!;
	const payloadB64 = parts[1]!;
	const signatureB64 = parts[2]!;

	// Decode header
	const header = JSON.parse(Buffer.from(headerB64, "base64url").toString());
	if (header.alg !== "ES256K") {
		throw new Error(`Unsupported algorithm: ${header.alg}`);
	}

	// Decode payload
	const payload: ServiceJwtPayload = JSON.parse(
		Buffer.from(payloadB64, "base64url").toString(),
	);

	// Check expiration
	const now = Math.floor(Date.now() / 1000);
	if (payload.exp && payload.exp < now) {
		throw new Error("Token expired");
	}

	// Check audience (should be our PDS)
	if (payload.aud !== expectedAudience) {
		throw new Error(`Invalid audience: expected ${expectedAudience}`);
	}

	// Check issuer (should be the user's DID)
	if (payload.iss !== expectedIssuer) {
		throw new Error(`Invalid issuer: expected ${expectedIssuer}`);
	}

	// Verify signature using shared keypair
	const keypair = await getSigningKeypair(signingKey);
	// Uint8Array wrapper is required - Buffer polyfill doesn't work with @atproto/crypto
	const msgBytes = new Uint8Array(
		Buffer.from(`${headerB64}.${payloadB64}`, "utf8"),
	);
	const sigBytes = new Uint8Array(Buffer.from(signatureB64, "base64url"));

	const isValid = await verifySignature(keypair.did(), msgBytes, sigBytes, {
		allowMalleableSig: true,
	});

	if (!isValid) {
		throw new Error("Invalid signature");
	}

	return payload;
}
