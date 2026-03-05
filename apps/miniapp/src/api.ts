/**
 * PDS API client for the mini app.
 *
 * All API calls target the user's subdomain (https://NNN.fid.is), never the bare domain.
 * Pre-auth functions take a `fid` parameter to construct the URL.
 * Post-auth functions take a `pdsBase` parameter (e.g. `https://12345.fid.is`).
 */

const DOMAIN = import.meta.env.VITE_PDS_DOMAIN || "fid.is";

function pdsUrl(fid: string): string {
	return `https://pds-${fid}.${DOMAIN}`;
}

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

/** Error thrown when the server returns a 404 (account not found). */
export class AccountNotFoundError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AccountNotFoundError";
	}
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
	fid: string,
	farcasterToken: string,
	handle?: string,
): Promise<SessionResponse> {
	const response = await fetch(`${pdsUrl(fid)}/xrpc/is.fid.account.create`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ farcasterToken, ...(handle ? { handle } : {}) }),
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
export async function login(fid: string, farcasterToken: string): Promise<SessionResponse> {
	const response = await fetch(`${pdsUrl(fid)}/xrpc/is.fid.auth.login`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ farcasterToken }),
	});

	const data = await response.json();

	if (!response.ok) {
		const msg = (data as ErrorResponse).message || "Failed to login";
		if (response.status === 404) throw new AccountNotFoundError(msg);
		throw new Error(msg);
	}

	return data as SessionResponse;
}

// ============================================
// Account Status (lightweight, always 200)
// ============================================

export interface AccountStatus {
	exists: boolean;
	allowed: boolean;
	waitlisted: boolean;
}

/**
 * Check account status for the given FID.
 * Returns existence, allowlist, and waitlist state.
 */
export async function getAccountStatus(
	fid: string,
): Promise<AccountStatus> {
	try {
		const response = await fetch(
			`${pdsUrl(fid)}/xrpc/is.fid.account.status?fid=${fid}`,
			{ signal: AbortSignal.timeout(5000) },
		);
		if (!response.ok) return { exists: false, allowed: true, waitlisted: false };
		const data = (await response.json()) as AccountStatus;
		return data;
	} catch {
		return { exists: false, allowed: true, waitlisted: false };
	}
}

/**
 * Join the waitlist for account creation.
 */
export async function joinWaitlistApi(
	fid: string,
	auth: { farcasterToken: string } | SiwfCredentials,
): Promise<{ alreadyWaitlisted: boolean }> {
	const response = await fetch(`${pdsUrl(fid)}/xrpc/is.fid.waitlist.join`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(auth),
	});

	const data = await response.json();

	if (!response.ok) {
		throw new Error(
			(data as ErrorResponse).message || "Failed to join waitlist",
		);
	}

	return data as { alreadyWaitlisted: boolean };
}

// ============================================
// Farcaster Profile (client-side Hub API fetch)
// ============================================

const HUB_API_BASE = "https://haatz.quilibrium.com/v1";

export interface FarcasterProfile {
	displayName?: string;
	bio?: string;
	pfpUrl?: string;
	url?: string;
	ethAddress?: string;
	/** Farcaster name from fname registry (e.g. "boscolo") */
	fname?: string;
	/** Username from Hub (may be ENS name like "boscolo.eth") */
	username?: string;
}

/**
 * Fetch a user's Farcaster profile from the Hub API and FNAME registry.
 */
export async function fetchFarcasterProfile(
	fid: string,
): Promise<FarcasterProfile> {
	const result: FarcasterProfile = {};

	// Fetch Hub data and FNAME in parallel
	await Promise.all([
		// Hub API (profile data)
		fetch(`${HUB_API_BASE}/userDataByFid?fid=${fid}`, {
			signal: AbortSignal.timeout(5000),
		})
			.then(async (response) => {
				if (!response.ok) return;
				const data = (await response.json()) as {
					messages: Array<{
						data: {
							userDataBody: { type: string; value: string };
						};
					}>;
				};
				for (const msg of data.messages ?? []) {
					const { type, value } = msg.data.userDataBody;
					switch (type) {
						case "USER_DATA_TYPE_DISPLAY":
							result.displayName = value;
							break;
						case "USER_DATA_TYPE_BIO":
							result.bio = value;
							break;
						case "USER_DATA_TYPE_PFP":
							result.pfpUrl = value;
							break;
						case "USER_DATA_TYPE_USERNAME":
							result.username = value;
							break;
						case "USER_DATA_TYPE_URL":
							result.url = value;
							break;
						case "USER_DATA_TYPE_PRIMARY_ADDRESS_ETHEREUM":
							result.ethAddress = value;
							break;
					}
				}
			})
			.catch(() => {}),

		// FNAME registry
		fetch(`https://fnames.farcaster.xyz/transfers?fid=${fid}`, {
			signal: AbortSignal.timeout(5000),
		})
			.then(async (response) => {
				if (!response.ok) return;
				const data = (await response.json()) as {
					transfers: Array<{ username: string }>;
				};
				const latest = data.transfers?.[data.transfers.length - 1];
				if (latest?.username) {
					result.fname = latest.username;
				}
			})
			.catch(() => {}),

	]);

	return result;
}

/**
 * Populate the user's Bluesky profile from Farcaster data.
 * Downloads avatar, uploads as blob, then writes app.bsky.actor.profile.
 * Best-effort — silently ignores errors.
 */
export async function populateProfile(
	accessToken: string,
	pdsBase: string,
	did: string,
	profile: FarcasterProfile,
): Promise<void> {
	try {
		const { displayName, bio, pfpUrl } = profile;
		if (!displayName && !bio && !pfpUrl) return;

		const record: Record<string, unknown> = {
			$type: "app.bsky.actor.profile",
		};

		if (displayName) {
			record.displayName = displayName.slice(0, 64);
		}
		if (bio) {
			record.description = bio.slice(0, 256);
		}

		// Download and upload avatar
		if (pfpUrl) {
			try {
				const imgResponse = await fetch(pfpUrl, {
					signal: AbortSignal.timeout(10000),
				});
				if (imgResponse.ok) {
					const bytes = new Uint8Array(await imgResponse.arrayBuffer());
					if (bytes.length <= 1_000_000) {
						const mimeType = detectImageMime(bytes);
						if (mimeType) {
							const blobRef = await uploadBlob(
								accessToken,
								pdsBase,
								bytes,
								mimeType,
							);
							record.avatar = blobRef;
						}
					}
				}
			} catch {
				// Avatar upload failed — continue without it
			}
		}

		// Write the profile record
		await fetch(`${pdsBase}/xrpc/com.atproto.repo.putRecord`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${accessToken}`,
			},
			body: JSON.stringify({
				repo: did,
				collection: "app.bsky.actor.profile",
				rkey: "self",
				record,
			}),
		});
	} catch {
		// Best-effort — don't fail account creation
	}
}

/**
 * Upload a blob to the PDS.
 */
async function uploadBlob(
	accessToken: string,
	pdsBase: string,
	bytes: Uint8Array,
	mimeType: string,
): Promise<unknown> {
	const response = await fetch(`${pdsBase}/xrpc/com.atproto.repo.uploadBlob`, {
		method: "POST",
		headers: {
			"Content-Type": mimeType,
			Authorization: `Bearer ${accessToken}`,
		},
		body: bytes.buffer as ArrayBuffer,
	});

	if (!response.ok) {
		throw new Error("Failed to upload blob");
	}

	const data = (await response.json()) as { blob: unknown };
	return data.blob;
}

/**
 * Detect image MIME type from magic bytes.
 */
function detectImageMime(bytes: Uint8Array): string | null {
	if (bytes.length < 4) return null;
	if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
		return "image/jpeg";
	if (
		bytes[0] === 0x89 &&
		bytes[1] === 0x50 &&
		bytes[2] === 0x4e &&
		bytes[3] === 0x47
	)
		return "image/png";
	if (
		bytes.length >= 12 &&
		bytes[0] === 0x52 &&
		bytes[1] === 0x49 &&
		bytes[2] === 0x46 &&
		bytes[3] === 0x46 &&
		bytes[8] === 0x57 &&
		bytes[9] === 0x45 &&
		bytes[10] === 0x42 &&
		bytes[11] === 0x50
	)
		return "image/webp";
	return null;
}

export interface SiwfCredentials {
	message: string;
	signature: string;
	fid: string;
	nonce: string;
}

/**
 * Login with Sign In With Farcaster (SIWF) — login only.
 * Throws AccountNotFoundError on 404 (not found) or 410 (deleted).
 */
export async function loginWithSiwf(
	fid: string,
	credentials: SiwfCredentials,
): Promise<SessionResponse> {
	console.log("[siwf] login attempt", { fid: credentials.fid });
	const response = await fetch(`${pdsUrl(fid)}/xrpc/is.fid.auth.siwf`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(credentials),
	});

	const data = await response.json();

	if (!response.ok) {
		console.error("[siwf] login failed", {
			status: response.status,
			data,
		});
		const msg =
			(data as ErrorResponse).message || "SIWF authentication failed";
		if (response.status === 404) throw new AccountNotFoundError(msg);
		throw new Error(msg);
	}

	return data as SessionResponse;
}

/**
 * Create a new account using SIWF credentials.
 */
export async function createAccountSiwf(
	fid: string,
	credentials: SiwfCredentials,
	handle?: string,
): Promise<SessionResponse> {
	const response = await fetch(
		`${pdsUrl(fid)}/xrpc/is.fid.account.createSiwf`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ ...credentials, ...(handle ? { handle } : {}) }),
		},
	);

	const data = await response.json();

	if (!response.ok) {
		throw new Error(
			(data as ErrorResponse).message || "Failed to create account",
		);
	}

	return data as SessionResponse;
}

/**
 * Get a challenge for passkey authentication.
 */
export async function getPasskeyChallenge(fid: string): Promise<{
	challenge: string;
	rpId: string;
}> {
	const response = await fetch(
		`${pdsUrl(fid)}/xrpc/is.fid.auth.passkeyChallenge`,
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
	fid: string,
	assertion: PasskeyAssertion,
): Promise<SessionResponse> {
	const response = await fetch(`${pdsUrl(fid)}/xrpc/is.fid.auth.passkeyLogin`, {
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
 * Returns WebAuthn PublicKeyCredentialCreationOptions and a token for verification.
 */
export async function getPasskeyRegistrationOptions(
	accessToken: string,
	pdsBase: string,
): Promise<{
	options: any;
	token: string;
}> {
	const response = await fetch(
		`${pdsBase}/xrpc/is.fid.passkey.registrationOptions`,
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
		options: any;
		token: string;
	};
}

/**
 * Complete passkey registration.
 * Sends the WebAuthn response and token for server verification.
 */
export async function registerPasskey(
	accessToken: string,
	pdsBase: string,
	token: string,
	response: unknown,
	name?: string,
): Promise<{ success: boolean }> {
	const res = await fetch(`${pdsBase}/xrpc/is.fid.passkey.register`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${accessToken}`,
		},
		body: JSON.stringify({ token, response, name }),
	});

	const data = await res.json();

	if (!res.ok) {
		throw new Error(
			(data as ErrorResponse).message || "Failed to register passkey",
		);
	}

	return data as { success: boolean };
}

export interface PasskeyInfo {
	id: string;
	name: string | null;
	createdAt: string;
	lastUsedAt: string | null;
}

/**
 * List registered passkeys for the authenticated user.
 */
export async function listPasskeys(
	accessToken: string,
	pdsBase: string,
): Promise<PasskeyInfo[]> {
	const response = await fetch(`${pdsBase}/xrpc/is.fid.passkey.list`, {
		method: "GET",
		headers: {
			Authorization: `Bearer ${accessToken}`,
		},
	});

	const data = await response.json();

	if (!response.ok) {
		throw new Error(
			(data as ErrorResponse).message || "Failed to list passkeys",
		);
	}

	return (data as { passkeys: PasskeyInfo[] }).passkeys;
}

/**
 * Delete a passkey by credential ID.
 */
export async function deletePasskeyApi(
	accessToken: string,
	pdsBase: string,
	credentialId: string,
): Promise<void> {
	const response = await fetch(`${pdsBase}/xrpc/is.fid.passkey.delete`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${accessToken}`,
		},
		body: JSON.stringify({ credentialId }),
	});

	if (!response.ok) {
		const data = await response.json().catch(() => ({}));
		throw new Error(
			(data as ErrorResponse).message || "Failed to delete passkey",
		);
	}
}

/**
 * Rename a passkey.
 */
export async function renamePasskeyApi(
	accessToken: string,
	pdsBase: string,
	credentialId: string,
	name: string,
): Promise<void> {
	const response = await fetch(`${pdsBase}/xrpc/is.fid.passkey.rename`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${accessToken}`,
		},
		body: JSON.stringify({ credentialId, name }),
	});

	if (!response.ok) {
		const data = await response.json().catch(() => ({}));
		throw new Error(
			(data as ErrorResponse).message || "Failed to rename passkey",
		);
	}
}

// ============================================
// Relay Sync
// ============================================

const RELAY_URLS = [
	"https://relay1.us-west.bsky.network",
	"https://relay1.us-east.bsky.network",
];

/**
 * Query relays for the last-known seq for a PDS hostname.
 * Queries both relay URLs, returns the max seq found.
 * Best-effort — returns null on failure.
 */
export async function getRelaySeq(
	pdsHostname: string,
): Promise<number | null> {
	const results = await Promise.allSettled(
		RELAY_URLS.map(async (relayUrl) => {
			const response = await fetch(
				`${relayUrl}/xrpc/com.atproto.sync.getHostStatus?hostname=${encodeURIComponent(pdsHostname)}`,
				{ signal: AbortSignal.timeout(5000) },
			);
			if (!response.ok) return null;
			const data = (await response.json()) as { seq?: number };
			return data.seq ?? null;
		}),
	);

	let maxSeq: number | null = null;
	for (const result of results) {
		if (result.status === "fulfilled" && result.value != null) {
			if (maxSeq == null || result.value > maxSeq) {
				maxSeq = result.value;
			}
		}
	}
	return maxSeq;
}

/**
 * Tell the PDS to advance its seq floor and re-emit identity/account events.
 */
export async function syncRelaySeq(
	accessToken: string,
	pdsBase: string,
	seq: number,
): Promise<void> {
	const response = await fetch(
		`${pdsBase}/xrpc/is.fid.account.syncRelaySeq`,
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${accessToken}`,
			},
			body: JSON.stringify({ seq }),
		},
	);

	if (!response.ok) {
		const data = await response.json().catch(() => ({}));
		throw new Error(
			(data as ErrorResponse).message || "Failed to sync relay seq",
		);
	}
}

/**
 * Emit an #account event to the firehose.
 * Debug tool — prods relays to update their cached account status.
 */
export async function emitAccountEvent(accessToken: string, pdsBase: string): Promise<void> {
	const response = await fetch(
		`${pdsBase}/xrpc/gg.mk.experimental.emitAccountEvent`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${accessToken}`,
			},
		},
	);

	if (!response.ok) {
		const data = await response.json().catch(() => ({}));
		throw new Error(
			(data as ErrorResponse).message || "Failed to emit account event",
		);
	}
}

/**
 * Set the repo status flag (active, deactivated, deleted).
 * Debug tool — does NOT delete data, only sets the status.
 */
export async function setRepoStatus(
	accessToken: string,
	pdsBase: string,
	status: string,
): Promise<void> {
	const response = await fetch(
		`${pdsBase}/xrpc/gg.mk.experimental.setRepoStatus`,
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${accessToken}`,
			},
			body: JSON.stringify({ status }),
		},
	);

	if (!response.ok) {
		const data = await response.json().catch(() => ({}));
		throw new Error(
			(data as ErrorResponse).message || "Failed to set repo status",
		);
	}
}

// ============================================
// Relay Crawl
// ============================================

const RELAY_CRAWL_URLS = [
	"https://bsky.network",
	"https://relay1.us-west.bsky.network",
	"https://relay1.us-east.bsky.network",
];

/**
 * Notify relays to crawl the PDS.
 * Best-effort — silently ignores errors.
 */
export async function requestCrawl(pdsHostname: string): Promise<void> {
	await Promise.allSettled(
		RELAY_CRAWL_URLS.map((relayUrl) =>
			fetch(`${relayUrl}/xrpc/com.atproto.sync.requestCrawl`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ hostname: pdsHostname }),
				signal: AbortSignal.timeout(5000),
			}),
		),
	);
}

// ============================================
// Debug Info
// ============================================

export type DebugField = { data: unknown } | { error: string };

export interface DebugInfo {
	didDocument: DebugField;
	atprotoDid: DebugField;
	describeServer: DebugField;
	repoStatus: DebugField;
	listRepos: DebugField;
	describeRepo: DebugField;
	profileRecord: DebugField;
	health: DebugField;
	firehoseStatus: DebugField;
}

/**
 * Fetch all diagnostic info from a PDS in parallel.
 * Each field is fetched independently so failures don't block others.
 */
export async function fetchDebugInfo(
	accessToken: string,
	did: string,
	pdsBase: string,
): Promise<DebugInfo> {
	const empty = (): DebugInfo => ({
		didDocument: { error: "not fetched" },
		atprotoDid: { error: "not fetched" },
		describeServer: { error: "not fetched" },
		repoStatus: { error: "not fetched" },
		listRepos: { error: "not fetched" },
		describeRepo: { error: "not fetched" },
		profileRecord: { error: "not fetched" },
		health: { error: "not fetched" },
		firehoseStatus: { error: "not fetched" },
	});

	const result = empty();

	// Per-account endpoints need the PDS subdomain (e.g. https://pds-12345.fid.is)

	const fetchJson = async (url: string, auth?: string) => {
		const headers: Record<string, string> = {};
		if (auth) headers["Authorization"] = `Bearer ${auth}`;
		const res = await fetch(url, {
			headers,
			signal: AbortSignal.timeout(10000),
		});
		if (!res.ok) {
			const body = await res.text().catch(() => "");
			throw new Error(`${res.status} ${res.statusText}${body ? `: ${body}` : ""}`);
		}
		return res.json();
	};

	const fetchText = async (url: string) => {
		const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
		if (!res.ok) {
			const body = await res.text().catch(() => "");
			throw new Error(`${res.status} ${res.statusText}${body ? `: ${body}` : ""}`);
		}
		return res.text();
	};

	const wrap = (key: keyof DebugInfo, p: Promise<unknown>) =>
		p
			.then((v) => { result[key] = { data: v }; })
			.catch((e) => { result[key] = { error: e instanceof Error ? e.message : String(e) }; });

	await Promise.allSettled([
		wrap("didDocument", fetchJson(`${pdsBase}/.well-known/did.json`)),
		wrap("atprotoDid", fetchText(`${pdsBase}/.well-known/atproto-did`)),
		wrap("describeServer", fetchJson(`${pdsBase}/xrpc/com.atproto.server.describeServer`)),
		wrap("repoStatus", fetchJson(`${pdsBase}/xrpc/com.atproto.sync.getRepoStatus?did=${encodeURIComponent(did)}`)),
		wrap("listRepos", fetchJson(`${pdsBase}/xrpc/com.atproto.sync.listRepos?limit=10`)),
		wrap("describeRepo", fetchJson(`${pdsBase}/xrpc/com.atproto.repo.describeRepo?repo=${encodeURIComponent(did)}`)),
		wrap("profileRecord", fetchJson(`${pdsBase}/xrpc/com.atproto.repo.getRecord?repo=${encodeURIComponent(did)}&collection=app.bsky.actor.profile&rkey=self`)),
		wrap("health", fetchJson(`${pdsBase}/xrpc/_health`)),
		wrap("firehoseStatus", fetchJson(`${pdsBase}/xrpc/gg.mk.experimental.getFirehoseStatus`, accessToken)),
	]);

	return result;
}

/**
 * Activate the authenticated user's account.
 */
export async function activateAccount(accessToken: string, pdsBase: string): Promise<void> {
	const response = await fetch(
		`${pdsBase}/xrpc/com.atproto.server.activateAccount`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${accessToken}`,
			},
		},
	);

	if (!response.ok) {
		const data = await response.json().catch(() => ({}));
		throw new Error(
			(data as ErrorResponse).message || "Failed to activate account",
		);
	}
}

/**
 * Deactivate the authenticated user's account.
 */
export async function deactivateAccount(accessToken: string, pdsBase: string): Promise<void> {
	const response = await fetch(
		`${pdsBase}/xrpc/com.atproto.server.deactivateAccount`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${accessToken}`,
			},
		},
	);

	if (!response.ok) {
		const data = await response.json().catch(() => ({}));
		throw new Error(
			(data as ErrorResponse).message || "Failed to deactivate account",
		);
	}
}

/**
 * Emit an identity event to notify relays/AppView to refresh DID document cache.
 */
export async function emitIdentityEvent(accessToken: string, pdsBase: string): Promise<void> {
	const response = await fetch(
		`${pdsBase}/xrpc/gg.mk.experimental.emitIdentityEvent`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${accessToken}`,
			},
		},
	);

	if (!response.ok) {
		const data = await response.json().catch(() => ({}));
		throw new Error(
			(data as ErrorResponse).message || "Failed to emit identity event",
		);
	}
}

// ============================================
// Account Deletion
// ============================================

/**
 * Delete the authenticated user's account.
 * This permanently removes the AT Protocol identity, repository, and all blobs.
 */
export async function deleteAccount(accessToken: string, pdsBase: string): Promise<void> {
	const response = await fetch(`${pdsBase}/xrpc/is.fid.account.delete`, {
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

// ============================================
// Handle API
// ============================================

/**
 * Verify that an FNAME is owned by the expected FID via the Farcaster FNAME registry.
 * Call this client-side before setting a handle to give the user immediate feedback.
 */
export async function verifyFnameOwnership(fname: string, expectedFid: string): Promise<boolean> {
	try {
		const res = await fetch(
			`https://fnames.farcaster.xyz/transfers/current?name=${encodeURIComponent(fname)}`,
			{ signal: AbortSignal.timeout(5000) },
		);
		if (!res.ok) return false;
		const data = (await res.json()) as { transfer?: { to: number } };
		return data.transfer?.to?.toString() === expectedFid;
	} catch {
		return false;
	}
}

export interface HandleConfig {
	handle: string;
}

/**
 * Get the current handle.
 */
export async function getHandle(accessToken: string, pdsBase: string): Promise<HandleConfig> {
	const response = await fetch(`${pdsBase}/xrpc/is.fid.settings.getHandle`, {
		method: "GET",
		headers: {
			Authorization: `Bearer ${accessToken}`,
		},
	});

	const data = await response.json();

	if (!response.ok) {
		throw new Error(
			(data as ErrorResponse).message || "Failed to get handle",
		);
	}

	return data as HandleConfig;
}

/**
 * Set the handle or reset to default.
 * @param handle - Handle string (e.g. "alice.farcaster.social") or null to reset to FID default
 */
export async function setHandle(
	accessToken: string,
	pdsBase: string,
	handle: string | null,
): Promise<{ success: boolean; handle: string }> {
	const response = await fetch(`${pdsBase}/xrpc/is.fid.settings.setHandle`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${accessToken}`,
		},
		body: JSON.stringify({ handle }),
	});

	const data = await response.json();

	if (!response.ok) {
		throw new Error(
			(data as ErrorResponse).message || "Failed to set handle",
		);
	}

	return data as { success: boolean; handle: string };
}

export interface PdsUrlConfig {
	pdsUrl: string;
	isCustom: boolean;
	defaultUrl: string;
	verificationKey: string | null;
	defaultVerificationKey: string;
}

/**
 * Get the current PDS URL configuration.
 */
export async function getPdsUrl(accessToken: string, pdsBase: string): Promise<PdsUrlConfig> {
	const response = await fetch(`${pdsBase}/xrpc/is.fid.settings.getPdsUrl`, {
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
 * @param verificationKey - Multibase public key for DID document, or null/undefined
 */
export async function setPdsUrl(
	accessToken: string,
	pdsBase: string,
	newPdsUrl: string | null,
	verificationKey?: string | null,
): Promise<PdsUrlConfig & { success: boolean }> {
	const body: { pdsUrl: string | null; verificationKey?: string | null } = { pdsUrl: newPdsUrl };
	if (verificationKey !== undefined) {
		body.verificationKey = verificationKey;
	}

	const response = await fetch(`${pdsBase}/xrpc/is.fid.settings.setPdsUrl`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${accessToken}`,
		},
		body: JSON.stringify(body),
	});

	const data = await response.json();

	if (!response.ok) {
		throw new Error(
			(data as ErrorResponse).message || "Failed to set PDS URL",
		);
	}

	return data as PdsUrlConfig & { success: boolean };
}
