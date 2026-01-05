/**
 * Emit identity command - notifies relays to refresh handle verification
 */
import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import { getVars } from "../utils/wrangler.js";
import { readDevVars } from "../utils/dotenv.js";
import { PDSClient } from "../utils/pds-client.js";
import { getTargetUrl, getDomain } from "../utils/cli-helpers.js";

export const emitIdentityCommand = defineCommand({
	meta: {
		name: "emit-identity",
		description: "Emit an identity event to notify relays to refresh handle verification",
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

		p.intro("🦋 Emit Identity Event");

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
			if (!isDev) {
				p.log.info("Make sure your worker is deployed: wrangler deploy");
			}
			p.outro("Cancelled.");
			process.exit(1);
		}

		spinner.stop(`Connected to ${targetDomain}`);

		// Emit identity event
		spinner.start("Emitting identity event...");
		try {
			const result = await client.emitIdentity();
			spinner.stop(`Identity event emitted (seq: ${result.seq})`);
		} catch (err) {
			spinner.stop("Failed to emit identity event");
			p.log.error(
				err instanceof Error ? err.message : "Could not emit identity event",
			);
			p.outro("Failed.");
			process.exit(1);
		}

		p.log.success("Relays have been notified to refresh your handle verification.");
		p.outro("Done!");
	},
});
