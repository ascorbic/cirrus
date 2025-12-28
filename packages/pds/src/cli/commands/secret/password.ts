/**
 * Password hash generation command
 */
import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import {
	promptPassword,
	hashPassword,
	setSecretValue,
} from "../../utils/secrets.js";

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

		const password = await promptPassword();

		const spinner = p.spinner();
		spinner.start("Hashing password...");
		const passwordHash = await hashPassword(password);
		spinner.stop("Password hashed");

		try {
			await setSecretValue("PASSWORD_HASH", passwordHash, args.local);
			p.outro(args.local ? "PASSWORD_HASH written to .dev.vars" : "Done!");
		} catch (error) {
			p.log.error(String(error));
			process.exit(1);
		}
	},
});
