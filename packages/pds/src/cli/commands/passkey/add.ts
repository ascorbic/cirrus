/**
 * Add passkey command
 *
 * Generates a registration URL for the user to visit on their device.
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
} from "../../utils/cli-helpers.js";

export const addCommand = defineCommand({
	meta: {
		name: "add",
		description: "Add a new passkey to your account",
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
			description: "Name for this passkey (e.g., 'iPhone', 'MacBook')",
		},
	},
	async run({ args }) {
		const isDev = args.dev;

		p.intro("🔐 Add Passkey");

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

		// Get passkey name
		let passkeyName: string | undefined = args.name;
		if (!passkeyName) {
			const nameInput = await promptText({
				message: "Name for this passkey (optional):",
				placeholder: "iPhone, MacBook, etc.",
			});
			passkeyName = nameInput || undefined;
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

		// Initialize passkey registration
		spinner.start("Generating registration link...");
		let registration: { token: string; url: string; expiresAt: number };
		try {
			registration = await client.initPasskeyRegistration(passkeyName);
			spinner.stop("Registration link ready");
		} catch (err) {
			spinner.stop("Failed to generate registration link");
			p.log.error(
				err instanceof Error ? err.message : "Could not generate registration link",
			);
			p.outro("Cancelled.");
			process.exit(1);
		}

		// Display the URL
		const expiresIn = Math.round((registration.expiresAt - Date.now()) / 1000 / 60);

		p.log.info("");
		p.log.info(pc.bold("Open this URL on the device where you want to add a passkey:"));
		p.log.info("");
		p.log.info(`  ${pc.cyan(registration.url)}`);
		p.log.info("");
		p.log.info(pc.dim(`This link expires in ${expiresIn} minutes.`));
		p.log.info("");

		// Wait for user to complete registration
		const done = await p.confirm({
			message: "Have you completed the registration on your device?",
			initialValue: false,
		});

		if (p.isCancel(done)) {
			p.cancel("Cancelled.");
			process.exit(0);
		}

		if (done) {
			// Verify by listing passkeys
			spinner.start("Verifying registration...");
			try {
				const result = await client.listPasskeys();
				const found = result.passkeys.some((pk) =>
					pk.name === passkeyName || (!passkeyName && pk.createdAt > new Date(Date.now() - 60000).toISOString())
				);
				if (found) {
					spinner.stop("Passkey registered successfully!");
					p.log.success("Your passkey is ready to use.");
				} else {
					spinner.stop("Registration not detected");
					p.log.warn("Could not verify registration. Check 'pds passkey list' to see your passkeys.");
				}
			} catch {
				spinner.stop("Could not verify registration");
				p.log.warn("Check 'pds passkey list' to see your passkeys.");
			}
		} else {
			p.log.info("You can register later using the URL above (if it hasn't expired).");
		}

		p.outro("Done!");
	},
});
