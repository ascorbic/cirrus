/**
 * HTTP client for AT Protocol PDS XRPC endpoints
 * Uses @atcute/client for type-safe XRPC calls
 */
import {
	Client,
	ClientResponseError,
	ok,
	type FetchHandler,
} from "@atcute/client";
import type { Did, Nsid, RecordKey } from "@atcute/lexicons";
import { AppBskyActorProfile } from "@atcute/bluesky";
import {
	type ComAtprotoRepoGetRecord,
	type ComAtprotoRepoPutRecord,
} from "@atcute/atproto";
// These imports augment @atcute/client with typed XRPC method signatures.
// Without them, the client's .get() and .post() methods lack type information.
import type {} from "@atcute/atproto";
import type {} from "@atcute/bluesky";

export interface Session {
	accessJwt: string;
	refreshJwt: string;
	handle: string;
	did: string;
}

export interface RepoDescription {
	did: string;
	handle: string;
	collections: string[];
}

export interface ProfileStats {
	postsCount: number;
	followsCount: number;
	followersCount: number;
}

export interface MigrationStatus {
	activated: boolean;
	active: boolean;
	validDid: boolean;
	repoCommit: string | null;
	repoRev: string | null;
	repoBlocks: number;
	indexedRecords: number;
	expectedBlobs: number;
	importedBlobs: number;
}

export interface ImportResult {
	did: string;
	rev: string;
	cid: string;
}

export interface MissingBlob {
	cid: string;
	recordUri: string;
}

export interface BlobPage {
	blobs: MissingBlob[];
	cursor?: string;
}

export interface BlobRef {
	$type: "blob";
	ref: { $link: string };
	mimeType: string;
	size: number;
}

export interface ResetResult {
	blocksDeleted: number;
	blobsCleared: number;
}

/**
 * Create a fetch handler that adds optional auth token
 */
function createAuthHandler(baseUrl: string, token?: string): FetchHandler {
	return async (pathname, init) => {
		const url = new URL(pathname, baseUrl);
		const headers = new Headers(init.headers);
		if (token) {
			headers.set("Authorization", `Bearer ${token}`);
		}
		return fetch(url, { ...init, headers });
	};
}

export class PDSClient {
	private client: Client;
	private authToken?: string;

	constructor(
		private baseUrl: string,
		authToken?: string,
	) {
		this.authToken = authToken;
		this.client = new Client({
			handler: createAuthHandler(baseUrl, authToken),
		});
	}

	/**
	 * Set the auth token for subsequent requests
	 */
	setAuthToken(token: string): void {
		this.authToken = token;
		this.client = new Client({
			handler: createAuthHandler(this.baseUrl, token),
		});
	}

	// ============================================
	// Authentication
	// ============================================

	/**
	 * Create a session with identifier and password
	 */
	async createSession(identifier: string, password: string): Promise<Session> {
		return ok(
			this.client.post("com.atproto.server.createSession", {
				input: { identifier, password },
			}),
		);
	}

	// ============================================
	// Discovery
	// ============================================

	/**
	 * Get repository description including collections
	 */
	async describeRepo(did: string): Promise<RepoDescription> {
		return ok(
			this.client.get("com.atproto.repo.describeRepo", {
				params: { repo: did as Did },
			}),
		);
	}

	/**
	 * Get profile stats from AppView (posts, follows, followers counts)
	 */
	async getProfileStats(did: string): Promise<ProfileStats | null> {
		try {
			const res = await fetch(
				`https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(did)}`,
			);
			if (!res.ok) return null;
			const profile = (await res.json()) as {
				postsCount?: number;
				followsCount?: number;
				followersCount?: number;
			};
			return {
				postsCount: profile.postsCount ?? 0,
				followsCount: profile.followsCount ?? 0,
				followersCount: profile.followersCount ?? 0,
			};
		} catch {
			return null;
		}
	}

	// ============================================
	// Export Operations (Source PDS)
	// ============================================

	/**
	 * Export repository as CAR file
	 */
	async getRepo(did: string): Promise<Uint8Array> {
		const response = await this.client.get("com.atproto.sync.getRepo", {
			params: { did: did as Did },
			as: "bytes",
		});
		if (!response.ok) {
			throw new ClientResponseError({
				status: response.status,
				headers: response.headers,
				data: response.data,
			});
		}
		return response.data;
	}

	/**
	 * Get a blob by CID
	 */
	async getBlob(
		did: string,
		cid: string,
	): Promise<{ bytes: Uint8Array; mimeType: string }> {
		const response = await this.client.get("com.atproto.sync.getBlob", {
			params: { did: did as Did, cid },
			as: "bytes",
		});
		if (!response.ok) {
			throw new ClientResponseError({
				status: response.status,
				headers: response.headers,
				data: response.data,
			});
		}
		return {
			bytes: response.data,
			mimeType: response.headers.get("content-type") ?? "application/octet-stream",
		};
	}

	/**
	 * List blobs in repository
	 */
	async listBlobs(
		did: string,
		cursor?: string,
	): Promise<{ cids: string[]; cursor?: string }> {
		return ok(
			this.client.get("com.atproto.sync.listBlobs", {
				params: { did: did as Did, ...(cursor && { cursor }) },
			}),
		);
	}

	// ============================================
	// Preferences
	// ============================================

	/**
	 * Get user preferences
	 */
	async getPreferences(): Promise<unknown[]> {
		const result = await ok(
			this.client.get("app.bsky.actor.getPreferences", { params: {} }),
		);
		return result.preferences;
	}

	/**
	 * Update user preferences
	 */
	async putPreferences(preferences: unknown[]): Promise<void> {
		// Use raw fetch because the typed preferences are too strict for migration
		const url = new URL("/xrpc/app.bsky.actor.putPreferences", this.baseUrl);
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
		};
		if (this.authToken) {
			headers["Authorization"] = `Bearer ${this.authToken}`;
		}
		const res = await fetch(url.toString(), {
			method: "POST",
			headers,
			body: JSON.stringify({ preferences }),
		});
		if (!res.ok) {
			const errorBody = (await res.json().catch(() => ({}))) as {
				error?: string;
				message?: string;
			};
			throw new ClientResponseError({
				status: res.status,
				headers: res.headers,
				data: { error: errorBody.error ?? "Unknown", message: errorBody.message },
			});
		}
	}

	// ============================================
	// Import Operations (Target PDS)
	// ============================================

	/**
	 * Get account status including migration progress
	 */
	async getAccountStatus(): Promise<MigrationStatus> {
		// Use raw fetch because this endpoint may not be in standard lexicons
		const url = new URL(
			"/xrpc/com.atproto.server.getAccountStatus",
			this.baseUrl,
		);
		const headers: Record<string, string> = {};
		if (this.authToken) {
			headers["Authorization"] = `Bearer ${this.authToken}`;
		}
		const res = await fetch(url.toString(), {
			method: "GET",
			headers,
		});
		if (!res.ok) {
			const errorBody = (await res.json().catch(() => ({}))) as {
				error?: string;
				message?: string;
			};
			throw new ClientResponseError({
				status: res.status,
				headers: res.headers,
				data: { error: errorBody.error ?? "Unknown", message: errorBody.message },
			});
		}
		return res.json() as Promise<MigrationStatus>;
	}

	/**
	 * Import repository from CAR file
	 */
	async importRepo(carBytes: Uint8Array): Promise<ImportResult> {
		// Use raw fetch because the typed client doesn't handle binary input properly
		const url = new URL("/xrpc/com.atproto.repo.importRepo", this.baseUrl);
		const headers: Record<string, string> = {
			"Content-Type": "application/vnd.ipld.car",
		};
		if (this.authToken) {
			headers["Authorization"] = `Bearer ${this.authToken}`;
		}
		const res = await fetch(url.toString(), {
			method: "POST",
			headers,
			body: carBytes,
		});
		if (!res.ok) {
			const errorBody = (await res.json().catch(() => ({}))) as {
				error?: string;
				message?: string;
			};
			throw new ClientResponseError({
				status: res.status,
				headers: res.headers,
				data: { error: errorBody.error ?? "Unknown", message: errorBody.message },
			});
		}
		return res.json() as Promise<ImportResult>;
	}

	/**
	 * List blobs that are missing (referenced but not imported)
	 */
	async listMissingBlobs(limit?: number, cursor?: string): Promise<BlobPage> {
		return ok(
			this.client.get("com.atproto.repo.listMissingBlobs", {
				params: {
					...(limit && { limit }),
					...(cursor && { cursor }),
				},
			}),
		);
	}

	/**
	 * Upload a blob
	 */
	async uploadBlob(bytes: Uint8Array, mimeType: string): Promise<BlobRef> {
		// Need to use raw fetch because the client doesn't handle content-type header properly for blobs
		const url = new URL("/xrpc/com.atproto.repo.uploadBlob", this.baseUrl);
		const headers: Record<string, string> = {
			"Content-Type": mimeType,
		};
		if (this.authToken) {
			headers["Authorization"] = `Bearer ${this.authToken}`;
		}
		const res = await fetch(url.toString(), {
			method: "POST",
			headers,
			body: bytes,
		});
		if (!res.ok) {
			const errorBody = (await res.json().catch(() => ({}))) as {
				error?: string;
				message?: string;
			};
			throw new ClientResponseError({
				status: res.status,
				headers: res.headers,
				data: { error: errorBody.error ?? "Unknown", message: errorBody.message },
			});
		}
		const result = (await res.json()) as { blob: BlobRef };
		return result.blob;
	}

	/**
	 * Reset migration state (only works on deactivated accounts)
	 * Custom endpoint - not in standard lexicons
	 */
	async resetMigration(): Promise<ResetResult> {
		const url = new URL(
			"/xrpc/gg.mk.experimental.resetMigration",
			this.baseUrl,
		);
		const headers: Record<string, string> = {};
		if (this.authToken) {
			headers["Authorization"] = `Bearer ${this.authToken}`;
		}
		const res = await fetch(url.toString(), {
			method: "POST",
			headers,
		});
		if (!res.ok) {
			const errorBody = (await res.json().catch(() => ({}))) as {
				error?: string;
				message?: string;
			};
			throw new ClientResponseError({
				status: res.status,
				headers: res.headers,
				data: { error: errorBody.error ?? "Unknown", message: errorBody.message },
			});
		}
		return res.json() as Promise<ResetResult>;
	}

	/**
	 * Activate account to enable writes
	 */
	async activateAccount(): Promise<void> {
		await ok(
			this.client.post("com.atproto.server.activateAccount", {
				as: null,
			}),
		);
	}

	/**
	 * Deactivate account to disable writes
	 */
	async deactivateAccount(): Promise<void> {
		await ok(
			this.client.post("com.atproto.server.deactivateAccount", {
				input: {},
				as: null,
			}),
		);
	}

	/**
	 * Emit identity event to notify relays to refresh handle verification
	 */
	async emitIdentity(): Promise<{ seq: number }> {
		const url = new URL("/xrpc/gg.mk.experimental.emitIdentityEvent", this.baseUrl);
		const headers: Record<string, string> = {};
		if (this.authToken) {
			headers["Authorization"] = `Bearer ${this.authToken}`;
		}
		const res = await fetch(url.toString(), {
			method: "POST",
			headers,
		});
		if (!res.ok) {
			const errorBody = (await res.json().catch(() => ({}))) as {
				message?: string;
			};
			throw new Error(
				errorBody.message ?? `Request failed: ${res.status}`,
			);
		}
		return res.json() as Promise<{ seq: number }>;
	}

	// ============================================
	// Health Check
	// ============================================

	/**
	 * Check if the PDS is reachable
	 */
	async healthCheck(): Promise<boolean> {
		try {
			const res = await fetch(new URL("/xrpc/_health", this.baseUrl).toString());
			return res.ok;
		} catch {
			return false;
		}
	}

	// ============================================
	// Identity Verification
	// ============================================

	/**
	 * Get DID document from PDS
	 */
	async getDidDocument(): Promise<{ id: string; service?: unknown[] }> {
		const res = await fetch(new URL("/.well-known/did.json", this.baseUrl));
		if (!res.ok) throw new Error("Failed to fetch DID document");
		return res.json() as Promise<{ id: string; service?: unknown[] }>;
	}

	/**
	 * Resolve handle to DID via public API
	 */
	async resolveHandle(handle: string): Promise<string | null> {
		try {
			const res = await fetch(
				`https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(handle)}`,
			);
			if (!res.ok) return null;
			const data = (await res.json()) as { did: string };
			return data.did;
		} catch {
			return null;
		}
	}

	/**
	 * Resolve DID to get service endpoints (supports did:plc and did:web)
	 */
	async resolveDid(did: string): Promise<{ pdsEndpoint: string | null }> {
		try {
			let doc: { service?: Array<{ type: string; serviceEndpoint: string }> };
			if (did.startsWith("did:plc:")) {
				const res = await fetch(`https://plc.directory/${did}`);
				if (!res.ok) return { pdsEndpoint: null };
				doc = (await res.json()) as typeof doc;
			} else if (did.startsWith("did:web:")) {
				const hostname = did.slice(8);
				const res = await fetch(`https://${hostname}/.well-known/did.json`);
				if (!res.ok) return { pdsEndpoint: null };
				doc = (await res.json()) as typeof doc;
			} else {
				return { pdsEndpoint: null };
			}
			const pds = doc.service?.find(
				(s) => s.type === "AtprotoPersonalDataServer",
			);
			return { pdsEndpoint: pds?.serviceEndpoint ?? null };
		} catch {
			return { pdsEndpoint: null };
		}
	}

	/**
	 * Check if profile is indexed by AppView
	 */
	async checkAppViewIndexing(did: string): Promise<boolean> {
		try {
			const res = await fetch(
				`https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(did)}`,
			);
			return res.ok;
		} catch {
			return false;
		}
	}

	/**
	 * Get firehose status (subscribers, seq)
	 * Custom endpoint - not in standard lexicons
	 */
	async getFirehoseStatus(): Promise<{
		subscribers: number;
		latestSeq: number | null;
	}> {
		const url = new URL(
			"/xrpc/gg.mk.experimental.getFirehoseStatus",
			this.baseUrl,
		);
		const headers: Record<string, string> = {};
		if (this.authToken) {
			headers["Authorization"] = `Bearer ${this.authToken}`;
		}
		const res = await fetch(url.toString(), {
			method: "GET",
			headers,
		});
		if (!res.ok) {
			const errorBody = (await res.json().catch(() => ({}))) as {
				error?: string;
				message?: string;
			};
			throw new ClientResponseError({
				status: res.status,
				headers: res.headers,
				data: { error: errorBody.error ?? "Unknown", message: errorBody.message },
			});
		}
		return res.json() as Promise<{ subscribers: number; latestSeq: number | null }>;
	}

	/**
	 * Check handle verification via HTTP well-known
	 */
	async checkHandleViaHttp(handle: string): Promise<string | null> {
		try {
			const res = await fetch(`https://${handle}/.well-known/atproto-did`);
			if (!res.ok) return null;
			const text = await res.text();
			return text.trim() || null;
		} catch {
			return null;
		}
	}

	/**
	 * Check handle verification via DNS TXT record (using DNS-over-HTTPS)
	 */
	async checkHandleViaDns(handle: string): Promise<string | null> {
		try {
			const res = await fetch(
				`https://cloudflare-dns.com/dns-query?name=_atproto.${handle}&type=TXT`,
				{ headers: { Accept: "application/dns-json" } },
			);
			if (!res.ok) return null;
			const data = (await res.json()) as {
				Answer?: Array<{ data: string }>;
			};
			const txtRecord = data.Answer?.find((a) => a.data?.includes("did="));
			if (!txtRecord) return null;
			// TXT records are quoted, extract the did= value
			const match = txtRecord.data.match(/did=([^\s"]+)/);
			return match?.[1] ?? null;
		} catch {
			return null;
		}
	}

	// ============================================
	// Record Operations
	// ============================================

	/**
	 * Get a record from the repository
	 */
	async getRecord(
		repo: Did,
		collection: Nsid,
		rkey: RecordKey,
	): Promise<ComAtprotoRepoGetRecord.$output | null> {
		try {
			return await ok(
				this.client.get("com.atproto.repo.getRecord", {
					params: { repo, collection, rkey },
				}),
			);
		} catch (err) {
			if (err instanceof ClientResponseError && err.status === 404) {
				return null;
			}
			throw err;
		}
	}

	/**
	 * Create or update a record in the repository
	 */
	async putRecord(
		repo: Did,
		collection: Nsid,
		rkey: RecordKey,
		record: Record<string, unknown>,
	): Promise<ComAtprotoRepoPutRecord.$output> {
		return ok(
			this.client.post("com.atproto.repo.putRecord", {
				input: { repo, collection, rkey, record },
			}),
		);
	}

	/**
	 * Get the user's profile record
	 */
	async getProfile(did: Did): Promise<AppBskyActorProfile.Main | null> {
		const record = await this.getRecord(did, "app.bsky.actor.profile", "self");
		if (!record) return null;
		return record.value as AppBskyActorProfile.Main;
	}

	/**
	 * Create or update the user's profile
	 */
	async putProfile(
		did: Did,
		profile: Partial<Omit<AppBskyActorProfile.Main, "$type">>,
	): Promise<ComAtprotoRepoPutRecord.$output> {
		return this.putRecord(did, "app.bsky.actor.profile", "self", {
			$type: "app.bsky.actor.profile",
			...profile,
		});
	}

	// ============================================
	// Relay Operations
	// ============================================

	// ============================================
	// Passkey Operations
	// ============================================

	/**
	 * Initialize passkey registration
	 * Returns a URL for the user to visit on their device
	 */
	async initPasskeyRegistration(name?: string): Promise<{
		token: string;
		url: string;
		expiresAt: number;
	}> {
		const url = new URL("/passkey/init", this.baseUrl);
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
		};
		if (this.authToken) {
			headers["Authorization"] = `Bearer ${this.authToken}`;
		}
		const res = await fetch(url.toString(), {
			method: "POST",
			headers,
			body: JSON.stringify({ name }),
		});
		if (!res.ok) {
			const errorBody = (await res.json().catch(() => ({}))) as {
				error?: string;
				message?: string;
			};
			throw new ClientResponseError({
				status: res.status,
				headers: res.headers,
				data: { error: errorBody.error ?? "Unknown", message: errorBody.message },
			});
		}
		return res.json() as Promise<{ token: string; url: string; expiresAt: number }>;
	}

	/**
	 * List all registered passkeys
	 */
	async listPasskeys(): Promise<{
		passkeys: Array<{
			id: string;
			name: string | null;
			createdAt: string;
			lastUsedAt: string | null;
		}>;
	}> {
		const url = new URL("/passkey/list", this.baseUrl);
		const headers: Record<string, string> = {};
		if (this.authToken) {
			headers["Authorization"] = `Bearer ${this.authToken}`;
		}
		const res = await fetch(url.toString(), {
			method: "GET",
			headers,
		});
		if (!res.ok) {
			const errorBody = (await res.json().catch(() => ({}))) as {
				error?: string;
				message?: string;
			};
			throw new ClientResponseError({
				status: res.status,
				headers: res.headers,
				data: { error: errorBody.error ?? "Unknown", message: errorBody.message },
			});
		}
		return res.json() as Promise<{
			passkeys: Array<{
				id: string;
				name: string | null;
				createdAt: string;
				lastUsedAt: string | null;
			}>;
		}>;
	}

	/**
	 * Delete a passkey by credential ID
	 */
	async deletePasskey(credentialId: string): Promise<{ success: boolean }> {
		const url = new URL("/passkey/delete", this.baseUrl);
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
		};
		if (this.authToken) {
			headers["Authorization"] = `Bearer ${this.authToken}`;
		}
		const res = await fetch(url.toString(), {
			method: "POST",
			headers,
			body: JSON.stringify({ id: credentialId }),
		});
		if (!res.ok) {
			const errorBody = (await res.json().catch(() => ({}))) as {
				error?: string;
				message?: string;
			};
			throw new ClientResponseError({
				status: res.status,
				headers: res.headers,
				data: { error: errorBody.error ?? "Unknown", message: errorBody.message },
			});
		}
		return res.json() as Promise<{ success: boolean }>;
	}

	static RELAY_URLS = [
		"https://relay1.us-west.bsky.network",
		"https://relay1.us-east.bsky.network",
	];

	/**
	 * Get relay's view of this PDS host status from a single relay.
	 * Calls com.atproto.sync.getHostStatus on the relay.
	 */
	async getRelayHostStatus(
		pdsHostname: string,
		relayUrl: string,
	): Promise<{
		status: "active" | "idle" | "offline" | "throttled" | "banned";
		accountCount?: number;
		seq?: number;
		relay: string;
	} | null> {
		try {
			const url = new URL("/xrpc/com.atproto.sync.getHostStatus", relayUrl);
			url.searchParams.set("hostname", pdsHostname);
			const res = await fetch(url.toString());
			if (!res.ok) return null;
			const data = await res.json() as {
				status: "active" | "idle" | "offline" | "throttled" | "banned";
				accountCount?: number;
				seq?: number;
			};
			return { ...data, relay: relayUrl };
		} catch {
			return null;
		}
	}

	/**
	 * Get relay status from all known relays.
	 * Returns results from each relay that responds.
	 */
	async getAllRelayHostStatus(
		pdsHostname: string,
	): Promise<Array<{
		status: "active" | "idle" | "offline" | "throttled" | "banned";
		accountCount?: number;
		seq?: number;
		relay: string;
	}>> {
		const results = await Promise.all(
			PDSClient.RELAY_URLS.map((url) => this.getRelayHostStatus(pdsHostname, url)),
		);
		return results.filter((r) => r !== null);
	}

	/**
	 * Request the relay to crawl this PDS.
	 * This notifies the Bluesky relay that the PDS is active and ready for federation.
	 * Uses bsky.network by default (the main relay endpoint).
	 */
	async requestCrawl(
		pdsHostname: string,
		relayUrl = "https://bsky.network",
	): Promise<boolean> {
		try {
			const url = new URL("/xrpc/com.atproto.sync.requestCrawl", relayUrl);
			const res = await fetch(url.toString(), {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ hostname: pdsHostname }),
			});
			return res.ok;
		} catch {
			return false;
		}
	}
}
