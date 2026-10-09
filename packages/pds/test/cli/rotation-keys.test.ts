import { describe, it, expect } from "vitest";
import {
	P256Keypair,
	Secp256k1Keypair,
	bytesToMultibase,
	verifySignature,
} from "@atproto/crypto";
import {
	buildRotationKeys,
	findPreviousPdsEndpoint,
	generateRecoveryKey,
	importRotationKey,
	labelRotationKeys,
} from "../../src/cli/utils/rotation-keys.js";

const PDS = "did:key:zQ3shPdsKey";
const RECOVERY = "did:key:zQ3shRecoveryKey";
const OTHER = "did:key:zDnaeOtherKey";

describe("buildRotationKeys", () => {
	it("puts user keys before the PDS key, in the order given", () => {
		expect(
			buildRotationKeys({ userKeys: [RECOVERY, OTHER], pdsKey: PDS }),
		).toEqual([RECOVERY, OTHER, PDS]);
	});

	it("returns just the PDS key when the user holds none", () => {
		expect(buildRotationKeys({ userKeys: [], pdsKey: PDS })).toEqual([PDS]);
	});

	it("moves the PDS key to the end and drops duplicates", () => {
		expect(
			buildRotationKeys({ userKeys: [PDS, RECOVERY, RECOVERY], pdsKey: PDS }),
		).toEqual([RECOVERY, PDS]);
	});

	it("rejects keys that are not did:keys", () => {
		expect(() =>
			buildRotationKeys({ userKeys: ["zQ3shNoPrefix"], pdsKey: PDS }),
		).toThrow("Not a did:key");
	});

	it("rejects more than five keys", () => {
		const userKeys = [1, 2, 3, 4, 5].map((n) => `did:key:zKey${n}`);
		expect(() => buildRotationKeys({ userKeys, pdsKey: PDS })).toThrow(
			"at most 5",
		);
	});
});

describe("labelRotationKeys", () => {
	it("labels this PDS, the source PDS, and unknown keys", () => {
		expect(
			labelRotationKeys([RECOVERY, "did:key:zSource", PDS], {
				pdsKey: PDS,
				sourcePdsKeys: ["did:key:zSource"],
			}),
		).toEqual([
			{ key: RECOVERY, owner: "unknown" },
			{ key: "did:key:zSource", owner: "source-pds" },
			{ key: PDS, owner: "this-pds" },
		]);
	});

	it("treats every other key as unknown without source PDS keys", () => {
		expect(labelRotationKeys(["did:key:zSource"], { pdsKey: PDS })).toEqual([
			{ key: "did:key:zSource", owner: "unknown" },
		]);
	});
});

describe("findPreviousPdsEndpoint", () => {
	const entry = (
		endpoint: string | null,
		opts: { nullified?: boolean; type?: string } = {},
	) => ({
		did: "did:plc:abc123",
		operation: {
			type: opts.type ?? "plc_operation",
			prev: null,
			sig: "sig",
			rotationKeys: [],
			verificationMethods: {},
			alsoKnownAs: [],
			services: endpoint
				? {
						atproto_pds: {
							type: "AtprotoPersonalDataServer",
							endpoint,
						},
					}
				: {},
		},
		cid: "cid",
		nullified: opts.nullified ?? false,
		createdAt: "2025-01-01T00:00:00.000Z",
	});
	const log = (...entries: ReturnType<typeof entry>[]) =>
		entries as Parameters<typeof findPreviousPdsEndpoint>[0];

	it("returns the most recent endpoint before the current one", () => {
		expect(
			findPreviousPdsEndpoint(
				log(
					entry("https://first.example"),
					entry("https://morel.us-east.host.bsky.network"),
					entry("https://pds.example.com/"),
				),
				"https://pds.example.com",
			),
		).toBe("https://morel.us-east.host.bsky.network");
	});

	it("skips nullified operations and operations without a PDS", () => {
		expect(
			findPreviousPdsEndpoint(
				log(
					entry("https://real-previous.example"),
					entry("https://attacker.example", { nullified: true }),
					entry(null),
					entry("https://pds.example.com"),
				),
				"https://pds.example.com/",
			),
		).toBe("https://real-previous.example");
	});

	it("returns null when the DID has only pointed at the current PDS", () => {
		expect(
			findPreviousPdsEndpoint(
				log(entry("https://pds.example.com"), entry("https://pds.example.com")),
				"https://pds.example.com",
			),
		).toBeNull();
	});
});

describe("generateRecoveryKey", () => {
	it("generates a multibase secp256k1 key that imports to the same did:key", async () => {
		const { privateKey, did } = await generateRecoveryKey();
		expect(privateKey).toMatch(/^z[1-9A-HJ-NP-Za-km-z]+$/);
		expect(did).toMatch(/^did:key:zQ3s/);

		const keypair = await importRotationKey(privateKey);
		expect(keypair.did()).toBe(did);
	});

	it("generates a different key each time", async () => {
		const a = await generateRecoveryKey();
		const b = await generateRecoveryKey();
		expect(a.did).not.toBe(b.did);
	});
});

describe("importRotationKey", () => {
	it("imports a multibase secp256k1 key", async () => {
		const original = await Secp256k1Keypair.create({ exportable: true });
		const encoded = bytesToMultibase(
			new Uint8Array([0x81, 0x26, ...(await original.export())]),
			"base58btc",
		);
		expect((await importRotationKey(encoded)).did()).toBe(original.did());
	});

	it("imports a multibase P-256 key, goat's default", async () => {
		const original = await P256Keypair.create({ exportable: true });
		const encoded = bytesToMultibase(
			new Uint8Array([0x86, 0x26, ...(await original.export())]),
			"base58btc",
		);
		const imported = await importRotationKey(encoded);
		expect(imported.did()).toBe(original.did());

		const message = new TextEncoder().encode("plc operation");
		expect(
			await verifySignature(
				original.did(),
				message,
				await imported.sign(message),
			),
		).toBe(true);
	});

	it("imports a hex secp256k1 key, ignoring whitespace and case", async () => {
		const original = await Secp256k1Keypair.create({ exportable: true });
		const hex = Buffer.from(await original.export()).toString("hex");
		expect((await importRotationKey(`  ${hex.toUpperCase()}\n`)).did()).toBe(
			original.did(),
		);
	});

	it("rejects a public key", async () => {
		const keypair = await Secp256k1Keypair.create();
		const publicMultibase = keypair.did().replace("did:key:", "");
		await expect(importRotationKey(publicMultibase)).rejects.toThrow(
			"Unrecognised key format",
		);
	});

	it("rejects garbage", async () => {
		await expect(importRotationKey("not a key")).rejects.toThrow(
			"Unrecognised key format",
		);
		await expect(importRotationKey("z0OIl")).rejects.toThrow(
			"Not a valid multibase key",
		);
	});
});
