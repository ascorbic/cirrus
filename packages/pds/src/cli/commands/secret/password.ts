/**
 * Password hash generation command
 */
import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import bcrypt from "bcryptjs";
import { setSecret } from "../../utils/wrangler.js";
import { setDevVar } from "../../utils/dotenv.js";

export const passwordCommand = defineCommand({
	meta: {
		name: "password",
		description: "Set account password (stored as bcrypt hash)",
	},
	args: {
		local: {
			type: "boolean",
			description: "Write to .dev.vars instead of wrangler secrets",
			default: false,
		},
	},
	async run({ args }) {
		p.intro("Set Account Password");

		const password = await p.password({
			message: "Enter password:",
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

		if (args.local) {
			setDevVar("PASSWORD_HASH", passwordHash);
			p.outro("PASSWORD_HASH written to .dev.vars");
		} else {
			spinner.start("Setting PASSWORD_HASH via wrangler...");
			try {
				await setSecret("PASSWORD_HASH", passwordHash);
				spinner.stop("PASSWORD_HASH set successfully");
				p.outro("Done!");
			} catch (error) {
				spinner.stop("Failed to set PASSWORD_HASH");
				p.log.error(String(error));
				process.exit(1);
			}
		}
	},
});
