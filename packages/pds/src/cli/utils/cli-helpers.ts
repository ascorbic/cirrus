/**
 * Shared CLI utilities for PDS commands
 */
import * as p from "@clack/prompts";
import type {
	TextOptions,
	ConfirmOptions,
	SelectOptions,
} from "@clack/prompts";
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Prompt for text input, exiting on cancel
 */
export async function promptText(options: TextOptions): Promise<string> {
	const result = await p.text(options);
	if (p.isCancel(result)) {
		p.cancel("Cancelled");
		process.exit(0);
	}
	return result as string;
}

/**
 * Prompt for confirmation, exiting on cancel
 */
export async function promptConfirm(options: ConfirmOptions): Promise<boolean> {
	const result = await p.confirm(options);
	if (p.isCancel(result)) {
		p.cancel("Cancelled");
		process.exit(0);
	}
	return result;
}

/**
 * Prompt for selection, exiting on cancel
 */
export async function promptSelect<V>(options: SelectOptions<V>): Promise<V> {
	const result = await p.select(options);
	if (p.isCancel(result)) {
		p.cancel("Cancelled");
		process.exit(0);
	}
	return result as V;
}

/**
 * Get target PDS URL based on mode
 */
export function getTargetUrl(
	isDev: boolean,
	pdsHostname: string | undefined,
): string {
	if (isDev) {
		return `http://localhost:${process.env.PORT ? (parseInt(process.env.PORT) ?? "5173") : "5173"}`;
	}
	if (!pdsHostname) {
		throw new Error("PDS_HOSTNAME not configured in wrangler.jsonc");
	}
	return `https://${pdsHostname}`;
}

/**
 * Extract domain from URL
 */
export function getDomain(url: string): string {
	try {
		return new URL(url).hostname;
	} catch {
		return url;
	}
}

export type PackageManager = "npm" | "yarn" | "pnpm" | "bun";

/**
 * Detect which package manager is being used based on npm_config_user_agent
 */
export function detectPackageManager(): PackageManager {
	const userAgent = process.env.npm_config_user_agent || "";
	if (userAgent.startsWith("yarn")) return "yarn";
	if (userAgent.startsWith("pnpm")) return "pnpm";
	if (userAgent.startsWith("bun")) return "bun";
	return "npm";
}

/**
 * Format a command for the detected package manager
 * npm always needs "run" for scripts, pnpm/yarn/bun can use shorthand
 * except for "deploy" which conflicts with pnpm's built-in deploy command
 */
export function formatCommand(pm: PackageManager, ...args: string[]): string {
	const needsRun = pm === "npm" || args[0] === "deploy";
	if (needsRun) {
		return `${pm} run ${args.join(" ")}`;
	}
	return `${pm} ${args.join(" ")}`;
}

/**
 * Copy text to clipboard using platform-specific command
 * Falls back gracefully if clipboard is unavailable
 */
export async function copyToClipboard(text: string): Promise<boolean> {
	const platform = process.platform;
	let cmd: string;
	let args: string[];

	if (platform === "darwin") {
		cmd = "pbcopy";
		args = [];
	} else if (platform === "linux") {
		// Try xclip first, fall back to xsel
		cmd = "xclip";
		args = ["-selection", "clipboard"];
	} else if (platform === "win32") {
		cmd = "clip";
		args = [];
	} else {
		return false;
	}

	return new Promise((resolve) => {
		const child = spawn(cmd, args, { stdio: ["pipe", "ignore", "ignore"] });

		child.on("error", () => resolve(false));
		child.on("close", (code) => resolve(code === 0));

		child.stdin?.write(text);
		child.stdin?.end();
	});
}

/**
 * Check if 1Password CLI (op) is available
 * Only checks on POSIX systems (macOS, Linux)
 */
export async function is1PasswordAvailable(): Promise<boolean> {
	if (process.platform === "win32") {
		return false;
	}

	return new Promise((resolve) => {
		const child = spawn("which", ["op"], {
			stdio: ["ignore", "pipe", "ignore"],
		});

		child.on("error", () => resolve(false));
		child.on("close", (code) => resolve(code === 0));
	});
}

export type BackupKeyKind = "signing" | "recovery";

const KEY_BACKUP_TEXT: Record<
	BackupKeyKind,
	{
		name: string;
		label: string;
		title: string;
		heading: string;
		filePrefix: string;
		tag: string;
		warning: string;
		encoding: string;
	}
> = {
	signing: {
		name: "signing key",
		label: "Signing Key",
		title: "Cirrus PDS Signing Key",
		heading: "CIRRUS PDS SIGNING KEY",
		filePrefix: "signing-key-backup",
		tag: "signing-key",
		warning: "WARNING: This key controls your identity!",
		encoding: "hex-encoded secp256k1 private key",
	},
	recovery: {
		name: "recovery key",
		label: "Recovery Key",
		title: "atproto Recovery Key",
		heading: "ATPROTO RECOVERY KEY",
		filePrefix: "recovery-key-backup",
		tag: "recovery-key",
		warning: "WARNING: This key can take control of your identity!",
		encoding: "multibase private key, usable with goat",
	},
};

/**
 * Save a key to 1Password using the CLI
 * Creates a secure note with the key and any extra details
 */
export async function saveTo1Password(
	key: string,
	handle: string,
	kind: BackupKeyKind = "signing",
	details: string[] = [],
): Promise<{ success: boolean; itemName?: string; error?: string }> {
	const text = KEY_BACKUP_TEXT[kind];
	const itemName = `${text.title} - ${handle}`;
	const notes = [
		text.heading,
		"",
		`Handle: ${handle}`,
		`Created: ${new Date().toISOString()}`,
		...details,
		"",
		text.warning,
		"",
		`${text.name.toUpperCase()}:`,
		key,
	].join("\n");

	return new Promise((resolve) => {
		const child = spawn(
			"op",
			[
				"item",
				"create",
				"--category",
				"Secure Note",
				"--title",
				itemName,
				`notesPlain=${notes}`,
				"--tags",
				`cirrus,pds,${text.tag}`,
			],
			{ stdio: ["ignore", "pipe", "pipe"] },
		);

		let stderr = "";
		child.stderr?.on("data", (data) => {
			stderr += data.toString();
		});

		child.on("error", (err) => {
			resolve({ success: false, error: err.message });
		});

		child.on("close", (code) => {
			if (code === 0) {
				resolve({ success: true, itemName });
			} else {
				resolve({
					success: false,
					error: stderr || `1Password CLI exited with code ${code}`,
				});
			}
		});
	});
}

/**
 * Save a password to 1Password as a Login item for bsky.app
 */
export async function savePasswordTo1Password(
	password: string,
	handle: string,
): Promise<{ success: boolean; itemName?: string; error?: string }> {
	const itemName = `Bluesky - @${handle}`;

	return new Promise((resolve) => {
		const child = spawn(
			"op",
			[
				"item",
				"create",
				"--category",
				"Login",
				"--title",
				itemName,
				`username=${handle}`,
				`password=${password}`,
				"--url=https://bsky.app",
				"--tags",
				"cirrus,pds,bluesky",
			],
			{ stdio: ["ignore", "pipe", "pipe"] },
		);

		let stderr = "";
		child.stderr?.on("data", (data) => {
			stderr += data.toString();
		});

		child.on("error", (err) => {
			resolve({ success: false, error: err.message });
		});

		child.on("close", (code) => {
			if (code === 0) {
				resolve({ success: true, itemName });
			} else {
				resolve({
					success: false,
					error: stderr || `1Password CLI exited with code ${code}`,
				});
			}
		});
	});
}

export interface RunCommandOptions {
	/** If true, stream output to stdout/stderr in real-time */
	stream?: boolean;
}

/**
 * Run a shell command and return a promise.
 * Captures output and throws on non-zero exit code.
 * Use this for running npm/pnpm/yarn scripts etc.
 */
export function runCommand(
	cmd: string,
	args: string[],
	options: RunCommandOptions = {},
): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(cmd, args, {
			stdio: options.stream ? "inherit" : "pipe",
		});

		let output = "";
		if (!options.stream) {
			child.stdout?.on("data", (data) => {
				output += data.toString();
			});
			child.stderr?.on("data", (data) => {
				output += data.toString();
			});
		}

		child.on("close", (code) => {
			if (code === 0) {
				resolve();
			} else {
				if (output && !options.stream) {
					console.error(output);
				}
				reject(new Error(`${cmd} ${args.join(" ")} failed with code ${code}`));
			}
		});

		child.on("error", reject);
	});
}

/**
 * Save a key backup file with appropriate warnings
 */
export async function saveKeyBackup(
	key: string,
	handle: string,
	kind: BackupKeyKind = "signing",
	details: string[] = [],
): Promise<string> {
	const text = KEY_BACKUP_TEXT[kind];
	const filename = `${text.filePrefix}-${handle.replace(/[^a-z0-9]/gi, "-")}.txt`;
	const filepath = join(process.cwd(), filename);

	const content = [
		"=".repeat(60),
		`${text.heading} BACKUP`,
		"=".repeat(60),
		"",
		`Handle: ${handle}`,
		`Created: ${new Date().toISOString()}`,
		...details,
		"",
		text.warning,
		"- Store this file in a secure location (password manager, encrypted drive)",
		"- Delete this file from your local disk after backing up",
		"- Never share this key with anyone",
		"- If compromised, your identity can be stolen",
		"",
		"=".repeat(60),
		`${text.name.toUpperCase()} (${text.encoding})`,
		"=".repeat(60),
		"",
		key,
		"",
		"=".repeat(60),
	].join("\n");

	await writeFile(filepath, content, { mode: 0o600 }); // Read/write only for owner
	return filepath;
}

/**
 * Ask how to back up a key (1Password, clipboard, file or on screen), do
 * it, and ask the user to confirm it is saved. Returns whether they
 * confirmed. With allowSkip, the user may decline to back it up.
 */
export async function promptKeyBackup(opts: {
	key: string;
	kind: BackupKeyKind;
	handle: string;
	details?: string[];
	allowSkip: boolean;
}): Promise<boolean> {
	const text = KEY_BACKUP_TEXT[opts.kind];
	const details = opts.details ?? [];
	const capitalised = text.name[0]!.toUpperCase() + text.name.slice(1);
	const showKey = () =>
		p.note(
			[
				`${text.name.toUpperCase()} (keep this secret!):`,
				"",
				opts.key,
				"",
				"Copy this to your password manager now.",
			].join("\n"),
			`🔑 Your ${text.label}`,
		);

	type BackupOption = "1password" | "copy" | "file" | "show" | "skip";
	const options: Array<{ value: BackupOption; label: string; hint: string }> =
		[];

	if (await is1PasswordAvailable()) {
		options.push({
			value: "1password",
			label: "Save to 1Password",
			hint: "recommended - uses op CLI",
		});
	}

	options.push(
		{
			value: "copy",
			label: "Copy to clipboard",
			hint: "paste into password manager",
		},
		{
			value: "file",
			label: "Save to file",
			hint: `${text.filePrefix}.txt`,
		},
		{
			value: "show",
			label: "Display it (I'll copy manually)",
			hint: "shown in terminal",
		},
	);

	if (opts.allowSkip) {
		options.push({
			value: "skip",
			label: "Skip (I understand the risk)",
			hint: "not recommended",
		});
	}

	const choice = await promptSelect<BackupOption>({
		message: `How would you like to back up your ${text.name}?`,
		options,
	});

	if (choice === "1password") {
		const spinner = p.spinner();
		spinner.start("Saving to 1Password...");
		const result = await saveTo1Password(
			opts.key,
			opts.handle,
			opts.kind,
			details,
		);
		if (result.success) {
			spinner.stop("Saved to 1Password");
			p.log.success(`Created: "${result.itemName}"`);
		} else {
			spinner.stop("Failed to save to 1Password");
			p.log.error(result.error || "Unknown error");
			p.log.info("Falling back to displaying the key...");
			showKey();
		}
	} else if (choice === "copy") {
		await copyToClipboard(opts.key);
		p.log.success(`${capitalised} copied to clipboard`);
		p.log.info("Paste it into your password manager now!");
	} else if (choice === "file") {
		const backupPath = await saveKeyBackup(
			opts.key,
			opts.handle,
			opts.kind,
			details,
		);
		p.log.success(`${capitalised} saved to: ${backupPath}`);
		p.log.warn(
			"Move this file to a secure location and delete the local copy!",
		);
	} else if (choice === "show") {
		showKey();
	}

	if (choice === "skip") {
		return false;
	}

	const confirmed = await promptConfirm({
		message: `Have you saved your ${text.name} securely?`,
		initialValue: true,
	});
	if (!confirmed) {
		p.log.warn("Please back up your key before continuing!");
		p.note(opts.key, `🔑 ${text.label}`);
	}
	return confirmed;
}
