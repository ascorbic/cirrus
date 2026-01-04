/**
 * Wrangler integration utilities for setting vars and secrets
 */
import { spawn } from "node:child_process";

// Wrangler exports these experimental APIs for config manipulation
import { experimental_patchConfig, experimental_readRawConfig } from "wrangler";

export type VarName =
	| "PDS_HOSTNAME"
	| "DID"
	| "HANDLE"
	| "SIGNING_KEY_PUBLIC"
	| "INITIAL_ACTIVE";
export type SecretName =
	| "AUTH_TOKEN"
	| "SIGNING_KEY"
	| "JWT_SECRET"
	| "PASSWORD_HASH";

/**
 * Set a var in wrangler.jsonc using experimental_patchConfig
 */
export function setVar(name: VarName, value: string): void {
	const { configPath } = experimental_readRawConfig({});
	if (!configPath) {
		throw new Error("No wrangler config found");
	}

	experimental_patchConfig(configPath, {
		vars: { [name]: value },
	});
}

/**
 * Set multiple vars in wrangler.jsonc
 */
export function setVars(vars: Partial<Record<VarName, string>>): void {
	const { configPath } = experimental_readRawConfig({});
	if (!configPath) {
		throw new Error("No wrangler config found");
	}

	experimental_patchConfig(configPath, { vars });
}

/**
 * Get current vars from wrangler config
 */
export function getVars(): Record<string, string> {
	const { rawConfig } = experimental_readRawConfig({});
	return (rawConfig.vars as Record<string, string>) || {};
}

/**
 * Get current worker name from wrangler config
 */
export function getWorkerName(): string | undefined {
	const { rawConfig } = experimental_readRawConfig({});
	return rawConfig.name as string | undefined;
}

/**
 * Set worker name in wrangler config
 */
export function setWorkerName(name: string): void {
	const { configPath } = experimental_readRawConfig({});
	if (!configPath) {
		throw new Error("No wrangler config found");
	}
	experimental_patchConfig(configPath, { name });
}

/**
 * Set a secret using wrangler secret put
 */
export async function setSecret(
	name: SecretName,
	value: string,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn("wrangler", ["secret", "put", name], {
			stdio: ["pipe", "inherit", "inherit"],
		});

		child.stdin.write(value);
		child.stdin.end();

		child.on("close", (code) => {
			if (code === 0) {
				resolve();
			} else {
				reject(
					new Error(`wrangler secret put ${name} failed with code ${code}`),
				);
			}
		});

		child.on("error", reject);
	});
}

/**
 * Get account_id from wrangler config
 */
function getAccountId(): string | undefined {
	const { rawConfig } = experimental_readRawConfig({});
	return rawConfig.account_id as string | undefined;
}

/**
 * Set account_id in wrangler config
 */
export function setAccountId(accountId: string): void {
	const { configPath } = experimental_readRawConfig({});
	if (!configPath) {
		throw new Error("No wrangler config found");
	}
	experimental_patchConfig(configPath, { account_id: accountId });
}

/**
 * Set custom domain routes in wrangler config
 */
export function setCustomDomains(domains: string[]): void {
	const { configPath } = experimental_readRawConfig({});
	if (!configPath) {
		throw new Error("No wrangler config found");
	}
	const routes = domains.map((pattern) => ({ pattern, custom_domain: true }));
	experimental_patchConfig(configPath, { routes });
}

export interface CloudflareAccount {
	id: string;
	name: string;
}

/**
 * Detect available Cloudflare accounts by running wrangler whoami.
 * Returns array of accounts if multiple found, null if single account or already configured.
 */
export async function detectCloudflareAccounts(): Promise<CloudflareAccount[] | null> {
	if (getAccountId()) {
		return null;
	}

	const { stdout, stderr } = await runWranglerWithOutput(["whoami"]);
	const output = stdout + stderr;

	// Parse accounts from wrangler whoami table output:
	// │ Account Name │ Account ID │
	const accounts: CloudflareAccount[] = [];
	const regex = /│\s*([^│]+?)\s*│\s*([a-f0-9]{32})\s*│/g;
	let match;
	while ((match = regex.exec(output)) !== null) {
		const name = match[1]?.trim();
		const id = match[2];
		// Skip header row
		if (name && id && name !== "Account Name") {
			accounts.push({ name, id });
		}
	}

	return accounts.length > 1 ? accounts : null;
}

/**
 * Run a wrangler command and capture output
 */
function runWranglerWithOutput(
	args: string[],
): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		const child = spawn("wrangler", args, {
			stdio: ["pipe", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";

		child.stdout?.on("data", (data: Buffer) => {
			stdout += data.toString();
		});
		child.stderr?.on("data", (data: Buffer) => {
			stderr += data.toString();
		});

		child.on("close", () => {
			resolve({ stdout, stderr });
		});

		child.on("error", () => {
			resolve({ stdout, stderr });
		});
	});
}
