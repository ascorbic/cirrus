import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import { Secp256k1Keypair } from "@atproto/crypto";
import { hash } from "bcryptjs";
import { randomBytes } from "node:crypto";
import { writeDevVars } from "../utils/dotenv.js";
import { setWranglerSecrets } from "../utils/wrangler.js";

export default defineCommand({
	meta: {
		name: "init",
		description: "Interactive setup wizard for your PDS",
	},
	args: {
		local: {
			type: "boolean",
			alias: "l",
			description: "Write to .dev.vars instead of wrangler secrets",
		},
		production: {
			type: "boolean",
			alias: "p",
			description: "Set via wrangler secrets (production mode)",
		},
	},
	async run({ args }) {
		p.intro("PDS Setup Wizard");

		// Prompt for hostname
		const hostname = await p.text({
			message: "Enter your PDS hostname",
			placeholder: "pds.example.com",
			validate: (v) => {
				if (!v) return "Hostname is required";
				if (v.includes("://")) return "Enter hostname only, not URL";
			},
		});
		if (p.isCancel(hostname)) {
			p.cancel("Cancelled");
			process.exit(0);
		}

		// Derive DID
		const did = `did:web:${hostname}`;
		p.note(`DID: ${did}`);

		// Prompt for handle
		const handle = await p.text({
			message: "Enter your handle",
			initialValue: hostname,
			validate: (v) => {
				if (!v) return "Handle is required";
			},
		});
		if (p.isCancel(handle)) {
			p.cancel("Cancelled");
			process.exit(0);
		}

		// Generate keypair
		const spin = p.spinner();
		spin.start("Generating signing keypair");
		const keypair = await Secp256k1Keypair.create({ exportable: true });
		const privateKeyBytes = await keypair.export();
		const privateKeyHex = Buffer.from(privateKeyBytes).toString("hex");
		const publicKeyMultibase = keypair.did().replace("did:key:", "");
		spin.stop("Signing keypair generated");

		// Generate JWT secret
		const jwtSecret = randomBytes(32).toString("base64");

		// Generate AUTH_TOKEN
		const authToken = randomBytes(32).toString("base64url");

		// Password (optional)
		const setPassword = await p.confirm({
			message: "Set a password for app login?",
			initialValue: true,
		});
		if (p.isCancel(setPassword)) {
			p.cancel("Cancelled");
			process.exit(0);
		}

		let passwordHash: string | undefined;
		if (setPassword) {
			const password = await p.password({
				message: "Enter password",
				validate: (v) => {
					if (v.length < 8) return "Password must be at least 8 characters";
				},
			});
			if (p.isCancel(password)) {
				p.cancel("Cancelled");
				process.exit(0);
			}

			const confirm = await p.password({ message: "Confirm password" });
			if (p.isCancel(confirm)) {
				p.cancel("Cancelled");
				process.exit(0);
			}

			if (password !== confirm) {
				p.cancel("Passwords do not match");
				process.exit(1);
			}

			spin.start("Hashing password");
			passwordHash = await hash(password, 10);
			spin.stop("Password hashed");
		}

		// Determine target
		let target: "local" | "production";
		if (args.local) {
			target = "local";
		} else if (args.production) {
			target = "production";
		} else {
			const choice = await p.select({
				message: "Where should secrets be stored?",
				options: [
					{ value: "local", label: "Local development (.dev.vars)" },
					{ value: "production", label: "Production (wrangler secrets)" },
				],
			});
			if (p.isCancel(choice)) {
				p.cancel("Cancelled");
				process.exit(0);
			}
			target = choice as "local" | "production";
		}

		const secrets: Record<string, string> = {
			DID: did,
			HANDLE: handle,
			PDS_HOSTNAME: hostname,
			AUTH_TOKEN: authToken,
			SIGNING_KEY: privateKeyHex,
			SIGNING_KEY_PUBLIC: publicKeyMultibase,
			JWT_SECRET: jwtSecret,
		};

		if (passwordHash) {
			secrets.PASSWORD_HASH = passwordHash;
		}

		if (target === "local") {
			writeDevVars(secrets);
			p.note("Secrets written to .dev.vars");
		} else {
			spin.start("Setting wrangler secrets");
			await setWranglerSecrets(secrets);
			spin.stop("Wrangler secrets configured");
		}

		p.outro("PDS setup complete!");
	},
});
