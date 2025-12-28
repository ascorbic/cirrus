/**
 * Interactive PDS setup wizard
 */
import { defineCommand } from "citty";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import * as p from "@clack/prompts";
import { Secp256k1Keypair } from "@atproto/crypto";
import bcrypt from "bcryptjs";
import { setSecret, setVars, getVars } from "../utils/wrangler.js";
import { readDevVars, writeDevVars } from "../utils/dotenv.js";

/**
 * Run wrangler types to regenerate TypeScript types
 */
function runWranglerTypes(): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn("wrangler", ["types"], {
			stdio: "inherit",
		});

		child.on("close", (code) => {
			if (code === 0) {
				resolve();
			} else {
				reject(new Error(`wrangler types failed with code ${code}`));
			}
		});

		child.on("error", reject);
	});
}

export const initCommand = defineCommand({
	meta: {
		name: "init",
		description: "Interactive PDS setup wizard",
	},
	args: {
		local: {
			type: "boolean",
			description: "Write to .dev.vars instead of wrangler secrets/config",
			default: false,
		},
	},
	async run({ args }) {
		p.intro("PDS Setup Wizard");

		// Get current config
		const currentVars = args.local ? readDevVars() : getVars();

		// Prompt for hostname
		const hostname = await p.text({
			message: "PDS hostname:",
			placeholder: "pds.example.com",
			initialValue: currentVars.PDS_HOSTNAME || "",
			validate: (v) => (!v ? "Hostname is required" : undefined),
		});
		if (p.isCancel(hostname)) {
			p.cancel("Cancelled");
			process.exit(0);
		}

		// Prompt for handle
		const handle = await p.text({
			message: "Account handle:",
			placeholder: "alice." + hostname,
			initialValue: currentVars.HANDLE || "",
			validate: (v) => (!v ? "Handle is required" : undefined),
		});
		if (p.isCancel(handle)) {
			p.cancel("Cancelled");
			process.exit(0);
		}

		// Prompt for DID
		const didDefault = "did:web:" + hostname;
		const did = await p.text({
			message: "Account DID:",
			placeholder: didDefault,
			initialValue: currentVars.DID || didDefault,
			validate: (v) => {
				if (!v) return "DID is required";
				if (!v.startsWith("did:")) return "DID must start with did:";
				return undefined;
			},
		});
		if (p.isCancel(did)) {
			p.cancel("Cancelled");
			process.exit(0);
		}

		// Prompt for password
		const password = await p.password({
			message: "Account password:",
		});
		if (p.isCancel(password)) {
			p.cancel("Cancelled");
			process.exit(0);
		}

		const confirm = await p.password({
			message: "Confirm password:",
		});
		if (p.isCancel(confirm)) {
			p.cancel("Cancelled");
			process.exit(0);
		}

		if (password !== confirm) {
			p.log.error("Passwords do not match");
			process.exit(1);
		}

		const spinner = p.spinner();
		spinner.start("Hashing password...");
		const passwordHash = await bcrypt.hash(password, 10);
		spinner.stop("Password hashed");

		spinner.start("Generating JWT secret...");
		const jwtSecret = randomBytes(32).toString("base64");
		spinner.stop("JWT secret generated");

		spinner.start("Generating auth token...");
		const authToken = randomBytes(32).toString("base64url");
		spinner.stop("Auth token generated");

		spinner.start("Generating signing keypair...");
		const keypair = await Secp256k1Keypair.create({ exportable: true });
		const signingKey = JSON.stringify(await keypair.export());
		const signingKeyPublic = keypair.did().replace("did:key:", "");
		spinner.stop("Signing keypair generated");

		// Save everything
		if (args.local) {
			spinner.start("Writing to .dev.vars...");
			writeDevVars({
				PDS_HOSTNAME: hostname,
				DID: did,
				HANDLE: handle,
				SIGNING_KEY_PUBLIC: signingKeyPublic,
				AUTH_TOKEN: authToken,
				SIGNING_KEY: signingKey,
				JWT_SECRET: jwtSecret,
				PASSWORD_HASH: passwordHash,
			});
			spinner.stop("Written to .dev.vars");
		} else {
			// Set vars in wrangler.jsonc
			spinner.start("Updating wrangler.jsonc...");
			setVars({
				PDS_HOSTNAME: hostname,
				DID: did,
				HANDLE: handle,
				SIGNING_KEY_PUBLIC: signingKeyPublic,
			});
			spinner.stop("wrangler.jsonc updated");

			// Set secrets via wrangler
			spinner.start("Setting AUTH_TOKEN...");
			await setSecret("AUTH_TOKEN", authToken);
			spinner.stop("AUTH_TOKEN set");

			spinner.start("Setting SIGNING_KEY...");
			await setSecret("SIGNING_KEY", signingKey);
			spinner.stop("SIGNING_KEY set");

			spinner.start("Setting JWT_SECRET...");
			await setSecret("JWT_SECRET", jwtSecret);
			spinner.stop("JWT_SECRET set");

			spinner.start("Setting PASSWORD_HASH...");
			await setSecret("PASSWORD_HASH", passwordHash);
			spinner.stop("PASSWORD_HASH set");
		}

		// Generate TypeScript types
		spinner.start("Generating TypeScript types...");
		try {
			await runWranglerTypes();
			spinner.stop("TypeScript types generated");
		} catch {
			spinner.stop("Failed to generate types (wrangler types)");
		}

		p.note(
			[
				"Configuration summary:",
				"",
				"  PDS_HOSTNAME: " + hostname,
				"  DID: " + did,
				"  HANDLE: " + handle,
				"  SIGNING_KEY_PUBLIC: " + signingKeyPublic,
				"",
				"Auth token (save this!):",
				"  " + authToken,
			].join("\n"),
			"Setup Complete",
		);

		p.outro("Your PDS is configured! Run 'wrangler deploy' to deploy.");
	},
});
