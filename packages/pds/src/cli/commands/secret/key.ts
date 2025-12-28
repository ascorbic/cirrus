/**
 * Signing key generation command
 */
import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import {
	generateSigningKeypair,
	setSecretValue,
	setPublicVar,
} from "../../utils/secrets.js";

export const keyCommand = defineCommand({
	meta: {
		name: "key",
		description: "Generate and set signing keypair",
	},
	args: {
		local: {
			type: "boolean",
			description: "Write to .dev.vars instead of wrangler secrets/config",
			default: false,
		},
	},
	async run({ args }) {
		p.intro("Generate Signing Keypair");

		const spinner = p.spinner();
		spinner.start("Generating secp256k1 keypair...");

		const { privateKey, publicKey } = await generateSigningKeypair();

		spinner.stop("Keypair generated");

		try {
			await setSecretValue("SIGNING_KEY", privateKey, args.local);
			setPublicVar("SIGNING_KEY_PUBLIC", publicKey, args.local);

			p.log.info("Public key (for DID document): " + publicKey);
			p.outro(
				args.local
					? "SIGNING_KEY and SIGNING_KEY_PUBLIC written to .dev.vars"
					: "Done!",
			);
		} catch (error) {
			p.log.error(String(error));
			process.exit(1);
		}
	},
});
