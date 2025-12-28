/**
 * JWT secret generation command
 */
import { defineCommand } from "citty";
import { randomBytes } from "node:crypto";
import * as p from "@clack/prompts";
import { setSecret } from "../../utils/wrangler.js";
import { setDevVar } from "../../utils/dotenv.js";

export const jwtCommand = defineCommand({
	meta: {
		name: "jwt",
		description: "Generate and set JWT signing secret",
	},
	args: {
		local: {
			type: "boolean",
			description: "Write to .dev.vars instead of wrangler secrets",
			default: false,
		},
	},
	async run({ args }) {
		p.intro("Generate JWT Secret");

		const secret = randomBytes(32).toString("base64");

		if (args.local) {
			setDevVar("JWT_SECRET", secret);
			p.outro("JWT_SECRET written to .dev.vars");
		} else {
			const spinner = p.spinner();
			spinner.start("Setting JWT_SECRET via wrangler...");
			try {
				await setSecret("JWT_SECRET", secret);
				spinner.stop("JWT_SECRET set successfully");
				p.outro("Done!");
			} catch (error) {
				spinner.stop("Failed to set JWT_SECRET");
				p.log.error(String(error));
				process.exit(1);
			}
		}
	},
});
