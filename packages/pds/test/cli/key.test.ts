import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { Secp256k1Keypair } from "@atproto/crypto";
import { readDevVars } from "../../src/cli/utils/dotenv.js";
import {
	generateSigningKeypair,
	derivePublicKey,
} from "../../src/cli/utils/secrets.js";

describe("generateSigningKeypair", () => {
	it("generates key that can be reimported", async () => {
		const { privateKey, publicKey } = await generateSigningKeypair();

		// Verify it's a valid hex string (64 chars for 32 bytes)
		expect(privateKey).toMatch(/^[0-9a-f]{64}$/);

		// Verify the key can be imported (this is what index.ts/account-do.ts does)
		const keypair = await Secp256k1Keypair.import(privateKey);

		// Verify the public key matches
		expect(publicKey).toBe(keypair.did().replace("did:key:", ""));
	});
});

describe("derivePublicKey", () => {
	it("derives public key from private key", async () => {
		const { privateKey, publicKey } = await generateSigningKeypair();
		const derived = await derivePublicKey(privateKey);
		expect(derived).toBe(publicKey);
	});
});

describe("pds secret key CLI", () => {
	let tempDir: string;
	const cliPath = join(__dirname, "../../dist/cli.js");

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pds-key-test-"));
		// Create minimal wrangler.jsonc so the CLI doesn't fail
		writeFileSync(
			join(tempDir, "wrangler.jsonc"),
			JSON.stringify({ name: "test", vars: {} }),
		);
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("generates signing key that can be reimported", async () => {
		// Run the CLI to generate a key
		execSync(`node ${cliPath} secret key --local`, {
			cwd: tempDir,
			stdio: "pipe",
		});

		// Read the generated key
		const vars = readDevVars(tempDir);
		expect(vars.SIGNING_KEY).toBeDefined();
		expect(vars.SIGNING_KEY_PUBLIC).toBeDefined();

		// Verify it's a valid hex string (64 chars for 32 bytes)
		expect(vars.SIGNING_KEY).toMatch(/^[0-9a-f]{64}$/);

		// Verify the key can be imported (this is what index.ts/account-do.ts does)
		const keypair = await Secp256k1Keypair.import(vars.SIGNING_KEY!);

		// Verify the public key matches
		const expectedPublic = keypair.did().replace("did:key:", "");
		expect(vars.SIGNING_KEY_PUBLIC).toBe(expectedPublic);
	});
});
