/**
 * List passkeys command
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
		description: "List all registered passkeys",
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

		p.intro("🔐 Passkeys");

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

		// List passkeys
		spinner.start("Fetching passkeys...");
		let result: {
			passkeys: Array<{
				id: string;
				name: string | null;
				createdAt: string;
				lastUsedAt: string | null;
			}>;
		};
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
			p.log.info("No passkeys registered.");
			p.log.info(`Run ${pc.cyan("pds passkey add")} to register a passkey.`);
		} else {
			p.log.info("");
			p.log.info(`${pc.bold("Registered passkeys:")}`);
			p.log.info("");

			for (const pk of result.passkeys) {
				const name = pk.name || pc.dim("(unnamed)");
				const created = formatDateTime(pk.createdAt);
				const lastUsed = pk.lastUsedAt
					? formatDateTime(pk.lastUsedAt)
					: pc.dim("never");
				const idPreview = pk.id.slice(0, 16) + "...";

				console.log(`  ${pc.green("●")} ${pc.bold(name)}`);
				console.log(`    ${pc.dim("ID:")} ${idPreview}`);
				console.log(
					`    ${pc.dim("Created:")} ${created}  ${pc.dim("Last used:")} ${lastUsed}`,
				);
				console.log("");
			}

			p.log.info(pc.dim(`Total: ${result.passkeys.length} passkey(s)`));
		}

		p.outro("Done!");
	},
});
