/**
 * Passkey (WebAuthn) support for Cirrus PDS
 *
 * Handles passkey registration and authentication using the @simplewebauthn/server library.
 * Uses a CLI-driven flow where:
 * 1. CLI generates a registration token
 * 2. User opens the URL on their device
 * 3. Device performs the WebAuthn ceremony
 * 4. Passkey is stored in the Durable Object
 */

import {
	generateRegistrationOptions,
	verifyRegistrationResponse,
	generateAuthenticationOptions,
	verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import type {
	AuthenticationResponseJSON,
	RegistrationResponseJSON,
} from "@simplewebauthn/server";
import type { AccountDurableObject } from "./account-do";

// Re-export for use by other modules (e.g., oauth.ts)
export type { AuthenticationResponseJSON, RegistrationResponseJSON };

/** Options for creating a new credential */
export interface PublicKeyCredentialCreationOptionsJSON {
	rp: { name: string; id?: string };
	user: { id: string; name: string; displayName: string };
	challenge: string;
	pubKeyCredParams: Array<{ alg: number; type: string }>;
	timeout?: number;
	attestation?: string;
	authenticatorSelection?: {
		authenticatorAttachment?: string;
		requireResidentKey?: boolean;
		residentKey?: string;
		userVerification?: string;
	};
	excludeCredentials?: Array<{
		id: string;
		type?: string;
		transports?: string[];
	}>;
}

/** Options for authenticating with an existing credential */
interface PublicKeyCredentialRequestOptionsJSON {
	challenge: string;
	timeout?: number;
	rpId?: string;
	allowCredentials?: Array<{
		id: string;
		type?: string;
		transports?: string[];
	}>;
	userVerification?: string;
}

/** Token TTL in milliseconds (10 minutes) */
const TOKEN_TTL_MS = 10 * 60 * 1000;

/**
 * Generate a secure random token
 */
function generateToken(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	// Use base64url encoding (URL-safe)
	return btoa(String.fromCharCode(...bytes))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=/g, "");
}

export interface PasskeyRegistrationInit {
	/** Token to include in the registration URL */
	token: string;
	/** Full URL for the user to visit */
	url: string;
	/** When this token expires */
	expiresAt: number;
}

export interface PasskeyInfo {
	/** Credential ID (base64url encoded) */
	id: string;
	/** User-provided name for this passkey */
	name: string | null;
	/** When the passkey was created */
	createdAt: string;
	/** When the passkey was last used */
	lastUsedAt: string | null;
}

/**
 * Initialize passkey registration
 *
 * Generates a registration token and challenge, stores them,
 * and returns the URL for the user to visit.
 */
export async function initPasskeyRegistration(
	accountDO: DurableObjectStub<AccountDurableObject>,
	pdsHostname: string,
	did: string,
	name?: string,
): Promise<PasskeyRegistrationInit> {
	const token = generateToken();
	const expiresAt = Date.now() + TOKEN_TTL_MS;

	// Generate WebAuthn registration options
	// We need to generate a challenge here so it's available when the user visits the URL
	const options = await generateRegistrationOptions({
		rpName: "Cirrus PDS",
		rpID: pdsHostname,
		userName: did,
		userDisplayName: name || did,
		// Require resident key (discoverable credential) for better UX
		authenticatorSelection: {
			residentKey: "required",
			userVerification: "preferred",
		},
		// Don't require attestation (simpler, more compatible)
		attestationType: "none",
	});

	// Store the challenge with the token (and name for later)
	await accountDO.rpcSavePasskeyToken(
		token,
		options.challenge,
		expiresAt,
		name,
	);

	const url = `https://${pdsHostname}/passkey/register?token=${token}`;

	return {
		token,
		url,
		expiresAt,
	};
}

/**
 * Get registration options for a token
 *
 * Called when the user visits the registration URL.
 * Returns the WebAuthn options needed to start the ceremony.
 */
export async function getRegistrationOptions(
	accountDO: DurableObjectStub<AccountDurableObject>,
	pdsHostname: string,
	did: string,
	token: string,
): Promise<PublicKeyCredentialCreationOptionsJSON | null> {
	// Look up the token to get the challenge (but don't consume yet)
	// We need to re-consume on verification
	const storage = await accountDO.rpcConsumePasskeyToken(token);
	if (!storage) {
		return null;
	}

	// Re-save the token so it can be consumed during verification
	// (tokens are single-use, so we need to save it again)
	await accountDO.rpcSavePasskeyToken(
		token,
		storage.challenge,
		Date.now() + TOKEN_TTL_MS,
		storage.name ?? undefined,
	);

	// Get existing passkeys to exclude them
	const existingPasskeys = await accountDO.rpcListPasskeys();

	// Generate fresh options with the stored challenge
	const options = await generateRegistrationOptions({
		rpName: "Cirrus PDS",
		rpID: pdsHostname,
		userName: did,
		userDisplayName: did,
		authenticatorSelection: {
			residentKey: "required",
			userVerification: "preferred",
		},
		attestationType: "none",
		excludeCredentials: existingPasskeys.map((pk) => ({
			id: pk.credentialId,
		})),
	});

	// Override the challenge with our stored one
	return {
		...options,
		challenge: storage.challenge,
	};
}

/**
 * Complete passkey registration
 *
 * Verifies the registration response and stores the new passkey.
 * The name comes from the token (set during initPasskeyRegistration).
 */
export async function completePasskeyRegistration(
	accountDO: DurableObjectStub<AccountDurableObject>,
	pdsHostname: string,
	token: string,
	response: RegistrationResponseJSON,
): Promise<{ success: true } | { success: false; error: string }> {
	// Consume the token to get the challenge and name
	const tokenData = await accountDO.rpcConsumePasskeyToken(token);
	if (!tokenData) {
		return { success: false, error: "Invalid or expired token" };
	}

	try {
		// Verify the registration response
		const verification = await verifyRegistrationResponse({
			response,
			expectedChallenge: tokenData.challenge,
			expectedOrigin: `https://${pdsHostname}`,
			expectedRPID: pdsHostname,
		});

		if (!verification.verified || !verification.registrationInfo) {
			return { success: false, error: "Verification failed" };
		}

		const { credential } = verification.registrationInfo;

		// Store the passkey (name comes from the token)
		await accountDO.rpcSavePasskey(
			credential.id,
			credential.publicKey,
			credential.counter,
			tokenData.name ?? undefined,
		);

		return { success: true };
	} catch (err) {
		console.error("Passkey registration error:", err);
		return {
			success: false,
			error: err instanceof Error ? err.message : "Registration failed",
		};
	}
}

/**
 * Generate authentication options for passkey login.
 * The challenge is stored server-side for later verification.
 */
export async function getAuthenticationOptions(
	accountDO: DurableObjectStub<AccountDurableObject>,
	pdsHostname: string,
): Promise<PublicKeyCredentialRequestOptionsJSON | null> {
	// Get all registered passkeys
	const passkeys = await accountDO.rpcListPasskeys();
	if (passkeys.length === 0) {
		return null;
	}

	// Explicitly list credential IDs - more compatible than discoverable credentials
	const options = await generateAuthenticationOptions({
		rpID: pdsHostname,
		userVerification: "preferred",
		allowCredentials: passkeys.map((pk) => ({
			id: pk.credentialId,
			// Allow any transport type for maximum compatibility
			transports: [
				"internal",
				"hybrid",
				"usb",
				"ble",
				"nfc",
			] as AuthenticatorTransport[],
		})),
	});

	// Store the challenge server-side for later verification
	await accountDO.rpcSaveWebAuthnChallenge(options.challenge);

	return options;
}

/**
 * Verify passkey authentication.
 * The challenge is validated against the server-stored value.
 */
export async function verifyPasskeyAuthentication(
	accountDO: DurableObjectStub<AccountDurableObject>,
	pdsHostname: string,
	response: AuthenticationResponseJSON,
	challenge: string,
): Promise<{ success: true } | { success: false; error: string }> {
	try {
		// Verify the challenge was generated by the server and consume it (single-use)
		const challengeValid =
			await accountDO.rpcConsumeWebAuthnChallenge(challenge);
		if (!challengeValid) {
			return { success: false, error: "Invalid or expired challenge" };
		}

		// Get the passkey from storage
		const passkey = await accountDO.rpcGetPasskey(response.id);
		if (!passkey) {
			return { success: false, error: "Unknown credential" };
		}

		// Verify the authentication response
		const verification = await verifyAuthenticationResponse({
			response,
			expectedChallenge: challenge,
			expectedOrigin: `https://${pdsHostname}`,
			expectedRPID: pdsHostname,
			credential: {
				id: passkey.credentialId,
				publicKey: new Uint8Array(passkey.publicKey),
				counter: passkey.counter,
			},
		});

		if (!verification.verified) {
			return { success: false, error: "Verification failed" };
		}

		// Update the counter
		await accountDO.rpcUpdatePasskeyCounter(
			response.id,
			verification.authenticationInfo.newCounter,
		);

		return { success: true };
	} catch (err) {
		console.error("Passkey authentication error:", err);
		return {
			success: false,
			error: err instanceof Error ? err.message : "Authentication failed",
		};
	}
}

/**
 * List all passkeys for the account
 */
export async function listPasskeys(
	accountDO: DurableObjectStub<AccountDurableObject>,
): Promise<PasskeyInfo[]> {
	const passkeys = await accountDO.rpcListPasskeys();
	return passkeys.map((pk) => ({
		id: pk.credentialId,
		name: pk.name,
		createdAt: pk.createdAt,
		lastUsedAt: pk.lastUsedAt,
	}));
}

/**
 * Delete a passkey
 */
export async function deletePasskey(
	accountDO: DurableObjectStub<AccountDurableObject>,
	credentialId: string,
): Promise<boolean> {
	return accountDO.rpcDeletePasskey(credentialId);
}
