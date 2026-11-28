/**
 * Utilities for resolving AT Protocol handles to DIDs
 */
import {
	CompositeHandleResolver,
	DohJsonHandleResolver,
	WellKnownHandleResolver,
} from "@atcute/identity-resolver";

// The resolvers capture fetch when constructed; read it per call instead so
// tests can stub it
const currentFetch: typeof fetch = (input, init) =>
	globalThis.fetch(input, init);

// DNS TXT first, then /.well-known/atproto-did. Hosted handles such as
// *.bsky.social have no TXT record and resolve only over HTTP.
const resolver = new CompositeHandleResolver({
	strategy: "dns-first",
	methods: {
		dns: new DohJsonHandleResolver({
			dohUrl: "https://cloudflare-dns.com/dns-query",
			fetch: currentFetch,
		}),
		http: new WellKnownHandleResolver({ fetch: currentFetch }),
	},
});

/**
 * Resolve a handle to a DID using the AT Protocol handle resolution methods:
 * a DNS TXT record (via Cloudflare DNS-over-HTTPS), then
 * /.well-known/atproto-did on the handle's domain.
 */
export async function resolveHandleToDid(
	handle: string,
): Promise<string | null> {
	try {
		const did = await resolver.resolve(handle as `${string}.${string}`, {
			signal: AbortSignal.timeout(10000),
		});
		return did;
	} catch {
		// Resolution failed
		return null;
	}
}
