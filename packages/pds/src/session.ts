import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import { compare } from "bcryptjs";
import { Secp256k1Keypair, verifySignature } from "@atproto/crypto";

const ACCESS_TOKEN_LIFETIME = "2h";
const REFRESH_TOKEN_LIFETIME = "90d";

/**
 * Create a secret key from string for HS256 signing
 */
function createSecretKey(secret: string): Uint8Array {
	return new TextEncoder().encode(secret);
}

/**
 * Create an access token (short-lived, 2 hours)
 */
export async function createAccessToken(
	jwtSecret: string,
	userDid: string,
	serviceDid: string,
): Promise<string> {
	const secret = createSecretKey(jwtSecret);

	return new SignJWT({ scope: "atproto" })
		.setProtectedHeader({ alg: "HS256", typ: "at+jwt" })
		.setIssuedAt()
		.setIssuer(serviceDid)
		.setAudience(serviceDid)
		.setSubject(userDid)
		.setExpirationTime(ACCESS_TOKEN_LIFETIME)
		.sign(secret);
}

/**
 * Create a refresh token (long-lived, 90 days)
 */
export async function createRefreshToken(
	jwtSecret: string,
	userDid: string,
	serviceDid: string,
): Promise<string> {
	const secret = createSecretKey(jwtSecret);
	const jti = crypto.randomUUID();

	return new SignJWT({ scope: "com.atproto.refresh", jti })
		.setProtectedHeader({ alg: "HS256", typ: "refresh+jwt" })
		.setIssuedAt()
		.setIssuer(serviceDid)
		.setAudience(serviceDid)
		.setSubject(userDid)
		.setExpirationTime(REFRESH_TOKEN_LIFETIME)
		.sign(secret);
}

/**
 * Verify an access token and return the payload
 */
export async function verifyAccessToken(
	token: string,
	jwtSecret: string,
	serviceDid: string,
): Promise<JWTPayload> {
	const secret = createSecretKey(jwtSecret);

	const { payload, protectedHeader } = await jwtVerify(token, secret, {
		issuer: serviceDid,
		audience: serviceDid,
	});

	// Check token type
	if (protectedHeader.typ !== "at+jwt") {
		throw new Error("Invalid token type");
	}

	// Check scope
	if (payload.scope !== "atproto") {
		throw new Error("Invalid scope");
	}

	return payload;
}

/**
 * Verify a refresh token and return the payload
 */
export async function verifyRefreshToken(
	token: string,
	jwtSecret: string,
	serviceDid: string,
): Promise<JWTPayload> {
	const secret = createSecretKey(jwtSecret);

	const { payload, protectedHeader } = await jwtVerify(token, secret, {
		issuer: serviceDid,
		audience: serviceDid,
	});

	// Check token type
	if (protectedHeader.typ !== "refresh+jwt") {
		throw new Error("Invalid token type");
	}

	// Check scope
	if (payload.scope !== "com.atproto.refresh") {
		throw new Error("Invalid scope");
	}

	// Require token ID
	if (!payload.jti) {
		throw new Error("Missing token ID");
	}

	return payload;
}

/**
 * Verify a password against a bcrypt hash
 */
export { compare as verifyPassword };

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

	const [headerB64, payloadB64, signatureB64] = parts;

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

	// Verify signature using our signing key
	// Import keypair fresh each time to avoid module-scope caching issues
	const keypair = await Secp256k1Keypair.import(signingKey);
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
