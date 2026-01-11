/**
 * Generate a migration token for outbound migration
 *
 * Calls the PDS API to generate a stateless HMAC token that another PDS
 * can use to request a signed PLC operation. The token is valid for 15 minutes.
 */
import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { getVars } from "../utils/wrangler.js";
import { readDevVars } from "../utils/dotenv.js";
import {
	copyToClipboard,
	getTargetUrl,
	detectPackageManager,
	formatCommand,
} from "../utils/cli-helpers.js";
import { PDSClient } from "../utils/pds-client.js";

export const migrateTokenCommand = defineCommand({
	meta: {
		name: "migrate-token",
		description: "Generate a migration token for moving to another PDS",
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
		const pm = detectPackageManager();

		p.intro("Generate Migration Token");

		const spinner = p.spinner();

		// Load config
		spinner.start("Loading configuration...");
		const wranglerVars = getVars();
		const devVars = readDevVars();
		const config = { ...devVars, ...wranglerVars };

		const pdsHostname = config.PDS_HOSTNAME;
		const authToken = config.AUTH_TOKEN;

		if (!pdsHostname && !isDev) {
			spinner.stop("No PDS_HOSTNAME configured");
			p.log.error("Run 'pds init' first to set up your PDS.");
			p.outro("Token generation cancelled.");
			process.exit(1);
		}

		if (!authToken) {
			spinner.stop("No AUTH_TOKEN found");
			p.log.error("AUTH_TOKEN is required to authenticate with your PDS.");
			p.outro("Token generation cancelled.");
			process.exit(1);
		}

		// Get target PDS URL
		let targetUrl: string;
		try {
			targetUrl = getTargetUrl(isDev, pdsHostname);
		} catch (err) {
			spinner.stop("Configuration error");
			p.log.error(err instanceof Error ? err.message : "Configuration error");
			p.outro("Token generation cancelled.");
			process.exit(1);
		}

		spinner.stop("Configuration loaded");

		// Check PDS is running
		spinner.start("Connecting to PDS...");
		const pdsClient = new PDSClient(targetUrl, authToken);
		const isHealthy = await pdsClient.healthCheck();

		if (!isHealthy) {
			spinner.stop("PDS not responding");
			p.log.error(`Your PDS isn't responding at ${targetUrl}`);
			if (isDev) {
				p.log.info(`Start it with: ${formatCommand(pm, "dev")}`);
			} else {
				p.log.info(`Make sure your worker is deployed: ${formatCommand(pm, "deploy")}`);
			}
			p.outro("Token generation cancelled.");
			process.exit(1);
		}

		spinner.stop("Connected to PDS");

		// Request migration token from PDS
		spinner.start("Generating migration token...");
		const result = await pdsClient.getMigrationToken();

		if (!result.success || !result.token) {
			spinner.stop("Failed to generate token");
			p.log.error(result.error ?? "Could not generate migration token");
			p.outro("Token generation cancelled.");
			process.exit(1);
		}

		spinner.stop("Token generated");

		// Copy to clipboard
		const copied = await copyToClipboard(result.token);

		if (copied) {
			p.log.success("Migration token copied to clipboard!");
		} else {
			p.log.info("Could not copy to clipboard. Token:");
		}

		// Show token on its own line with no prefix for easy triple-click selection
		console.log("");
		console.log(pc.bold(result.token));
		console.log("");

		p.note(
			[
				"This token is valid for 15 minutes.",
				"",
				"Paste it into the new PDS when prompted for",
				"a migration/confirmation code.",
				"",
				"Once migration is complete, you can deactivate",
				"this PDS with: pnpm pds deactivate",
			].join("\n"),
			"Next Steps",
		);

		p.outro("Good luck with the migration!");
	},
});
