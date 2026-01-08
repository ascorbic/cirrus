/**
 * Remove passkey command
 */
import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { getVars } from "../../utils/wrangler.js";
import { readDevVars } from "../../utils/dotenv.js";
import { PDSClient } from "../../utils/pds-client.js";
import { getTargetUrl, getDomain } from "../../utils/cli-helpers.js";

export const removeCommand = defineCommand({
	meta: {
		name: "remove",
		description: "Remove a passkey from your account",
	},
	args: {
		dev: {
			type: "boolean",
			description: "Target local development server instead of production",
			default: false,
		},
		id: {
			type: "string",
			description: "Credential ID of the passkey to remove",
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

		p.intro("🔐 Remove Passkey");

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

		// If no ID provided, list passkeys and let user choose
		let credentialId = args.id;

		if (!credentialId) {
			spinner.start("Fetching passkeys...");
			let result: { passkeys: Array<{ id: string; name: string | null; createdAt: string; lastUsedAt: string | null }> };
			try {
				result = await client.listPasskeys();
				spinner.stop("Passkeys retrieved");
			} catch (err) {
				spinner.stop("Failed to fetch passkeys");
				p.log.error(
					err instanceof Error ? err.message : "Could not fetch passkeys",
				);
				p.outro("Failed.");
				process.exit(1);
			}

			if (result.passkeys.length === 0) {
				p.log.info("No passkeys to remove.");
				p.outro("Done!");
				return;
			}

			// Build options for selection
			const options = result.passkeys.map((pk) => ({
				value: pk.id,
				label: pk.name || "(unnamed)",
				hint: `Created ${new Date(pk.createdAt).toLocaleDateString()}`,
			}));

			const selected = await p.select({
				message: "Select passkey to remove:",
				options,
			});

			if (p.isCancel(selected)) {
				p.cancel("Cancelled.");
				process.exit(0);
			}

			credentialId = selected;
		}

		// Confirm deletion
		if (!skipConfirm) {
			const confirm = await p.confirm({
				message: `Remove this passkey? This cannot be undone.`,
				initialValue: false,
			});

			if (p.isCancel(confirm) || !confirm) {
				p.cancel("Cancelled.");
				process.exit(0);
			}
		}

		// Delete the passkey
		spinner.start("Removing passkey...");
		try {
			const result = await client.deletePasskey(credentialId);
			if (result.success) {
				spinner.stop("Passkey removed");
				p.log.success("Passkey has been removed from your account.");
			} else {
				spinner.stop("Failed to remove passkey");
				p.log.error("Passkey not found or could not be removed.");
			}
		} catch (err) {
			spinner.stop("Failed to remove passkey");
			p.log.error(
				err instanceof Error ? err.message : "Could not remove passkey",
			);
			p.outro("Failed.");
			process.exit(1);
		}

		p.outro("Done!");
	},
});
