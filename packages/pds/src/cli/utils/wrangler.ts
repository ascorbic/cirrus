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

export interface WranglerResult {
	stdout: string;
	stderr: string;
	code: number | null;
}

export interface WranglerOptions {
	/** Data to write to stdin (e.g., for secret values) */
	stdin?: string;
	/** If true, throw on non-zero exit code */
	throwOnError?: boolean;
}

/**
 * Run a wrangler command and capture output.
 * This is the single point of entry for all wrangler CLI invocations.
 *
 * @example
 * // Basic command
 * const { stdout } = await runWrangler(["whoami"]);
 *
 * @example
 * // Command with stdin (for secrets)
 * await runWrangler(["secret", "put", "MY_SECRET"], { stdin: secretValue, throwOnError: true });
 *
 * @example
 * // Command that should throw on failure
 * await runWrangler(["types"], { throwOnError: true });
 */
export function runWrangler(
	args: string[],
	options: WranglerOptions = {},
): Promise<WranglerResult> {
	const { stdin, throwOnError = false } = options;

	return new Promise((resolve, reject) => {
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

		// Write stdin if provided
		if (stdin !== undefined) {
			child.stdin.write(stdin);
			child.stdin.end();
		}

		child.on("close", (code) => {
			if (throwOnError && code !== 0) {
				const cmd = `wrangler ${args.join(" ")}`;
				reject(new Error(`${cmd} failed with code ${code}\n${stderr}`));
			} else {
				resolve({ stdout, stderr, code });
			}
		});

		child.on("error", (err) => {
			if (throwOnError) {
				reject(err);
			} else {
				resolve({ stdout, stderr, code: null });
			}
		});
	});
}

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
	await runWrangler(["secret", "put", name], {
		stdin: value,
		throwOnError: true,
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

	const { stdout, stderr } = await runWrangler(["whoami"]);
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
 * Parse wrangler secret list output (JSON or table format)
 * Exported for testing
 */
export function parseSecretListOutput(output: string): string[] {
	// Try JSON output first (array like [{"name":"AUTH_TOKEN","type":"secret_text"}, ...])
	try {
		const secrets = JSON.parse(output);
		if (Array.isArray(secrets)) {
			return secrets.map((s: { name: string }) => s.name);
		}
	} catch {
		// Fallback: parse table format if JSON fails
		// │ Name │ Type │
		const names: string[] = [];
		const regex = /│\s*(\w+)\s*│\s*secret_text\s*│/g;
		let match;
		while ((match = regex.exec(output)) !== null) {
			const name = match[1];
			if (name && name !== "Name") {
				names.push(name);
			}
		}
		return names;
	}
	return [];
}

/**
 * List secret names currently deployed to Cloudflare
 * (Values cannot be retrieved - only names)
 */
export async function listSecrets(): Promise<string[]> {
	const { stdout } = await runWrangler(["secret", "list"]);
	return parseSecretListOutput(stdout);
}
