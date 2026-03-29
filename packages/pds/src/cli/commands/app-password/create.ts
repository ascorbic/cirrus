/**
 * Create app password command
 */
import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { getVars } from "../../utils/wrangler.js";
import { readDevVars } from "../../utils/dotenv.js";
import { PDSClient } from "../../utils/pds-client.js";
import {
	getTargetUrl,
	getDomain,
	promptText,
	copyToClipboard,
} from "../../utils/cli-helpers.js";

export const createCommand = defineCommand({
	meta: {
		name: "create",
		description: "Create a new app password",
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
			description:
				"Name for this app password (e.g., 'Graysky', 'Croissant')",
		},
	},
	async run({ args }) {
		const isDev = args.dev;

		p.intro("🔑 Create App Password");

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

		// Get name
		let passwordName: string | undefined = args.name;
		if (!passwordName) {
			const nameInput = await promptText({
				message: "Name for this app password:",
				placeholder: "Graysky, Croissant, etc.",
			});
			if (!nameInput) {
				p.cancel("Name is required.");
				process.exit(1);
			}
			passwordName = nameInput;
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

		// Create app password
		spinner.start("Creating app password...");
		let result: { name: string; password: string; createdAt: string };
		try {
			result = await client.createAppPassword(passwordName);
			spinner.stop("App password created");
		} catch (err: unknown) {
			spinner.stop("Failed to create app password");
			let errorMessage = "Could not create app password";
			if (err instanceof Error) {
				errorMessage = err.message;
			}
			const errObj = err as { data?: { message?: string; error?: string } };
			if (errObj?.data?.message) {
				errorMessage = errObj.data.message;
			} else if (errObj?.data?.error) {
				errorMessage = errObj.data.error;
			}
			p.log.error(errorMessage);
			p.outro("Cancelled.");
			process.exit(1);
		}

		// Display the password
		p.log.info("");
		p.log.success(
			`App password ${pc.bold(`"${result.name}"`)} created.`,
		);
		p.log.info("");
		p.note(result.password, "App Password");
		p.log.info("");

		// Try to copy to clipboard
		const copied = await copyToClipboard(result.password);
		if (copied) {
			p.log.info(pc.dim("Copied to clipboard."));
		}

		p.log.warn(
			"This password will not be shown again. Save it now.",
		);

		p.outro("Done!");
	},
});
