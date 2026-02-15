/**
 * Activate account command - enables writes after migration
 */
import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import type { Did } from "@atcute/lexicons";
import pc from "picocolors";
import { getVars } from "../utils/wrangler.js";
import { readDevVars } from "../utils/dotenv.js";
import { PDSClient, type MigrationStatus } from "../utils/pds-client.js";
import {
	getTargetUrl,
	getDomain,
	detectPackageManager,
	formatCommand,
	promptText,
} from "../utils/cli-helpers.js";
import {
	checkHandleResolution,
	checkDidDocument,
	checkRepoComplete,
	type CheckResult,
} from "../utils/checks.js";

interface Check {
	name: string;
	ok: boolean;
	message: string;
	detail?: string;
}

/**
 * Run pre-activation checks
 */
async function runChecks(
	handle: string,
	did: string,
	pdsUrl: string,
	status: MigrationStatus,
): Promise<Check[]> {
	const checks: Check[] = [];

	// Check 1: Handle resolves to correct DID
	p.log.step("Checking handle resolution...");
	const handleResult = await checkHandleResolution(handle, did);
	checks.push({ name: "Handle", ...handleResult });

	// Check 2: DID document points to this PDS
	p.log.step("Checking DID document...");
	const didResult = await checkDidDocument(did, pdsUrl);
	checks.push({ name: "DID", ...didResult });

	// Check 3: Repo is complete (has records and all blobs imported)
	p.log.step("Checking repo status...");
	const repoResult = checkRepoComplete(status);
	checks.push({ name: "Repo", ...repoResult });

	return checks;
}

function logCheck(check: Check): void {
	const icon = check.ok ? pc.green("✓") : pc.red("✗");
	const name = pc.bold(check.name.padEnd(8));
	console.log(`  ${icon} ${name} ${check.message}`);
	if (check.detail && !check.ok) {
		for (const line of check.detail.split("\n")) {
			console.log(`             ${pc.dim(line)}`);
		}
	}
}

/**
 * Prompt user to create a profile if one doesn't exist
 */
async function promptCreateProfile(
	client: PDSClient,
	did: Did,
	handle: string | undefined,
): Promise<void> {
	const spinner = p.spinner();

	spinner.start("Checking profile...");
	const existingProfile = await client.getProfile(did);
	spinner.stop(existingProfile ? "Profile found" : "No profile found");

	if (!existingProfile) {
		const createProfile = await p.confirm({
			message: "Create a profile? (recommended for visibility on the network)",
			initialValue: true,
		});

		if (p.isCancel(createProfile)) {
			p.cancel("Cancelled.");
			process.exit(0);
		}

		if (createProfile) {
			const displayName = await promptText({
				message: "Display name:",
				placeholder: handle || "Your Name",
				validate: (v) => {
					if (v && v.length > 64)
						return "Display name must be 64 characters or less";
					return undefined;
				},
			});

			const description = await promptText({
				message: "Bio (optional):",
				placeholder: "Tell us about yourself",
				validate: (v) => {
					if (v && v.length > 256) return "Bio must be 256 characters or less";
					return undefined;
				},
			});

			spinner.start("Creating profile...");
			try {
				await client.putProfile(did, {
					displayName: displayName || undefined,
					description: description || undefined,
				});
				spinner.stop("Profile created!");
			} catch (err) {
				spinner.stop("Failed to create profile");
				p.log.warn(
					err instanceof Error ? err.message : "Could not create profile",
				);
			}
		}
	}
}

export const activateCommand = defineCommand({
	meta: {
		name: "activate",
		description: "Activate your account to enable writes and go live",
	},
	args: {
		dev: {
			type: "boolean",
			description: "Target local development server instead of production",
			default: false,
		},
		yes: {
			type: "boolean",
			alias: "y",
			description: "Skip confirmation prompts",
			default: false,
		},
	},
	async run({ args }) {
		const pm = detectPackageManager();
		const isDev = args.dev;
		const skipConfirm = args.yes;

		p.intro("🦋 Activate Account");

		// Get target URL
		const vars = getVars();
		let targetUrl: string;
		try {
			targetUrl = getTargetUrl(isDev, vars.PDS_HOSTNAME);
		} catch (err) {
			p.log.error(err instanceof Error ? err.message : "Configuration error");
			p.log.info("Run 'pds init' first to configure your PDS.");
			process.exit(1);
		}

		const targetDomain = getDomain(targetUrl);

		// Load config
		const wranglerVars = getVars();
		const devVars = readDevVars();
		const config = { ...devVars, ...wranglerVars };

		const authToken = config.AUTH_TOKEN;
		const handle = config.HANDLE;
		const did = config.DID;

		if (!authToken) {
			p.log.error("No AUTH_TOKEN found. Run 'pds init' first.");
			p.outro("Activation cancelled.");
			process.exit(1);
		}

		if (!handle || !did) {
			p.log.error("No HANDLE or DID found. Run 'pds init' first.");
			p.outro("Activation cancelled.");
			process.exit(1);
		}

		// Create client
		const client = new PDSClient(targetUrl, authToken);

		// Check if PDS is reachable
		const spinner = p.spinner();
		spinner.start(`Checking PDS at ${targetDomain}...`);

		const isHealthy = await client.healthCheck();
		if (!isHealthy) {
			spinner.stop(`PDS not responding at ${targetDomain}`);
			p.log.error(`Your PDS isn't responding at ${targetUrl}`);
			if (!isDev) {
				p.log.info(
					`Make sure your worker is deployed: ${formatCommand(pm, "deploy")}`,
				);
			}
			p.outro("Activation cancelled.");
			process.exit(1);
		}

		spinner.stop(`Connected to ${targetDomain}`);

		// Get current account status
		spinner.start("Checking account status...");
		const status = await client.getAccountStatus();
		spinner.stop("Account status retrieved");

		// Check if already active
		if (status.active) {
			p.log.info("Your account is already active.");

			// Check if profile exists and offer to create one
			await promptCreateProfile(client, did as Did, handle);

			// Offer to ping the relay
			const pdsHostname = config.PDS_HOSTNAME;
			if (pdsHostname && !isDev) {
				const pingRelay = await p.confirm({
					message: "Notify the relay? (useful if posts aren't being indexed)",
					initialValue: false,
				});

				if (p.isCancel(pingRelay)) {
					p.cancel("Cancelled.");
					process.exit(0);
				}

				if (pingRelay) {
					spinner.start("Requesting crawl from relay...");
					const crawlOk = await client.requestCrawl(pdsHostname);
					if (crawlOk) {
						spinner.stop("Crawl requested");
					} else {
						spinner.stop("Could not request crawl");
					}
				}
			}

			p.outro("All good!");
			return;
		}

		// Run pre-activation checks
		p.log.info("");
		p.log.info(pc.bold("Pre-activation checks:"));
		const checks = await runChecks(handle, did, targetUrl, status);

		// Display results
		console.log("");
		for (const check of checks) {
			logCheck(check);
		}
		console.log("");

		const hasFailures = checks.some((c) => !c.ok);

		// Handle failures
		if (hasFailures) {
			p.log.warn(
				pc.yellow("Some checks failed. Activating now may cause issues."),
			);
			p.log.info("");

			if (skipConfirm) {
				p.log.info("Proceeding anyway (--yes flag)");
			} else {
				const proceed = await p.confirm({
					message: "Proceed with activation anyway?",
					initialValue: false,
				});

				if (p.isCancel(proceed) || !proceed) {
					p.cancel("Activation cancelled. Fix the issues above and try again.");
					process.exit(0);
				}
			}
		} else {
			// All checks passed
			if (!skipConfirm) {
				const confirm = await p.confirm({
					message: "Activate account?",
					initialValue: true,
				});

				if (p.isCancel(confirm) || !confirm) {
					p.cancel("Activation cancelled.");
					process.exit(0);
				}
			}
		}

		// Activate
		spinner.start("Activating account...");
		try {
			await client.activateAccount();
			spinner.stop("Account activated!");
		} catch (err) {
			spinner.stop("Activation failed");
			p.log.error(
				err instanceof Error ? err.message : "Could not activate account",
			);
			p.outro("Activation failed.");
			process.exit(1);
		}

		// Check if profile exists and offer to create one
		await promptCreateProfile(client, did as Did, handle);

		// Verify activation worked
		spinner.start("Verifying activation...");
		const postStatus = await client.getAccountStatus();
		if (!postStatus.active) {
			spinner.stop("Verification failed");
			p.log.error("Account was activated but is not showing as active.");
			p.log.info("Try running 'pds status' to check the current state.");
			p.outro("Activation may have failed.");
			process.exit(1);
		}
		spinner.stop("Account is active");

		// Request crawl from relay
		const pdsHostname = config.PDS_HOSTNAME;
		if (pdsHostname && !isDev) {
			spinner.start("Requesting crawl from relay...");
			const crawlOk = await client.requestCrawl(pdsHostname);
			if (crawlOk) {
				spinner.stop("Crawl requested");
			} else {
				spinner.stop("Could not request crawl");
				p.log.warn(
					"Run 'pds activate' again later to retry requesting a crawl.",
				);
			}
		}

		p.log.success("Welcome to the Atmosphere! 🦋");
		p.log.info("Your account is now live and accepting writes.");

		// Offer to emit identity if checks passed
		if (!hasFailures) {
			p.log.info("");
			let shouldEmit = skipConfirm;
			if (!skipConfirm) {
				const emitConfirm = await p.confirm({
					message: "Emit identity event to notify relays?",
					initialValue: true,
				});
				shouldEmit = !p.isCancel(emitConfirm) && emitConfirm;
			}

			if (shouldEmit) {
				spinner.start("Emitting identity event...");
				try {
					const result = await client.emitIdentity();
					spinner.stop(`Identity event emitted (seq: ${result.seq})`);
				} catch (err) {
					spinner.stop("Failed to emit identity event");
					p.log.warn(
						err instanceof Error ? err.message : "Could not emit identity",
					);
					p.log.info("You can try again later with: pds emit-identity");
				}
			} else {
				p.log.info("To notify relays later, run: pds emit-identity");
			}
		} else {
			p.log.info("");
			p.log.info(
				"Some checks failed, so identity was not emitted automatically.",
			);
			p.log.info("Once your handle and DID are configured correctly, run:");
			p.log.info("  pds emit-identity");
		}

		p.outro("All set!");
	},
});
