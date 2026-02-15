/**
 * PDS API client for the mini app.
 */

const API_BASE = import.meta.env.VITE_PDS_URL || "https://fid.is";

export interface SessionResponse {
	accessJwt: string;
	refreshJwt: string;
	handle: string;
	did: string;
	active: boolean;
}

export interface ErrorResponse {
	error: string;
	message: string;
}

export interface PasskeyAssertion {
	credentialId: string;
	authenticatorData: string;
	clientDataJSON: string;
	signature: string;
}

/**
 * Create a new account using a Farcaster Quick Auth token.
 */
export async function createAccount(
	farcasterToken: string,
): Promise<SessionResponse> {
	const response = await fetch(`${API_BASE}/xrpc/is.fid.account.create`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ farcasterToken }),
	});

	const data = await response.json();

	if (!response.ok) {
		throw new Error(
			(data as ErrorResponse).message || "Failed to create account",
		);
	}

	return data as SessionResponse;
}

/**
 * Login with a Farcaster Quick Auth token.
 */
export async function login(farcasterToken: string): Promise<SessionResponse> {
	const response = await fetch(`${API_BASE}/xrpc/is.fid.auth.login`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ farcasterToken }),
	});

	const data = await response.json();

	if (!response.ok) {
		throw new Error((data as ErrorResponse).message || "Failed to login");
	}

	return data as SessionResponse;
}

/**
 * Try to login, or create account if it doesn't exist.
 */
export async function loginOrCreate(
	farcasterToken: string,
): Promise<SessionResponse & { isNew: boolean }> {
	try {
		const session = await login(farcasterToken);
		return { ...session, isNew: false };
	} catch (err) {
		// If account doesn't exist, create it
		if (err instanceof Error && err.message.includes("No account found")) {
			const session = await createAccount(farcasterToken);
			return { ...session, isNew: true };
		}
		throw err;
	}
}

export interface SiwfCredentials {
	message: string;
	signature: string;
	fid: string;
	nonce: string;
}

/**
 * Login or create account using Sign In With Farcaster (SIWF).
 * This is used in browser mode where Quick Auth isn't available.
 */
export async function loginWithSiwf(
	credentials: SiwfCredentials,
): Promise<SessionResponse & { isNew: boolean }> {
	const response = await fetch(`${API_BASE}/xrpc/is.fid.auth.siwf`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(credentials),
	});

	const data = await response.json();

	if (!response.ok) {
		throw new Error(
			(data as ErrorResponse).message || "SIWF authentication failed",
		);
	}

	return data as SessionResponse & { isNew: boolean };
}

/**
 * Get a challenge for passkey authentication.
 */
export async function getPasskeyChallenge(): Promise<{
	challenge: string;
	rpId: string;
}> {
	const response = await fetch(
		`${API_BASE}/xrpc/is.fid.auth.passkeyChallenge`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
		},
	);

	const data = await response.json();

	if (!response.ok) {
		throw new Error(
			(data as ErrorResponse).message || "Failed to get challenge",
		);
	}

	return data as { challenge: string; rpId: string };
}

/**
 * Login with a passkey.
 */
export async function loginWithPasskey(
	assertion: PasskeyAssertion,
): Promise<SessionResponse> {
	const response = await fetch(`${API_BASE}/xrpc/is.fid.auth.passkeyLogin`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(assertion),
	});

	const data = await response.json();

	if (!response.ok) {
		throw new Error(
			(data as ErrorResponse).message || "Passkey authentication failed",
		);
	}

	return data as SessionResponse;
}

/**
 * Get passkey registration options for adding a new passkey.
 */
export async function getPasskeyRegistrationOptions(
	accessToken: string,
): Promise<{
	challenge: string;
	rpId: string;
	rpName: string;
	userId: string;
	userName: string;
}> {
	const response = await fetch(
		`${API_BASE}/xrpc/is.fid.passkey.registrationOptions`,
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${accessToken}`,
			},
		},
	);

	const data = await response.json();

	if (!response.ok) {
		throw new Error(
			(data as ErrorResponse).message || "Failed to get registration options",
		);
	}

	return data as {
		challenge: string;
		rpId: string;
		rpName: string;
		userId: string;
		userName: string;
	};
}

/**
 * Register a new passkey.
 */
export async function registerPasskey(
	accessToken: string,
	credential: {
		credentialId: string;
		publicKey: string;
		attestationObject: string;
		clientDataJSON: string;
	},
): Promise<{ success: boolean }> {
	const response = await fetch(`${API_BASE}/xrpc/is.fid.passkey.register`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${accessToken}`,
		},
		body: JSON.stringify(credential),
	});

	const data = await response.json();

	if (!response.ok) {
		throw new Error(
			(data as ErrorResponse).message || "Failed to register passkey",
		);
	}

	return data as { success: boolean };
}

// ============================================
// Account Deletion
// ============================================

/**
 * Delete the authenticated user's account.
 * This permanently removes the AT Protocol identity, repository, and all blobs.
 */
export async function deleteAccount(accessToken: string): Promise<void> {
	const response = await fetch(`${API_BASE}/xrpc/is.fid.account.delete`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${accessToken}`,
		},
	});

	if (!response.ok) {
		const data = await response.json().catch(() => ({}));
		throw new Error(
			(data as ErrorResponse).message || "Failed to delete account",
		);
	}
}

// ============================================
// Settings API
// ============================================

export interface PdsUrlConfig {
	pdsUrl: string;
	isCustom: boolean;
	defaultUrl: string;
}

/**
 * Get the current PDS URL configuration.
 */
export async function getPdsUrl(accessToken: string): Promise<PdsUrlConfig> {
	const response = await fetch(`${API_BASE}/xrpc/is.fid.settings.getPdsUrl`, {
		method: "GET",
		headers: {
			Authorization: `Bearer ${accessToken}`,
		},
	});

	const data = await response.json();

	if (!response.ok) {
		throw new Error(
			(data as ErrorResponse).message || "Failed to get PDS URL",
		);
	}

	return data as PdsUrlConfig;
}

/**
 * Set a custom PDS URL or reset to default.
 * @param accessToken - The access token for authentication
 * @param pdsUrl - HTTPS URL of custom PDS, or null to reset to default
 */
export async function setPdsUrl(
	accessToken: string,
	pdsUrl: string | null,
): Promise<PdsUrlConfig & { success: boolean }> {
	const response = await fetch(`${API_BASE}/xrpc/is.fid.settings.setPdsUrl`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${accessToken}`,
		},
		body: JSON.stringify({ pdsUrl }),
	});

	const data = await response.json();

	if (!response.ok) {
		throw new Error(
			(data as ErrorResponse).message || "Failed to set PDS URL",
		);
	}

	return data as PdsUrlConfig & { success: boolean };
}
