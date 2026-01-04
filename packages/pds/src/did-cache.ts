/**
 * DID cache using Cloudflare Workers Cache API
 */

import { defs, type DidDocument } from "@atcute/identity";
import { waitUntil } from "cloudflare:workers";

/**
 * Cache result from checking the DID cache.
 */
export interface CacheResult {
	did: string;
	doc: DidDocument;
	updatedAt: number;
	stale: boolean;
	expired: boolean;
}

/**
 * Interface for DID document caching.
 */
export interface DidCache {
	cacheDid(
		did: string,
		doc: DidDocument,
		prevResult?: CacheResult,
	): Promise<void>;
	checkCache(did: string): Promise<CacheResult | null>;
	refreshCache(
		did: string,
		getDoc: () => Promise<DidDocument | null>,
		prevResult?: CacheResult,
	): Promise<void>;
	clearEntry(did: string): Promise<void>;
	clear(): Promise<void>;
}

const STALE_TTL = 60 * 60 * 1000; // 1 hour - serve from cache but refresh in background
const MAX_TTL = 24 * 60 * 60 * 1000; // 24 hours - must refresh

export class WorkersDidCache implements DidCache {
	private cache: Cache;

	constructor() {
		this.cache = caches.default;
	}

	private getCacheKey(did: string): string {
		// Use a stable URL format for cache keys
		return `https://did-cache.internal/${encodeURIComponent(did)}`;
	}

	async cacheDid(
		did: string,
		doc: DidDocument,
		_prevResult?: CacheResult,
	): Promise<void> {
		const cacheKey = this.getCacheKey(did);
		const response = new Response(JSON.stringify(doc), {
			headers: {
				"Content-Type": "application/json",
				"Cache-Control": "max-age=86400", // 24 hours
				"X-Cached-At": Date.now().toString(),
			},
		});

		await this.cache.put(cacheKey, response);
	}

	async checkCache(did: string): Promise<CacheResult | null> {
		const cacheKey = this.getCacheKey(did);
		const response = await this.cache.match(cacheKey);

		if (!response) {
			return null;
		}

		const cachedAt = parseInt(response.headers.get("X-Cached-At") || "0", 10);
		const now = Date.now();
		const age = now - cachedAt;

		// Validate cached document schema
		const parsed = defs.didDocument.try(await response.json());
		if (!parsed.ok || parsed.value.id !== did) {
			await this.clearEntry(did);
			return null;
		}

		return {
			did,
			doc: parsed.value,
			updatedAt: cachedAt,
			stale: age > STALE_TTL,
			expired: age > MAX_TTL,
		};
	}

	async refreshCache(
		did: string,
		getDoc: () => Promise<DidDocument | null>,
		_prevResult?: CacheResult,
	): Promise<void> {
		// Background refresh using waitUntil to ensure it completes after response
		waitUntil(
			getDoc().then((doc) => {
				if (doc) {
					return this.cacheDid(did, doc);
				}
			}),
		);
	}

	async clearEntry(did: string): Promise<void> {
		const cacheKey = this.getCacheKey(did);
		await this.cache.delete(cacheKey);
	}

	async clear(): Promise<void> {
		// Cache API doesn't have a clear-all method
		// Would need to track keys separately if needed
		// For now, entries will expire naturally
	}
}
