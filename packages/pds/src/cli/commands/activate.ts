/**
 * Activate account command - enables writes after migration
 */
import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import { getVars } from "../utils/wrangler.js";
import { readDevVars } from "../utils/dotenv.js";
import { PDSClient } from "../utils/pds-client.js";
import {
	getTargetUrl,
	getDomain,
	detectPackageManager,
	formatCommand,
} from "../utils/cli-helpers.js";

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
	},
	async run({ args }) {
		const pm = detectPackageManager();
		const isDev = args.dev;

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

		if (!authToken) {
			p.log.error("No AUTH_TOKEN found. Run 'pds init' first.");
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
			p.log.warn("Your account is already active!");
			p.log.info("No action needed - you're live in the Atmosphere. 🦋");
			p.outro("All good!");
			return;
		}

		// Show confirmation
		p.note(
			[
				`@${handle || "your-handle"}`,
				"",
				"This will enable writes and make your account live.",
				"Make sure you've:",
				"  ✓ Updated your DID document to point here",
				"  ✓ Completed email verification (if required)",
			].join("\n"),
			"Ready to go live?",
		);

		const confirm = await p.confirm({
			message: "Activate account?",
			initialValue: true,
		});

		if (p.isCancel(confirm) || !confirm) {
			p.cancel("Activation cancelled.");
			process.exit(0);
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

		// Ping the relay to request crawl
		const pdsHostname = config.PDS_HOSTNAME;
		if (pdsHostname && !isDev) {
			spinner.start("Notifying relay...");
			const relayPinged = await client.requestCrawl(pdsHostname);
			if (relayPinged) {
				spinner.stop("Relay notified");
			} else {
				spinner.stop("Could not notify relay");
				p.log.warn("The relay will discover your PDS when other users interact with you.");
			}
		}

		p.log.success("Welcome to the Atmosphere! 🦋");
		p.log.info("Your account is now live and accepting writes.");
		p.outro("All set!");
	},
});
