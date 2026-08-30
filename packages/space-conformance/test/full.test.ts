import { describe, expect, it } from "vitest";
import {
	browserCatalog,
	coverageReport,
	cryptoCheckDescriptors,
	filterCatalog,
	operatorChecks,
} from "../src/index";
import {
	KeypairIdentityProvider,
	createDpopKey,
	cryptoChecks,
	fullCatalog,
} from "../src/full";
import { readCarHeader } from "../src/car";

describe("full catalog", () => {
	it("assembles base + crypto checks with unique ids", () => {
		const ids = fullCatalog.map((c) => c.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(ids).toContain("credential.round-trip");
		expect(ids).toContain("discovery.space-host-service");
	});

	it("has no dangling lexicon citations", () => {
		// Every lexicon citation must name a real vendored method/error —
		// a typo would silently under-count coverage.
		const report = coverageReport(fullCatalog);
		expect(report.danglingCitations).toEqual([]);
	});

	it("covers the core method surface", () => {
		const report = coverageReport(fullCatalog);
		const covered = new Set(report.covered.map((c) => c.ref));
		for (const method of [
			"com.atproto.space.createRecord",
			"com.atproto.space.getRecord",
			"com.atproto.space.getSpaceCredential",
			"com.atproto.space.listRepoOps",
			"com.atproto.space.getRepo",
			"com.atproto.space.listRepos",
			"com.atproto.simplespace.createSpace",
		]) {
			expect(covered.has(method)).toBe(true);
		}
		// Coverage is honestly partial in the first catalog — gaps are the
		// backlog, and the report names them rather than hiding them.
		expect(report.gaps.length).toBeGreaterThan(0);
	});

	it("browserCatalog lists every check, crypto ones as not-testable", () => {
		// With no capabilities, only the base checks run and everything else
		// is reported skipped — never omitted. "not testable here" must never
		// silently read as conformant.
		const anonymous = filterCatalog(browserCatalog, { capabilities: [] });
		expect(anonymous.runnable.length).toBe(5); // the base checks
		expect(anonymous.skipped.length).toBe(
			operatorChecks.length + cryptoCheckDescriptors.length,
		);
		expect(anonymous.runnable.length + anonymous.skipped.length).toBe(
			browserCatalog.length,
		);

		// With an operator session (the web checker after OAuth sign-in), the
		// operator checks become runnable too; only the alpha-lib stubs stay
		// not-testable — even the ones whose declared needs are met, because
		// the stub carries the alpha-libs marker no browser provides.
		const authed = filterCatalog(browserCatalog, {
			capabilities: ["operator", "pds-blobs", "pds-delegation"],
			destructive: true,
		});
		expect(authed.runnable.length).toBe(5 + operatorChecks.length);
		expect(authed.skipped.length).toBe(cryptoCheckDescriptors.length);
	});

	it("the browser descriptors match the real crypto checks exactly", () => {
		// The browser adapter lists checks from these dependency-free
		// descriptors. If they drift from the real crypto catalog, the
		// browser would misreport coverage — so pin them here.
		const metadata = (
			checks: Array<{
				id: string;
				title: string;
				tier: string;
				needs: readonly string[];
				citations: readonly unknown[];
				destructive?: boolean;
			}>,
		) =>
			checks.map((c) => ({
				id: c.id,
				title: c.title,
				tier: c.tier,
				needs: [...c.needs].sort(),
				citations: c.citations,
				destructive: c.destructive ?? false,
			}));
		expect(metadata(cryptoCheckDescriptors)).toEqual(metadata(cryptoChecks));
	});

	it("every authed check declares the capabilities it uses", () => {
		for (const check of [...operatorChecks, ...cryptoChecks]) {
			// Every authed check drives an operator session; the runner would
			// otherwise hand it a context with no way to authorize a write.
			expect(check.needs).toContain("operator");
			// A check that obtains a credential must say how a reader is
			// realized: either harness-held identities play the reader role,
			// or the target mints the delegation itself (pds-delegation).
			// Declaring neither means the runner would run it with no reader
			// path and it would throw.
			if (check.id.startsWith("credential")) {
				const hasReaderPath =
					check.needs.includes("identities") ||
					check.needs.includes("pds-delegation");
				expect(hasReaderPath).toBe(true);
			}
		}
	});
});

describe("identity provider", () => {
	it("mints stable identities per role with did:key signing keys", async () => {
		const provider = new KeypairIdentityProvider();
		const reader1 = await provider.identity("reader");
		const reader2 = await provider.identity("reader");
		expect(reader1.did).toBe(reader2.did);
		expect(reader1.did).toMatch(/^did:key:/);
		expect(reader1.didKey).toBe(reader1.did);
		const writer = await provider.identity("writer");
		expect(writer.did).not.toBe(reader1.did);
		// The identity actually signs.
		const sig = await reader1.sign(new TextEncoder().encode("hello"));
		expect(sig.byteLength).toBeGreaterThan(0);
	});

	it("supports resolvable DID mapping for live targets", async () => {
		const provider = new KeypairIdentityProvider(
			(role) => `did:web:checker.test:actors:${role}`,
		);
		const reader = await provider.identity("reader");
		expect(reader.did).toBe("did:web:checker.test:actors:reader");
		// The did:key is still exposed for resolver wiring.
		expect(reader.didKey).toMatch(/^did:key:/);
	});

	it("mints ES256 DPoP keys with a valid thumbprint", async () => {
		const key = await createDpopKey();
		expect(key.algorithms).toContain("ES256");
		expect(key.bareJwk.kty).toBe("EC");
		expect(key.bareJwk.crv).toBe("P-256");
		expect(key.jkt).toMatch(/^[A-Za-z0-9_-]{43}$/); // base64url sha-256
		const jwt = await key.createJwt(
			{ alg: "ES256", typ: "dpop+jwt" },
			{ htm: "GET" },
		);
		expect(jwt.split(".")).toHaveLength(3);
	});
});

describe("CAR header reader", () => {
	it("reads the version and root count of a CARv1 header", async () => {
		// Build a minimal CARv1 header: varint(len) || dag-cbor({version,roots})
		// readCarHeader only counts roots, so a header with two placeholder
		// root entries exercises it without the environment-specific CID
		// hashing that a real CAR would need.
		const { encode } = await import("@atproto/lex-cbor");
		const headerBytes = encode({
			version: 1,
			roots: [new Uint8Array([1]), new Uint8Array([2])],
		});
		const varint = (n: number): number[] => {
			const out: number[] = [];
			while (n >= 0x80) {
				out.push((n & 0x7f) | 0x80);
				n >>>= 7;
			}
			out.push(n);
			return out;
		};
		const car = new Uint8Array([...varint(headerBytes.length), ...headerBytes]);
		const info = readCarHeader(car);
		expect(info.version).toBe(1);
		expect(info.rootCount).toBe(2);
	});
});
