/**
 * Wrangler integration utilities for setting vars and secrets
 */
import { spawn } from "node:child_process";

// Wrangler exports these experimental APIs for config manipulation
import { experimental_patchConfig, experimental_readRawConfig } from "wrangler";

export type VarName = "PDS_HOSTNAME" | "DID" | "HANDLE" | "SIGNING_KEY_PUBLIC";
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
 * Delete a secret using wrangler secret delete
 */
export async function deleteSecret(name: SecretName): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn("wrangler", ["secret", "delete", name, "--force"], {
			stdio: "inherit",
		});

		child.on("close", (code) => {
			if (code === 0) {
				resolve();
			} else {
				reject(
					new Error(`wrangler secret delete ${name} failed with code ${code}`),
				);
			}
		});

		child.on("error", reject);
	});
}
