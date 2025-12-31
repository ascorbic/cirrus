/**
 * Secret generation and management utilities for PDS CLI
 */
import { randomBytes } from "node:crypto";
import { Secp256k1Keypair } from "@atproto/crypto";
import bcrypt from "bcryptjs";
import * as p from "@clack/prompts";
import { setSecret, setVar, type SecretName } from "./wrangler.js";
import { setDevVar } from "./dotenv.js";

export interface SigningKeypair {
	privateKey: string; // hex-encoded
	publicKey: string; // multibase (did:key without prefix)
}

/**
 * Generate a new secp256k1 signing keypair
 */
export async function generateSigningKeypair(): Promise<SigningKeypair> {
	const keypair = await Secp256k1Keypair.create({ exportable: true });
	return {
		privateKey: Buffer.from(await keypair.export()).toString("hex"),
		publicKey: keypair.did().replace("did:key:", ""),
	};
}

/**
 * Derive public key from an existing private key
 */
export async function derivePublicKey(privateKeyHex: string): Promise<string> {
	const keypair = await Secp256k1Keypair.import(privateKeyHex);
	return keypair.did().replace("did:key:", "");
}

/**
 * Generate a random auth token (base64url, 32 bytes)
 */
export function generateAuthToken(): string {
	return randomBytes(32).toString("base64url");
}

/**
 * Generate a random JWT secret (base64, 32 bytes)
 */
export function generateJwtSecret(): string {
	return randomBytes(32).toString("base64");
}

/**
 * Hash a password using bcrypt
 */
export async function hashPassword(password: string): Promise<string> {
	return bcrypt.hash(password, 10);
}

/**
 * Prompt for password with confirmation (max 3 attempts)
 */
export async function promptPassword(handle?: string): Promise<string> {
	const message = handle
		? `Choose a password for @${handle}:`
		: "Enter password:";

	const MAX_ATTEMPTS = 3;
	let attempts = 0;

	while (attempts < MAX_ATTEMPTS) {
		attempts++;
		const password = await p.password({
			message,
		});
		if (p.isCancel(password)) {
			p.cancel("Cancelled");
			process.exit(0);
		}

		const confirm = await p.password({
			message: "Confirm password:",
		});
		if (p.isCancel(confirm)) {
			p.cancel("Cancelled");
			process.exit(0);
		}

		if (password === confirm) {
			return password;
		}

		p.log.error("Passwords do not match. Try again.");
	}

	// Max attempts reached
	p.log.error("Too many failed attempts.");
	p.cancel("Password setup cancelled");
	process.exit(1);
}

/**
 * Set a secret value, either locally (.dev.vars) or via wrangler
 */
export async function setSecretValue(
	name: SecretName,
	value: string,
	local: boolean,
): Promise<void> {
	if (local) {
		setDevVar(name, value);
	} else {
		await setSecret(name, value);
	}
}

/**
 * Set a public var in wrangler.jsonc
 */
export function setPublicVar(
	name: "SIGNING_KEY_PUBLIC",
	value: string,
	local: boolean,
): void {
	if (local) {
		setDevVar(name, value);
	} else {
		setVar(name, value);
	}
}
