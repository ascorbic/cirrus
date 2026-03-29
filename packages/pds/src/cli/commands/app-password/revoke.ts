/**
 * Revoke app password command
 */
import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import { getVars } from "../../utils/wrangler.js";
import { readDevVars } from "../../utils/dotenv.js";
import { PDSClient } from "../../utils/pds-client.js";
import { getTargetUrl, getDomain } from "../../utils/cli-helpers.js";

export const revokeCommand = defineCommand({
	meta: {
		name: "revoke",
		description: "Revoke an app password",
	},
	args: {
		dev: {
			type: "boolean",
			description: "Target local development server instead of production",
			default: false,
		},
		name: {
			type: "string",
			alias: "n",
			description: "Name of the app password to revoke",
		},
		yes: {
			type: "boolean",
			alias: "y",
			description: "Skip confirmation",
			default: false,
		},
	},
	async run({ args }) {
		const isDev = args.dev;
		const skipConfirm = args.yes;

		p.intro("🔑 Revoke App Password");

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

		// If no name provided, list and let user choose
		let passwordName = args.name;

		if (!passwordName) {
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
				p.log.info("No app passwords to revoke.");
				p.outro("Done!");
				return;
			}

			// Build options for selection
			const options = result.passwords.map((pw) => ({
				value: pw.name,
				label: pw.name,
				hint: `Created ${new Date(pw.createdAt).toLocaleDateString()}`,
			}));

			const selected = await p.select({
				message: "Select app password to revoke:",
				options,
			});

			if (p.isCancel(selected)) {
				p.cancel("Cancelled.");
				process.exit(0);
			}

			passwordName = selected;
		}

		// Confirm deletion
		if (!skipConfirm) {
			const confirm = await p.confirm({
				message: `Revoke app password "${passwordName}"? Any client using it will lose access.`,
				initialValue: false,
			});

			if (p.isCancel(confirm) || !confirm) {
				p.cancel("Cancelled.");
				process.exit(0);
			}
		}

		// Revoke the app password
		spinner.start("Revoking app password...");
		try {
			await client.revokeAppPassword(passwordName);
			spinner.stop("App password revoked");
			p.log.success(
				`App password "${passwordName}" has been revoked.`,
			);
		} catch (err) {
			spinner.stop("Failed to revoke app password");
			p.log.error(
				err instanceof Error
					? err.message
					: "Could not revoke app password",
			);
			p.outro("Failed.");
			process.exit(1);
		}

		p.outro("Done!");
	},
});
