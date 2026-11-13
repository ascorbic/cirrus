import { describe, expect, it } from "vitest";
import {
	P256Keypair,
	Secp256k1Keypair,
	formatDidKey as cryptoFormatDidKey,
	parseDidKey as cryptoParseDidKey,
	P256_JWT_ALG,
	SECP256K1_JWT_ALG,
	multibaseToBytes,
} from "@atproto/crypto";
import {
	COMMIT_MAC_PROFILE as REF_COMMIT_MAC_PROFILE,
	RECORD_MAC_PROFILE as REF_RECORD_MAC_PROFILE,
	createSpaceSigHeaders,
	decapsulate,
	formatMacRequest as refFormatMacRequest,
	parseMacRequest,
	verifyCredentialSig,
} from "@atproto/space";
import { parseCid } from "@atproto/lex-data";
import {
	browserCatalog,
	coverageReport,
	cryptoCheckDescriptors,
	filterCatalog,
	knownChangesets,
	knownProposalAnchors,
	operatorChecks,
	baseChecks,
} from "../src/index";
import {
	KeypairIdentityProvider,
	createCredentialKey,
	cryptoChecks,
	fullCatalog,
} from "../src/full";
import {
	COMMIT_MAC_PROFILE,
	RECORD_MAC_PROFILE,
	compressP256,
	decompressP256,
	encapsulate,
	formatMacRequest,
	spaceSigHeaders,
} from "../src/space-auth";
import { createSyncerInbox } from "../src/inbox";
import { verificationMethodDidKey, didDocumentUrl } from "../src/did";
import { isTid, rawCid, tidAt, tidNow, fromBase58 } from "../src/encoding";

describe("full catalog", () => {
	it("assembles base + operator + crypto checks with unique ids", () => {
		const ids = fullCatalog.map((c) => c.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(ids).toContain("credential.member-gate");
		expect(ids).toContain("discovery.kem-key");
		expect(fullCatalog).toHaveLength(
			baseChecks.length + operatorChecks.length + cryptoChecks.length,
		);
	});

	it("has no dangling lexicon or changeset citations", () => {
		// Every lexicon citation must name a real vendored method/error, and
		// every changeset citation a real upstream changeset — a typo would
		// silently under-count coverage or cite nothing.
		const report = coverageReport(fullCatalog);
		expect(report.danglingCitations).toEqual([]);
		const changesets = new Set(knownChangesets);
		const anchors = new Set(knownProposalAnchors);
		for (const check of fullCatalog) {
			for (const c of check.citations) {
				if (c.source === "changeset") {
					expect(changesets.has(c.ref), `${check.id} cites ${c.ref}`).toBe(
						true,
					);
				}
				if (c.source === "proposal") {
					expect(c.ref, `${check.id} cites ${c.ref}`).toMatch(/^0016#/);
					expect(
						anchors.has(c.ref.slice(5)),
						`${check.id} cites ${c.ref}`,
					).toBe(true);
				}
			}
		}
	});

	it("covers every method and declared error, or exempts it with a reason", () => {
		const report = coverageReport(fullCatalog);
		expect(report.gaps.map((g) => g.ref)).toEqual([]);
		expect(report.staleExemptions).toEqual([]);
		// Exemptions are the moderation-state errors only; anything else
		// uncovered is a gap, not an exemption.
		for (const { ref, reason } of report.exempt) {
			expect(ref).toMatch(
				/@error:(Repo(Takendown|Suspended|Deactivated)|InvalidCursor)$|^com\.atproto\.space\.(getRecord|listRecords|getLatestCommit|listRepoOps|getRepo|listBlobs|getBlob)@error:SpaceNotFound$/,
			);
			expect(reason.length).toBeGreaterThan(20);
		}
	});

	it("every must check cites specified behaviour, not just the reference", () => {
		for (const check of fullCatalog) {
			if (check.tier !== "must") continue;
			expect(
				check.citations.some((c) => c.source !== "reference"),
				`${check.id} is a must citing only the reference`,
			).toBe(true);
		}
	});

	it("browserCatalog lists every check, crypto ones as not-testable", () => {
		// With no capabilities, only the base checks run and everything else
		// is reported skipped — never omitted. "not testable here" must never
		// silently read as conformant.
		const anonymous = filterCatalog(browserCatalog, { capabilities: [] });
		expect(anonymous.runnable.length).toBe(baseChecks.length);
		expect(anonymous.skipped.length).toBe(
			operatorChecks.length + cryptoCheckDescriptors.length,
		);

		// With an operator session (the web checker after OAuth sign-in), the
		// operator checks become runnable too — all but the ones needing a
		// syncer inbox no browser can host. The alpha-lib stubs stay
		// not-testable even where their declared needs are met.
		const authed = filterCatalog(browserCatalog, {
			capabilities: ["operator", "pds-blobs", "pds-delegation"],
			destructive: true,
		});
		const needsInbox = operatorChecks.filter((c) =>
			c.needs.includes("syncer-inbox"),
		);
		expect(needsInbox.length).toBeGreaterThan(0);
		expect(authed.runnable.length).toBe(
			baseChecks.length + operatorChecks.length - needsInbox.length,
		);
		expect(authed.skipped.length).toBe(
			cryptoCheckDescriptors.length + needsInbox.length,
		);
	});

	it("the browser descriptors match the real crypto checks exactly", () => {
		// The crypto checks spread their descriptor, so drift is impossible by
		// construction; this pins that nobody bypasses that.
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
			// Every authed check drives an operator session.
			expect(check.needs, check.id).toContain("operator");
			// A check that uses the target's own delegation tokens must say so.
			const source = check.run.toString();
			if (
				source.includes("getDelegationToken") ||
				source.includes("obtainCredentialViaDelegation")
			) {
				expect(check.needs, check.id).toContain("pds-delegation");
			}
			if (source.includes("ctx.identities")) {
				expect(check.needs, check.id).toContain("identities");
			}
			if (source.includes("ctx.syncerInbox")) {
				expect(check.needs, check.id).toContain("syncer-inbox");
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
		const sig = await reader1.sign(new TextEncoder().encode("hello"));
		expect(sig.byteLength).toBe(64);
	});

	it("supports resolvable (and async) DID mapping for live targets", async () => {
		const provider = new KeypairIdentityProvider(
			async (role) => `did:web:checker.test:${role}`,
		);
		const reader = await provider.identity("reader");
		expect(reader.did).toBe("did:web:checker.test:reader");
		expect(reader.didKey).toMatch(/^did:key:/);
	});

	it("builds the DID document the protocol requires of an identity", async () => {
		const provider = new KeypairIdentityProvider(
			async () => "did:web:localhost%3A1234",
		);
		const syncer = await provider.identity("syncer");
		const doc = KeypairIdentityProvider.didDocument(syncer, {
			serviceEndpoint: "http://localhost:1234",
		}) as never;
		// #atproto resolves back to the identity's own key, as a verifier would read it.
		expect(verificationMethodDidKey(doc, "atproto")).toBe(syncer.didKey);
		expect((doc as { service: unknown[] }).service).toEqual([
			{
				id: "#atproto_pds",
				type: "AtprotoPersonalDataServer",
				serviceEndpoint: "http://localhost:1234",
			},
		]);
	});
});

describe("browser-safe space auth matches @atproto/space", () => {
	it("credential keys are P-256 did:keys whose signatures the reference verifies", async () => {
		const key = await createCredentialKey();
		expect(cryptoParseDidKey(key.did).jwtAlg).toBe(P256_JWT_ALG);
		const headers = await spaceSigHeaders(key, {
			authorization: "Atproto-Space-Credential a.b.c",
			audience: "did:plc:abcdefghijklmnopqrstuvwx",
		});
		await expect(
			verifyCredentialSig(headers, key.did as never),
		).resolves.toBeUndefined();
		// And a different key's did is refused — the verification is real.
		const other = await createCredentialKey();
		await expect(
			verifyCredentialSig(headers, other.did as never),
		).rejects.toThrow();
	});

	it("encapsulate derives the secret the repo host decapsulates", async () => {
		const kem = await P256Keypair.create();
		const { keyShare, sharedSecret } = await encapsulate(kem.did());
		expect(decapsulate(kem, keyShare as never)).toEqual(sharedSecret);
	});

	it("formats MAC requests exactly as the reference does, and it parses them", async () => {
		const share = (await P256Keypair.create()).did();
		for (const [ours, theirs] of [
			[COMMIT_MAC_PROFILE, REF_COMMIT_MAC_PROFILE],
			[RECORD_MAC_PROFILE, REF_RECORD_MAC_PROFILE],
		] as const) {
			expect(formatMacRequest(ours, share)).toBe(
				refFormatMacRequest(theirs, share as never),
			);
			expect(
				parseMacRequest(formatMacRequest(ours, share, { label: "x" }), theirs),
			).toMatchObject({
				label: "x",
				keyShare: share,
			});
		}
	});

	it("signs credential requests exactly as the reference does", async () => {
		// ECDSA is randomised, so compare the signature input, and check the
		// reference verifies a variant with a custom label and extra
		// parameters (hosts find the signature by tag).
		const ours = await createCredentialKey();
		const ref = await P256Keypair.create();
		const opts = {
			authorization: "Atproto-Space-Credential a.b.c",
			audience: "did:plc:abcdefghijklmnopqrstuvwx",
		};
		const { headers } = await createSpaceSigHeaders({
			...opts,
			audience: opts.audience as never,
			keypair: ref,
		});
		const mine = await spaceSigHeaders({ sign: (b) => ref.sign(b) }, opts);
		expect(mine["signature-input"]).toBe(headers["signature-input"]);
		await expect(
			verifyCredentialSig(mine, ref.did() as never),
		).resolves.toBeUndefined();
		const variant = await spaceSigHeaders(ours, {
			...opts,
			label: "x7",
			params: [
				["created", 1],
				["keyid", ours.did],
			],
		});
		await expect(
			verifyCredentialSig(variant, ours.did as never),
		).resolves.toBeUndefined();
	});

	it("compresses and decompresses P-256 points like @atproto/crypto", async () => {
		const kp = await P256Keypair.create();
		const uncompressed = cryptoParseDidKey(kp.did()).keyBytes;
		const compressed = compressP256(uncompressed);
		expect(decompressP256(compressed)).toEqual(uncompressed);
		expect(cryptoFormatDidKey(P256_JWT_ALG, uncompressed)).toBe(kp.did());
	});

	it("reads legacy 2019 verification methods as PLC publishes them", async () => {
		const k256 = await Secp256k1Keypair.create();
		const p256 = await P256Keypair.create();
		// PLC renders keys as raw uncompressed multibase under the 2019 types.
		const legacy = (did: string, alg: string) => {
			const uncompressed = cryptoParseDidKey(did).keyBytes;
			void alg;
			return `z${encodeBase58(uncompressed)}`;
		};
		const doc = {
			id: "did:plc:abcdefghijklmnopqrstuvwx",
			verificationMethod: [
				{
					id: "#atproto",
					type: "EcdsaSecp256k1VerificationKey2019",
					publicKeyMultibase: legacy(k256.did(), SECP256K1_JWT_ALG),
				},
				{
					id: "#atproto_kem",
					type: "EcdsaSecp256r1VerificationKey2019",
					publicKeyMultibase: legacy(p256.did(), P256_JWT_ALG),
				},
			],
		};
		expect(verificationMethodDidKey(doc, "atproto")).toBe(k256.did());
		expect(verificationMethodDidKey(doc, "atproto_kem")).toBe(p256.did());
		// Sanity: the legacy encoding round-trips through the reference decoder.
		expect(
			multibaseToBytes(doc.verificationMethod[1]!.publicKeyMultibase),
		).toEqual(cryptoParseDidKey(p256.did()).keyBytes);
	});
});

describe("syncer inbox", () => {
	it("confirms and accepts only tokens it issued for the space", async () => {
		const { inbox, handle, deliveries } = createSyncerInbox({
			endpoint: "https://inbox.test",
			service: "did:web:inbox.test#atproto_pds",
		});
		const space =
			"at://did:plc:abcdefghijklmnopqrstuvwx/space/earth.cirrus.check.space/x";
		const token = inbox.issueToken(space);
		const post = (lxm: string, body: unknown) =>
			handle(
				new Request(`https://inbox.test/xrpc/${lxm}`, {
					method: "POST",
					body: JSON.stringify(body),
				}),
			);
		const ok = await post("com.atproto.space.confirmRegistration", {
			space,
			token,
			challenge: "c1",
		});
		expect(await ok.json()).toEqual({ challenge: "c1" });
		const wrongSpace = await post("com.atproto.space.confirmRegistration", {
			space: `${space}y`,
			token,
			challenge: "c2",
		});
		expect(wrongSpace.status).toBe(400);
		const unknown = await post("com.atproto.space.notifySpaceUpdate", {
			space,
			token: "nope",
			update: {},
		});
		expect(unknown.status).toBe(400);
		inbox.respond("com.atproto.managedspace.checkAccess", () => ({
			read: true,
			write: false,
		}));
		const answer = await handle(
			new Request(
				`https://inbox.test/xrpc/com.atproto.managedspace.checkAccess?space=${encodeURIComponent(space)}`,
			),
		);
		expect(await answer.json()).toEqual({ read: true, write: false });
		expect(deliveries().map((d) => d.status)).toEqual([200, 400, 400, 200]);
		const seen = await inbox.waitFor(
			(d) => d.lxm === "com.atproto.managedspace.checkAccess",
			10,
		);
		expect(seen?.params?.space).toBe(space);
	});
});

describe("encoding helpers", () => {
	it("mints TIDs that sort by time", () => {
		const now = tidNow();
		expect(isTid(now)).toBe(true);
		const later = tidAt(BigInt(Date.now() + 3_600_000) * 1000n);
		expect(isTid(later)).toBe(true);
		expect(later > now).toBe(true);
	});

	it("mints raw CIDs the reference parses", async () => {
		const cid = await rawCid(new TextEncoder().encode("hello"));
		expect(parseCid(cid).toString()).toBe(cid);
	});

	it("resolves did:web and did:plc document URLs like the reference", () => {
		expect(didDocumentUrl("did:web:example.com")).toBe(
			"https://example.com/.well-known/did.json",
		);
		expect(didDocumentUrl("did:web:localhost%3A2583")).toBe(
			"http://localhost:2583/.well-known/did.json",
		);
		expect(didDocumentUrl("did:plc:abc", "https://plc.test/")).toBe(
			"https://plc.test/did:plc:abc",
		);
		expect(() => didDocumentUrl("did:web:example.com:path")).toThrow();
	});

	it("base58 round-trips", () => {
		const bytes = new Uint8Array([0, 0, 1, 2, 255, 128]);
		expect(fromBase58(encodeBase58(bytes))).toEqual(bytes);
	});
});

// Local base58 for building legacy fixtures (independent of the code under test).
function encodeBase58(bytes: Uint8Array): string {
	const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
	let n = 0n;
	for (const b of bytes) n = n * 256n + BigInt(b);
	let out = "";
	while (n > 0n) {
		out = alphabet[Number(n % 58n)] + out;
		n /= 58n;
	}
	for (const b of bytes) {
		if (b !== 0) break;
		out = `1${out}`;
	}
	return out;
}
