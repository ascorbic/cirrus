/**
 * Deactivate account command - disables writes for re-import
 */
import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { getVars } from "../utils/wrangler.js";
import { readDevVars } from "../utils/dotenv.js";
import { PDSClient } from "../utils/pds-client.js";
import {
	getTargetUrl,
	getDomain,
	detectPackageManager,
	formatCommand,
} from "../utils/cli-helpers.js";
import { resolveHandleToDid } from "../utils/handle-resolver.js";
import { DidResolver } from "../../did-resolver.js";

// Helper to override clack's dim styling in notes
const brightNote = (lines: string[]) => lines.map((l) => `\x1b[0m${l}`).join("\n");
const bold = (text: string) => pc.bold(text);

interface IdentityCheck {
	name: string;
	ok: boolean;
	message: string;
	detail?: string;
}

/**
 * Run identity verification checks - for deactivate, we just inform the user
 */
async function runIdentityChecks(
	handle: string,
	did: string,
	pdsUrl: string,
): Promise<IdentityCheck[]> {
	const checks: IdentityCheck[] = [];
	const expectedEndpoint = pdsUrl.replace(/\/$/, "");

	// Check 1: Handle resolution
	p.log.step("Checking handle resolution...");
	const resolvedDid = await resolveHandleToDid(handle);
	if (!resolvedDid) {
		checks.push({
			name: "Handle resolution",
			ok: false,
			message: `Handle @${handle} does not resolve to any DID`,
		});
	} else if (resolvedDid !== did) {
		checks.push({
			name: "Handle resolution",
			ok: false,
			message: `Handle @${handle} resolves to wrong DID`,
			detail: `Expected: ${did}\n  Got: ${resolvedDid}`,
		});
	} else {
		checks.push({
			name: "Handle resolution",
			ok: true,
			message: `@${handle} → ${did.slice(0, 24)}...`,
		});
	}

	// Check 2: DID document
	p.log.step("Checking DID document...");
	const didResolver = new DidResolver();
	const didDoc = await didResolver.resolve(did);
	if (!didDoc) {
		checks.push({
			name: "DID document",
			ok: false,
			message: `Could not resolve DID document for ${did}`,
		});
	} else {
		const pdsService = didDoc.service?.find((s) => {
			const types = Array.isArray(s.type) ? s.type : [s.type];
			return types.includes("AtprotoPersonalDataServer") || s.id === "#atproto_pds";
		}) as { serviceEndpoint?: string } | undefined;

		if (!pdsService?.serviceEndpoint) {
			checks.push({
				name: "DID document",
				ok: false,
				message: "DID document has no PDS service endpoint",
			});
		} else {
			const actualEndpoint = pdsService.serviceEndpoint.replace(/\/$/, "");
			if (actualEndpoint !== expectedEndpoint) {
				checks.push({
					name: "DID document",
					ok: false,
					message: "DID document points to different PDS",
					detail: `Current: ${actualEndpoint}`,
				});
			} else {
				checks.push({
					name: "DID document",
					ok: true,
					message: `PDS endpoint → ${expectedEndpoint}`,
				});
			}
		}
	}

	return checks;
}

export const deactivateCommand = defineCommand({
	meta: {
		name: "deactivate",
		description: "Deactivate your account to enable re-import",
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

		p.intro("🦋 Deactivate Account");

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
			p.outro("Deactivation cancelled.");
			process.exit(1);
		}

		if (!handle || !did) {
			p.log.error("No HANDLE or DID found. Run 'pds init' first.");
			p.outro("Deactivation cancelled.");
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
			p.outro("Deactivation cancelled.");
			process.exit(1);
		}

		spinner.stop(`Connected to ${targetDomain}`);

		// Get current account status
		spinner.start("Checking account status...");
		const status = await client.getAccountStatus();
		spinner.stop("Account status retrieved");

		// Check if already deactivated
		if (!status.active) {
			p.log.warn("Your account is already deactivated.");
			p.log.info("Writes are disabled. Use 'pds activate' to re-enable.");
			p.outro("Already deactivated.");
			return;
		}

		// Run identity checks to inform the user of current state
		p.log.info("");
		p.log.info(pc.bold("Current identity status:"));
		const checks = await runIdentityChecks(handle, did, targetUrl);

		// Display results
		for (const check of checks) {
			if (check.ok) {
				p.log.success(`${check.name}: ${check.message}`);
			} else {
				p.log.warn(`${check.name}: ${check.message}`);
				if (check.detail) {
					p.log.info(`  ${check.detail}`);
				}
			}
		}
		p.log.info("");

		// Show warning
		p.note(
			brightNote([
				bold(`⚠️  WARNING: This will disable writes for @${handle}`),
				"",
				"Your account will:",
				"  • Stop accepting new posts, follows, and other writes",
				"  • Remain readable in the Atmosphere",
				"  • Allow you to use 'pds migrate --clean' to re-import",
				"",
				bold("Only deactivate if you need to re-import your data."),
			]),
			"Deactivate Account",
		);

		if (!skipConfirm) {
			const confirm = await p.confirm({
				message: "Are you sure you want to deactivate?",
				initialValue: false,
			});

			if (p.isCancel(confirm) || !confirm) {
				p.cancel("Deactivation cancelled.");
				process.exit(0);
			}
		}

		// Deactivate
		spinner.start("Deactivating account...");
		try {
			await client.deactivateAccount();
			spinner.stop("Account deactivated");
		} catch (err) {
			spinner.stop("Deactivation failed");
			p.log.error(
				err instanceof Error ? err.message : "Could not deactivate account",
			);
			p.outro("Deactivation failed.");
			process.exit(1);
		}

		p.log.success("Account deactivated");
		p.log.info("Writes are now disabled.");
		p.log.info("");
		p.log.info("To re-import your data:");
		p.log.info(`  ${formatCommand(pm, "pds", "migrate", "--clean")}`);
		p.log.info("");
		p.log.info("To re-enable writes:");
		p.log.info(`  ${formatCommand(pm, "pds", "activate")}`);
		p.outro("Deactivated.");
	},
});
