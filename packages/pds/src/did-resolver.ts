/**
 * DID resolution for Cloudflare Workers
 *
 * Uses @atcute/identity-resolver which is already Workers-compatible
 * (uses redirect: "manual" internally).
 */

import {
	CompositeDidDocumentResolver,
	PlcDidDocumentResolver,
	WebDidDocumentResolver,
} from "@atcute/identity-resolver";
import type { DidDocument } from "@atcute/identity";
import type { Did } from "@atcute/lexicons/syntax";
import type { DidCache } from "./did-cache";

const PLC_DIRECTORY = "https://plc.directory";
const TIMEOUT_MS = 3000;

export interface DidResolverOpts {
	plcUrl?: string;
	timeout?: number;
	didCache?: DidCache;
}

// Re-export DidDocument for consumers
export type { DidDocument };

/**
 * Wrapper that always uses globalThis.fetch so it can be mocked in tests.
 * @atcute resolvers capture the fetch reference at construction time,
 * so we need this indirection to allow test mocking.
 */
const stubbableFetch: typeof fetch = (input, init) => globalThis.fetch(input, init);

export class DidResolver {
	private resolver: CompositeDidDocumentResolver<"plc" | "web">;
	private timeout: number;
	private cache?: DidCache;

	constructor(opts: DidResolverOpts = {}) {
		this.timeout = opts.timeout ?? TIMEOUT_MS;
		this.cache = opts.didCache;

		this.resolver = new CompositeDidDocumentResolver({
			methods: {
				plc: new PlcDidDocumentResolver({
					apiUrl: opts.plcUrl ?? PLC_DIRECTORY,
					fetch: stubbableFetch,
				}),
				web: new WebDidDocumentResolver({
					fetch: stubbableFetch,
				}),
			},
		});
	}

	async resolve(did: string): Promise<DidDocument | null> {
		// Check cache first
		if (this.cache) {
			const cached = await this.cache.checkCache(did);
			if (cached && !cached.expired) {
				// Trigger background refresh if stale
				if (cached.stale) {
					this.cache.refreshCache(did, () => this.resolveNoCache(did), cached);
				}
				return cached.doc;
			}
		}

		const doc = await this.resolveNoCache(did);

		// Update cache
		if (doc && this.cache) {
			await this.cache.cacheDid(did, doc);
		} else if (!doc && this.cache) {
			await this.cache.clearEntry(did);
		}

		return doc;
	}

	private async resolveNoCache(did: string): Promise<DidDocument | null> {
		// Create abort signal with timeout
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), this.timeout);

		try {
			// @atcute resolver throws on errors, we return null
			const doc = await this.resolver.resolve(did as Did<"plc" | "web">, {
				signal: controller.signal,
			});
			// Validate that the returned document matches the requested DID
			if (doc.id !== did) {
				return null;
			}
			return doc;
		} catch {
			return null;
		} finally {
			clearTimeout(timeoutId);
		}
	}
}
