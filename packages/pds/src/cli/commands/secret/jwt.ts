/**
 * JWT secret generation command
 */
import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import { generateJwtSecret, setSecretValue } from "../../utils/secrets.js";

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

		const secret = generateJwtSecret();

		try {
			await setSecretValue("JWT_SECRET", secret, args.local);
			p.outro(args.local ? "JWT_SECRET written to .dev.vars" : "Done!");
		} catch (error) {
			p.log.error(String(error));
			process.exit(1);
		}
	},
});
