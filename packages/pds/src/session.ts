import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import { compare } from "bcryptjs";

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
