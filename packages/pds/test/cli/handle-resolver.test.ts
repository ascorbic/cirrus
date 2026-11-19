import { describe, it, expect, vi, afterEach } from "vitest";
import { resolveHandleToDid } from "../../src/cli/utils/handle-resolver.js";

const DID = "did:plc:djfdx5q6exybrkcdfz5zn7df";

/** Answer DNS-over-HTTPS and /.well-known/atproto-did lookups */
function mockNetwork(opts: { dns?: string; http?: string }) {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) => {
			const url = new URL(input instanceof Request ? input.url : input);
			if (url.origin === "https://cloudflare-dns.com") {
				const name = url.searchParams.get("name")!;
				return Response.json(
					{
						Status: opts.dns ? 0 : 3,
						TC: false,
						RD: true,
						RA: true,
						AD: false,
						CD: false,
						Question: [{ name, type: 16 }],
						...(opts.dns && {
							Answer: [{ name, type: 16, TTL: 300, data: `"did=${opts.dns}"` }],
						}),
					},
					{ headers: { "Content-Type": "application/dns-json" } },
				);
			}
			if (url.pathname === "/.well-known/atproto-did") {
				return opts.http
					? new Response(opts.http)
					: new Response("Not Found", { status: 404 });
			}
			throw new Error(`Unexpected fetch: ${url}`);
		}),
	);
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("resolveHandleToDid", () => {
	it("resolves a handle with a DNS TXT record", async () => {
		mockNetwork({ dns: DID });
		expect(await resolveHandleToDid("alice.example.com")).toBe(DID);
	});

	it("resolves a handle served over HTTP, like *.bsky.social", async () => {
		mockNetwork({ http: DID });
		expect(await resolveHandleToDid("rotationtest.bsky.social")).toBe(DID);
	});

	it("returns null when neither method resolves", async () => {
		mockNetwork({});
		expect(await resolveHandleToDid("nobody.example.com")).toBeNull();
	});
});
