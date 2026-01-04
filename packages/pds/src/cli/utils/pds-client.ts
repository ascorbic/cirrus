/**
 * HTTP client for AT Protocol PDS XRPC endpoints
 */

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

export class PDSClientError extends Error {
	constructor(
		public status: number,
		public error: string,
		message: string,
	) {
		super(message);
		this.name = "PDSClientError";
	}
}

export class PDSClient {
	private authToken?: string;

	constructor(
		private baseUrl: string,
		authToken?: string,
	) {
		this.authToken = authToken;
	}

	/**
	 * Set the auth token for subsequent requests
	 */
	setAuthToken(token: string): void {
		this.authToken = token;
	}

	/**
	 * Make an XRPC request
	 */
	private async xrpc<T>(
		method: "GET" | "POST",
		endpoint: string,
		options: {
			params?: Record<string, string>;
			body?: unknown;
			contentType?: string;
			auth?: boolean;
		} = {},
	): Promise<T> {
		const url = new URL(`/xrpc/${endpoint}`, this.baseUrl);

		if (options.params) {
			for (const [key, value] of Object.entries(options.params)) {
				url.searchParams.set(key, value);
			}
		}

		const headers: Record<string, string> = {};

		if (options.auth && this.authToken) {
			headers["Authorization"] = `Bearer ${this.authToken}`;
		}

		if (options.contentType) {
			headers["Content-Type"] = options.contentType;
		} else if (options.body && !(options.body instanceof Uint8Array)) {
			headers["Content-Type"] = "application/json";
		}

		const res = await fetch(url.toString(), {
			method,
			headers,
			body: options.body
				? options.body instanceof Uint8Array
					? options.body
					: JSON.stringify(options.body)
				: undefined,
		});

		if (!res.ok) {
			const errorBody = await res.json().catch(() => ({}));
			throw new PDSClientError(
				res.status,
				(errorBody as { error?: string }).error ?? "Unknown",
				(errorBody as { message?: string }).message ??
					`Request failed: ${res.status}`,
			);
		}

		const contentType = res.headers.get("content-type") ?? "";
		if (contentType.includes("application/json")) {
			return res.json() as Promise<T>;
		}

		// Return empty object for non-JSON responses
		return {} as T;
	}

	/**
	 * Make a raw request that returns bytes
	 */
	private async xrpcBytes(
		method: "GET" | "POST",
		endpoint: string,
		options: {
			params?: Record<string, string>;
			body?: Uint8Array;
			contentType?: string;
			auth?: boolean;
		} = {},
	): Promise<{ bytes: Uint8Array; mimeType: string }> {
		const url = new URL(`/xrpc/${endpoint}`, this.baseUrl);

		if (options.params) {
			for (const [key, value] of Object.entries(options.params)) {
				url.searchParams.set(key, value);
			}
		}

		const headers: Record<string, string> = {};

		if (options.auth && this.authToken) {
			headers["Authorization"] = `Bearer ${this.authToken}`;
		}

		if (options.contentType) {
			headers["Content-Type"] = options.contentType;
		}

		const res = await fetch(url.toString(), {
			method,
			headers,
			body: options.body,
		});

		if (!res.ok) {
			const errorBody = await res.json().catch(() => ({}));
			throw new PDSClientError(
				res.status,
				(errorBody as { error?: string }).error ?? "Unknown",
				(errorBody as { message?: string }).message ??
					`Request failed: ${res.status}`,
			);
		}

		const bytes = new Uint8Array(await res.arrayBuffer());
		const mimeType = res.headers.get("content-type") ?? "application/octet-stream";

		return { bytes, mimeType };
	}

	// ============================================
	// Authentication
	// ============================================

	/**
	 * Create a session with identifier and password
	 */
	async createSession(identifier: string, password: string): Promise<Session> {
		return this.xrpc<Session>("POST", "com.atproto.server.createSession", {
			body: { identifier, password },
		});
	}

	// ============================================
	// Discovery
	// ============================================

	/**
	 * Get repository description including collections
	 */
	async describeRepo(did: string): Promise<RepoDescription> {
		return this.xrpc<RepoDescription>("GET", "com.atproto.repo.describeRepo", {
			params: { repo: did },
		});
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
		const { bytes } = await this.xrpcBytes(
			"GET",
			"com.atproto.sync.getRepo",
			{ params: { did } },
		);
		return bytes;
	}

	/**
	 * Get a blob by CID
	 */
	async getBlob(
		did: string,
		cid: string,
	): Promise<{ bytes: Uint8Array; mimeType: string }> {
		return this.xrpcBytes("GET", "com.atproto.sync.getBlob", {
			params: { did, cid },
		});
	}

	/**
	 * List blobs in repository
	 */
	async listBlobs(
		did: string,
		cursor?: string,
	): Promise<{ cids: string[]; cursor?: string }> {
		const params: Record<string, string> = { did };
		if (cursor) params.cursor = cursor;

		return this.xrpc<{ cids: string[]; cursor?: string }>(
			"GET",
			"com.atproto.sync.listBlobs",
			{ params },
		);
	}

	// ============================================
	// Preferences
	// ============================================

	/**
	 * Get user preferences
	 */
	async getPreferences(): Promise<unknown[]> {
		const result = await this.xrpc<{ preferences: unknown[] }>(
			"GET",
			"app.bsky.actor.getPreferences",
			{ auth: true },
		);
		return result.preferences;
	}

	/**
	 * Update user preferences
	 */
	async putPreferences(preferences: unknown[]): Promise<void> {
		await this.xrpc("POST", "app.bsky.actor.putPreferences", {
			body: { preferences },
			auth: true,
		});
	}

	// ============================================
	// Import Operations (Target PDS)
	// ============================================

	/**
	 * Get account status including migration progress
	 */
	async getAccountStatus(): Promise<MigrationStatus> {
		return this.xrpc<MigrationStatus>(
			"GET",
			"com.atproto.server.getAccountStatus",
			{ auth: true },
		);
	}

	/**
	 * Import repository from CAR file
	 */
	async importRepo(carBytes: Uint8Array): Promise<ImportResult> {
		return this.xrpc<ImportResult>("POST", "com.atproto.repo.importRepo", {
			body: carBytes,
			contentType: "application/vnd.ipld.car",
			auth: true,
		});
	}

	/**
	 * List blobs that are missing (referenced but not imported)
	 */
	async listMissingBlobs(limit?: number, cursor?: string): Promise<BlobPage> {
		const params: Record<string, string> = {};
		if (limit) params.limit = String(limit);
		if (cursor) params.cursor = cursor;

		return this.xrpc<BlobPage>("GET", "com.atproto.repo.listMissingBlobs", {
			params,
			auth: true,
		});
	}

	/**
	 * Upload a blob
	 */
	async uploadBlob(bytes: Uint8Array, mimeType: string): Promise<BlobRef> {
		const result = await this.xrpc<{ blob: BlobRef }>(
			"POST",
			"com.atproto.repo.uploadBlob",
			{
				body: bytes,
				contentType: mimeType,
				auth: true,
			},
		);
		return result.blob;
	}

	/**
	 * Reset migration state (only works on deactivated accounts)
	 */
	async resetMigration(): Promise<ResetResult> {
		return this.xrpc<ResetResult>("POST", "gg.mk.experimental.resetMigration", {
			auth: true,
		});
	}

	/**
	 * Activate account to enable writes
	 */
	async activateAccount(): Promise<void> {
		await this.xrpc("POST", "com.atproto.server.activateAccount", {
			auth: true,
		});
	}

	/**
	 * Deactivate account to disable writes
	 */
	async deactivateAccount(): Promise<void> {
		await this.xrpc("POST", "com.atproto.server.deactivateAccount", {
			auth: true,
		});
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
	 */
	async getFirehoseStatus(): Promise<{
		subscribers: number;
		latestSeq: number | null;
	}> {
		return this.xrpc<{ subscribers: number; latestSeq: number | null }>(
			"GET",
			"gg.mk.experimental.getFirehoseStatus",
			{ auth: true },
		);
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
}
