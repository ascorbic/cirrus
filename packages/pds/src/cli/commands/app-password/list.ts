/**
 * List app passwords command
 */
import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { getVars } from "../../utils/wrangler.js";
import { readDevVars } from "../../utils/dotenv.js";
import { PDSClient } from "../../utils/pds-client.js";
import { getTargetUrl, getDomain } from "../../utils/cli-helpers.js";

/**
 * Format a date as yyyy-mm-dd hh:mm
 */
function formatDateTime(isoString: string): string {
	const d = new Date(isoString);
	const year = d.getFullYear();
	const month = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	const hours = String(d.getHours()).padStart(2, "0");
	const minutes = String(d.getMinutes()).padStart(2, "0");
	return `${year}-${month}-${day} ${hours}:${minutes}`;
}

export const listCommand = defineCommand({
	meta: {
		name: "list",
		description: "List all app passwords",
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

		p.intro("🔑 App Passwords");

		// Get target URL
		const vars = getVars();
		let targetUrl: string;
		try {
			targetUrl = getTargetUrl(isDev, vars.PDS_HOSTNAME);
		} catch (err) {
			p.log.error(
				err instanceof Error ? err.message : "Configuration error",
			);
			p.log.info("Run 'pds init' first to configure your PDS.");
			process.exit(1);
		}

		const targetDomain = getDomain(targetUrl);

		// Load config
		const wranglerVars = getVars();
		const devVars = readDevVars();
		const config = { ...devVars, ...wranglerVars };

		const authToken = config.AUTH_TOKEN;

		if (!authToken) {
			p.log.error("No AUTH_TOKEN found. Run 'pds init' first.");
			p.outro("Cancelled.");
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
			p.outro("Cancelled.");
			process.exit(1);
		}

		spinner.stop(`Connected to ${targetDomain}`);

		// List app passwords
		spinner.start("Fetching app passwords...");
		let result: {
			passwords: Array<{ name: string; createdAt: string }>;
		};
		try {
			result = await client.listAppPasswords();
			spinner.stop("App passwords retrieved");
		} catch (err) {
			spinner.stop("Failed to fetch app passwords");
			p.log.error(
				err instanceof Error
					? err.message
					: "Could not fetch app passwords",
			);
			p.outro("Failed.");
			process.exit(1);
		}

		if (result.passwords.length === 0) {
			p.log.info("No app passwords.");
			p.log.info(
				`Run ${pc.cyan("pds app-password create")} to create one.`,
			);
		} else {
			p.log.info("");
			p.log.info(`${pc.bold("App passwords:")}`);
			p.log.info("");

			for (const pw of result.passwords) {
				const created = formatDateTime(pw.createdAt);
				console.log(`  ${pc.green("●")} ${pc.bold(pw.name)}`);
				console.log(`    ${pc.dim("Created:")} ${created}`);
				console.log("");
			}

			p.log.info(
				pc.dim(`Total: ${result.passwords.length} app password(s)`),
			);
		}

		p.outro("Done!");
	},
});
