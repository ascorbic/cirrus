/**
 * Add passkey command
 *
 * Generates a registration URL for the user to visit on their device.
 */
import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import pc from "picocolors";
import QRCode from "qrcode";
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
		} catch (err: unknown) {
			spinner.stop("Failed to generate registration link");
			// Extract detailed error message
			let errorMessage = "Could not generate registration link";
			if (err instanceof Error) {
				errorMessage = err.message;
			}
			// Check for ClientResponseError with data.message
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

		// Display the URL and QR code
		const expiresIn = Math.round(
			(registration.expiresAt - Date.now()) / 1000 / 60,
		);

		p.log.info("");
		p.log.info(pc.bold("Scan this QR code on your phone, or open the URL:"));
		p.log.info("");

		// Generate QR code for terminal
		const qrString = await QRCode.toString(registration.url, {
			type: "terminal",
			small: true,
		});
		console.log(qrString);

		p.log.info(`  ${pc.cyan(registration.url)}`);
		p.log.info("");
		p.log.info(pc.dim(`This link expires in ${expiresIn} minutes.`));
		p.log.info("");

		// Wait for user to complete registration
		const done = await p.text({
			message: "Press Enter when you've completed registration on your device",
			placeholder: "(or Ctrl+C to cancel)",
			defaultValue: "",
		});

		if (p.isCancel(done)) {
			p.cancel("Cancelled.");
			process.exit(0);
		}

		// Verify by listing passkeys
		spinner.start("Verifying registration...");
		try {
			const result = await client.listPasskeys();
			// Check for any passkey created in the last 2 minutes
			// SQLite stores datetime as "YYYY-MM-DD HH:MM:SS" (UTC), so parse it properly
			const twoMinutesAgo = Date.now() - 2 * 60 * 1000;
			const found = result.passkeys.some((pk) => {
				// Handle both SQLite format and ISO format
				const createdTime = new Date(
					pk.createdAt.replace(" ", "T") + "Z",
				).getTime();
				return createdTime > twoMinutesAgo;
			});
			if (found) {
				spinner.stop("Passkey registered successfully!");
				p.log.success("Your passkey is ready to use.");
			} else {
				spinner.stop("Registration not detected");
				p.log.warn(
					"Could not verify registration. Check 'pds passkey list' to see your passkeys.",
				);
			}
		} catch {
			spinner.stop("Could not verify registration");
			p.log.warn("Check 'pds passkey list' to see your passkeys.");
		}

		p.outro("Done!");
	},
});
