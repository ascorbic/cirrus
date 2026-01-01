/**
 * Deactivate account command - disables writes for re-import
 */
import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { getVars } from "../utils/wrangler.js";
import { readDevVars } from "../utils/dotenv.js";
import { PDSClient } from "../utils/pds-client.js";
import { getTargetUrl, getDomain } from "../utils/cli-helpers.js";

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
	},
	async run({ args }) {
		const isDev = args.dev;

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

		if (!authToken) {
			p.log.error("No AUTH_TOKEN found. Run 'pds init' first.");
			p.outro("Deactivation cancelled.");
			process.exit(1);
		}

		// Create client
		const client = new PDSClient(targetUrl, authToken);

		// Check if PDS is reachable
		const spinner = p.spinner();
		spinner.start(`Checking PDS at ${pc.cyan(targetDomain)}...`);

		const isHealthy = await client.healthCheck();
		if (!isHealthy) {
			spinner.error(`PDS not responding at ${targetDomain}`);
			p.log.error(`Your PDS isn't responding at ${targetUrl}`);
			if (!isDev) {
				p.log.info("Make sure your worker is deployed: wrangler deploy");
			}
			p.outro("Deactivation cancelled.");
			process.exit(1);
		}

		spinner.stop(`Connected to ${pc.cyan(targetDomain)}`);

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

		// Show warning
		p.box(
			[
				pc.yellow(pc.bold(`⚠️  WARNING: This will disable writes for @${handle || "your-handle"}`)),
				"",
				"Your account will:",
				"  • Stop accepting new posts, follows, and other writes",
				"  • Remain readable in the Atmosphere",
				"  • Allow you to use 'pds migrate --clean' to re-import",
				"",
				pc.bold("Only deactivate if you need to re-import your data."),
			].join("\n"),
			"Deactivate Account",
		);

		const confirm = await p.confirm({
			message: "Are you sure you want to deactivate?",
			initialValue: false,
		});

		if (p.isCancel(confirm) || !confirm) {
			p.cancel("Deactivation cancelled.");
			process.exit(0);
		}

		// Deactivate
		spinner.start("Deactivating account...");
		try {
			await client.deactivateAccount();
			spinner.stop(pc.green("Account deactivated"));
		} catch (err) {
			spinner.error("Deactivation failed");
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
		p.log.info(`  ${pc.cyan("pnpm pds migrate --clean")}`);
		p.log.info("");
		p.log.info("To re-enable writes:");
		p.log.info(`  ${pc.cyan("pnpm pds activate")}`);
		p.outro("Deactivated.");
	},
});
