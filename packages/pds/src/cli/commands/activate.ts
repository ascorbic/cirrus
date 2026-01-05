/**
 * Activate account command - enables writes after migration
 */
import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { getVars } from "../utils/wrangler.js";
import { readDevVars } from "../utils/dotenv.js";
import { PDSClient, type MigrationStatus } from "../utils/pds-client.js";
import {
	getTargetUrl,
	getDomain,
	detectPackageManager,
	formatCommand,
} from "../utils/cli-helpers.js";
import { resolveHandleToDid } from "../utils/handle-resolver.js";
import { DidResolver } from "../../did-resolver.js";

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
	const expectedEndpoint = pdsUrl.replace(/\/$/, "");

	// Check 1: Handle resolves to correct DID
	p.log.step("Checking handle resolution...");
	const resolvedDid = await resolveHandleToDid(handle);
	if (!resolvedDid) {
		checks.push({
			name: "Handle",
			ok: false,
			message: `@${handle} does not resolve to any DID`,
			detail: "Update your DNS TXT record or .well-known/atproto-did file",
		});
	} else if (resolvedDid !== did) {
		checks.push({
			name: "Handle",
			ok: false,
			message: `@${handle} resolves to wrong DID`,
			detail: `Expected: ${did}\n  Got: ${resolvedDid}`,
		});
	} else {
		checks.push({
			name: "Handle",
			ok: true,
			message: `@${handle} → ${did.slice(0, 24)}...`,
		});
	}

	// Check 2: DID document points to this PDS
	p.log.step("Checking DID document...");
	const didResolver = new DidResolver();
	const didDoc = await didResolver.resolve(did);
	if (!didDoc) {
		checks.push({
			name: "DID",
			ok: false,
			message: `Could not resolve DID document for ${did}`,
			detail: "Make sure your DID is published to the PLC directory or did:web endpoint",
		});
	} else {
		const pdsService = didDoc.service?.find((s) => {
			const types = Array.isArray(s.type) ? s.type : [s.type];
			return types.includes("AtprotoPersonalDataServer") || s.id === "#atproto_pds";
		}) as { serviceEndpoint?: string } | undefined;

		if (!pdsService?.serviceEndpoint) {
			checks.push({
				name: "DID",
				ok: false,
				message: "DID document has no PDS service endpoint",
				detail: "Update your DID document to include an AtprotoPersonalDataServer service",
			});
		} else {
			const actualEndpoint = pdsService.serviceEndpoint.replace(/\/$/, "");
			if (actualEndpoint !== expectedEndpoint) {
				checks.push({
					name: "DID",
					ok: false,
					message: "DID document points to different PDS",
					detail: `Expected: ${expectedEndpoint}\n  Got: ${actualEndpoint}`,
				});
			} else {
				checks.push({
					name: "DID",
					ok: true,
					message: `PDS endpoint → ${expectedEndpoint}`,
				});
			}
		}
	}

	// Check 3: Repo is complete (all blobs imported)
	p.log.step("Checking repo status...");
	const missingBlobs = status.expectedBlobs - status.importedBlobs;
	if (missingBlobs > 0) {
		checks.push({
			name: "Repo",
			ok: false,
			message: `${missingBlobs} blob${missingBlobs === 1 ? "" : "s"} missing`,
			detail: "Run 'pds migrate' to import missing blobs before activating",
		});
	} else if (!status.repoCommit) {
		checks.push({
			name: "Repo",
			ok: false,
			message: "No repo data imported",
			detail: "Run 'pds migrate' to import your repository first",
		});
	} else {
		checks.push({
			name: "Repo",
			ok: true,
			message: `${status.repoBlocks} blocks, ${status.importedBlobs} blobs`,
		});
	}

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
				p.log.info(`Make sure your worker is deployed: ${formatCommand(pm, "deploy")}`);
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
					spinner.start("Notifying relay...");
					const relayPinged = await client.requestCrawl(pdsHostname);
					if (relayPinged) {
						spinner.stop("Relay notified");
					} else {
						spinner.stop("Could not notify relay");
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

		// Ping the relay to request crawl
		const pdsHostname = config.PDS_HOSTNAME;
		if (pdsHostname && !isDev) {
			spinner.start("Notifying relay...");
			const relayPinged = await client.requestCrawl(pdsHostname);
			if (relayPinged) {
				spinner.stop("Relay notified");
			} else {
				spinner.stop("Could not notify relay");
				p.log.warn("Run 'pds activate' again later to retry notifying the relay.");
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
			p.log.info(
				"Once your handle and DID are configured correctly, run:",
			);
			p.log.info("  pds emit-identity");
		}

		p.outro("All set!");
	},
});
