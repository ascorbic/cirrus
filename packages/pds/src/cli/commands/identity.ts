/**
 * Identity command - update DID document to point to new PDS
 *
 * This command handles the PLC operation flow for migrating identity
 * from source PDS to Cirrus. It:
 * 1. Chooses the rotation keys: keys the user holds, an optional new
 *    recovery key, then this PDS's key. The source PDS's key is removed.
 * 2. Requests an email token from the source PDS
 * 3. Gets the source PDS to sign a PLC operation with the new endpoint,
 *    signing key and rotation keys
 * 4. Submits the signed operation to the PLC directory
 */
import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { getVars } from "../utils/wrangler.js";
import { readDevVars } from "../utils/dotenv.js";
import { PDSClient } from "../utils/pds-client.js";
import { SourcePdsPlcClient, PlcDirectoryClient } from "../utils/plc-client.js";
import { getPdsEndpoint } from "@atcute/identity";
import { DidResolver } from "../../did-resolver.js";
import {
	getTargetUrl,
	getDomain,
	detectPackageManager,
	formatCommand,
	promptText,
	promptConfirm,
} from "../utils/cli-helpers.js";
import {
	checkRotationKeys,
	chooseRotationKeys,
	describeRotationKeys,
	type RotationKeyChoice,
} from "../utils/rotation-key-prompts.js";
import { Secp256k1Keypair } from "@atproto/crypto";

// Helper to override clack's dim styling in notes
const brightNote = (lines: string[]) =>
	lines.map((l) => `\x1b[0m${l}`).join("\n");

export const identityCommand = defineCommand({
	meta: {
		name: "identity",
		description: "Update your DID to point to your new PDS",
	},
	args: {
		dev: {
			type: "boolean",
			description: "Target local development server instead of production",
			default: false,
		},
		token: {
			type: "string",
			description:
				"Confirmation code from your previous PDS's email, if you already have one",
		},
	},
	async run({ args }) {
		const pm = detectPackageManager();
		const isDev = args.dev;

		p.intro("🆔 Update Identity");

		const spinner = p.spinner();

		// Load config
		const wranglerVars = getVars();
		const devVars = readDevVars();
		const config = { ...devVars, ...wranglerVars };

		const did = config.DID;
		const handle = config.HANDLE;
		const authToken = config.AUTH_TOKEN;
		const pdsHostname = config.PDS_HOSTNAME;
		const signingKey = config.SIGNING_KEY;

		// Validate configuration
		if (!did) {
			p.log.error("No DID configured. Run 'pds init' first.");
			p.outro("Identity update cancelled.");
			process.exit(1);
		}

		if (!handle) {
			p.log.error("No HANDLE configured. Run 'pds init' first.");
			p.outro("Identity update cancelled.");
			process.exit(1);
		}

		if (!authToken) {
			p.log.error("No AUTH_TOKEN found. Run 'pds init' first.");
			p.outro("Identity update cancelled.");
			process.exit(1);
		}

		if (!pdsHostname && !isDev) {
			p.log.error("No PDS_HOSTNAME configured in wrangler.jsonc");
			p.outro("Identity update cancelled.");
			process.exit(1);
		}

		// Only did:plc is supported for now
		if (!did.startsWith("did:plc:")) {
			p.log.error("Only did:plc identities are supported for now.");
			p.log.info("did:web identities don't use PLC operations.");
			p.outro("Identity update cancelled.");
			process.exit(1);
		}

		// Get target PDS URL
		let targetUrl: string;
		try {
			targetUrl = getTargetUrl(isDev, pdsHostname);
		} catch (err) {
			p.log.error(err instanceof Error ? err.message : "Configuration error");
			p.outro("Identity update cancelled.");
			process.exit(1);
		}

		const targetDomain = getDomain(targetUrl);

		// Resolve current DID document to find source PDS
		spinner.start("Resolving your DID...");

		const didResolver = new DidResolver();
		const didDoc = await didResolver.resolve(did);

		if (!didDoc) {
			spinner.stop("Failed to resolve DID");
			p.log.error(`Could not resolve DID: ${did}`);
			p.outro("Identity update cancelled.");
			process.exit(1);
		}

		const sourcePdsUrl = getPdsEndpoint(didDoc);
		if (!sourcePdsUrl) {
			spinner.stop("No PDS found in DID document");
			p.log.error("Could not find PDS endpoint in DID document");
			p.outro("Identity update cancelled.");
			process.exit(1);
		}

		const sourceDomain = getDomain(sourcePdsUrl);
		spinner.stop(`Current PDS: ${sourceDomain}`);

		const targetEndpoint = targetUrl.replace(/\/$/, "");
		const currentEndpoint = sourcePdsUrl.replace(/\/$/, "");

		// Check target PDS is healthy
		spinner.start(`Checking ${targetDomain}...`);
		const targetClient = new PDSClient(targetUrl, authToken);
		const isHealthy = await targetClient.healthCheck();

		if (!isHealthy) {
			spinner.stop(`PDS not responding`);
			p.log.error(`Your new PDS isn't responding at ${targetUrl}`);
			if (isDev) {
				p.log.info(`Start it with: ${formatCommand(pm, "dev")}`);
			} else {
				p.log.info(
					`Make sure your worker is deployed: ${formatCommand(pm, "deploy")}`,
				);
			}
			p.outro("Identity update cancelled.");
			process.exit(1);
		}
		spinner.stop(`New PDS is ready`);

		// The DID must name the key the deployed PDS signs with, which may not
		// be the one in .dev.vars
		spinner.start("Fetching your PDS's signing key...");
		let pdsKey: string;
		try {
			const credentials = await targetClient.getRecommendedDidCredentials();
			const rotationKey = credentials.rotationKeys[0];
			if (
				!rotationKey ||
				credentials.verificationMethods.atproto !== rotationKey
			) {
				throw new Error("PDS returned unexpected credentials");
			}
			pdsKey = rotationKey;
		} catch (err) {
			spinner.stop("Failed to fetch signing key");
			p.log.error(
				err instanceof Error ? err.message : "Could not fetch credentials",
			);
			p.outro("Identity update cancelled.");
			process.exit(1);
		}
		const localKey = signingKey ? await getSigningKeyDid(signingKey) : null;
		if (localKey && localKey !== pdsKey) {
			spinner.stop("Signing keys don't match");
			p.log.error(
				`The signing key in .dev.vars (${localKey}) is not the one ${targetDomain} uses (${pdsKey}).`,
			);
			p.log.info(
				"Restore the deployed key to .dev.vars, or redeploy with the local one, then try again.",
			);
			p.outro("Identity update cancelled.");
			process.exit(1);
		}
		spinner.stop(`Signing key: ${pdsKey}`);

		const plcClient = new PlcDirectoryClient();
		spinner.start("Reading your PLC record...");
		const current = await plcClient.getLatestOperation(did).catch(() => null);
		if (!current || current.operation.type !== "plc_operation") {
			spinner.stop("Failed to read PLC record");
			p.log.error(`Could not read the current PLC operation for ${did}`);
			p.outro("Identity update cancelled.");
			process.exit(1);
		}
		const currentKeys = current.operation.rotationKeys;
		spinner.stop("PLC record loaded");

		// Check if already pointing to target
		if (currentEndpoint === targetEndpoint) {
			p.log.success("Your DID already points to your new PDS!");
			if (!currentKeys.includes(pdsKey)) {
				p.log.warn(
					"Your PDS can't update your identity, because its key isn't one of your rotation keys.",
				);
				p.log.info(
					`Fix this with: ${formatCommand(pm, "pds", "rotation-keys")}`,
				);
			}
			p.log.info(`Next step: ${formatCommand(pm, "pds", "activate")}`);
			p.outro("All set!");
			return;
		}

		// Determine friendly names for display
		const isBlueskyPds = sourceDomain.endsWith(".bsky.network");
		const sourceDisplayName = isBlueskyPds ? "bsky.social" : sourceDomain;

		// Create source PDS client
		const sourcePdsClient = new SourcePdsPlcClient(sourcePdsUrl);

		// Log in to the source PDS: signing needs a session, and its
		// recommended credentials tell us which rotation keys it holds
		let token = args.token;
		let sourcePdsKeys: string[] | undefined;

		const password = await p.password({
			message: `Your password for ${sourceDisplayName}:`,
		});

		if (p.isCancel(password)) {
			p.cancel("Identity update cancelled.");
			process.exit(0);
		}

		spinner.start(`Logging in to ${sourceDisplayName}...`);
		const sourceClient = new PDSClient(sourcePdsUrl);
		try {
			const session = await sourceClient.createSession(did, password);
			sourcePdsClient.setAuthToken(session.accessJwt);
			spinner.stop("Authenticated");
		} catch (err) {
			spinner.stop("Login failed");
			p.log.error(err instanceof Error ? err.message : "Authentication failed");
			p.outro("Identity update cancelled.");
			process.exit(1);
		}

		try {
			sourcePdsKeys = (await sourcePdsClient.getRecommendedDidCredentials())
				.rotationKeys;
		} catch {
			p.log.warn(
				`Couldn't ask ${sourceDisplayName} which rotation keys it holds.`,
			);
		}

		let choice: RotationKeyChoice;
		try {
			choice = await chooseRotationKeys({
				did,
				handle,
				currentKeys,
				pdsKey,
				pdsName: targetDomain,
				sourcePdsKeys,
				sourceName: sourceDisplayName,
			});
		} catch (err) {
			p.log.error(err instanceof Error ? err.message : String(err));
			p.outro("Identity update cancelled.");
			process.exit(1);
		}

		// Show what we're about to do
		p.note(
			brightNote([
				pc.bold("Updating your identity:"),
				"",
				`${pc.dim("From:")} ${sourceDisplayName}`,
				`${pc.dim("To:")}   ${targetDomain}`,
				"",
				...describeRotationKeys(choice),
				"",
				pc.dim("This tells the network where to find you, and gives"),
				pc.dim("your new PDS control of your identity."),
			]),
			"🔄 DID Update",
		);

		const proceed = await promptConfirm({
			message: "Update your identity?",
			initialValue: true,
		});
		if (!proceed) {
			p.outro("Identity update cancelled.");
			process.exit(0);
		}

		if (!token) {
			// Request PLC operation signature (sends email)
			spinner.start("Requesting identity update token...");
			const signatureRequest =
				await sourcePdsClient.requestPlcOperationSignature();

			if (!signatureRequest.success) {
				spinner.stop("Failed to request token");
				p.log.error(
					signatureRequest.error ?? "Could not request PLC operation signature",
				);
				p.outro("Identity update cancelled.");
				process.exit(1);
			}
			spinner.stop("Token requested");

			p.log.info("");
			p.log.info(pc.bold("📧 Check your email!"));
			p.log.info(`${sourceDisplayName} has sent you a confirmation code.`);
			p.log.info("");

			// Get token from user
			token = await promptText({
				message: "Enter the confirmation code from your email:",
				placeholder: "XXXXX-XXXXX",
				validate: (v) => {
					if (!v || v.trim().length < 5) {
						return "Please enter the confirmation code";
					}
					return undefined;
				},
			});
		}

		// Sign the PLC operation via source PDS
		spinner.start("Signing identity update...");
		const signResult = await sourcePdsClient.signPlcOperation(token.trim(), {
			rotationKeys: choice.rotationKeys,
			verificationMethods: { atproto: pdsKey },
			services: {
				atproto_pds: {
					type: "AtprotoPersonalDataServer",
					endpoint: targetUrl,
				},
			},
		});

		if (!signResult.success || !signResult.signedOperation) {
			spinner.stop("Failed to sign operation");
			p.log.error(signResult.error ?? "Could not sign PLC operation");

			if (signResult.error?.includes("expired")) {
				p.log.info("Run the command again to request a new token.");
			}

			p.outro("Identity update cancelled.");
			process.exit(1);
		}
		spinner.stop("Operation signed");

		// The source PDS builds the operation; refuse to submit it if it
		// doesn't carry the rotation keys we asked for
		const signedKeys = signResult.signedOperation.rotationKeys;
		if (
			signedKeys.length !== choice.rotationKeys.length ||
			signedKeys.some((key, i) => key !== choice.rotationKeys[i])
		) {
			p.log.error(
				`${sourceDisplayName} signed different rotation keys than requested: ${signedKeys.join(", ")}`,
			);
			p.outro("Identity update cancelled. Nothing was submitted.");
			process.exit(1);
		}

		// Submit to PLC directory
		spinner.start("Submitting to PLC directory...");
		const submitResult = await plcClient.submitOperation(
			did,
			signResult.signedOperation,
		);

		if (!submitResult.success) {
			spinner.stop("Failed to submit operation");
			p.log.error(submitResult.error ?? "PLC directory rejected the operation");
			p.outro("Identity update cancelled.");
			process.exit(1);
		}
		spinner.stop("Identity updated!");

		// Verify the update
		spinner.start("Verifying update...");
		await new Promise((resolve) => setTimeout(resolve, 1000)); // Brief delay for propagation

		const verifyResolver = new DidResolver();
		const newDidDoc = await verifyResolver.resolve(did);
		const newPdsEndpoint = newDidDoc ? getPdsEndpoint(newDidDoc) : null;
		const keyMismatch = await checkRotationKeys(
			plcClient,
			did,
			choice.rotationKeys,
		).catch(() => undefined);

		if (newPdsEndpoint?.replace(/\/$/, "") === targetEndpoint && !keyMismatch) {
			spinner.stop("Verified! DID now points to new PDS");
		} else {
			spinner.stop("Update submitted (verification pending)");
			p.log.warn("It may take a moment for the update to propagate.");
			if (keyMismatch) {
				p.log.warn(
					`plc.directory lists these rotation keys: ${keyMismatch.join(", ") || "none"}`,
				);
				p.log.info(
					`Check them with: ${formatCommand(pm, "pds", "rotation-keys")}`,
				);
			}
		}

		// Success!
		p.log.success("Your identity now points to your new PDS!");

		if (choice.createdRecoveryKey) {
			p.log.info(
				"Keep your recovery key offline. If your PDS ever makes an identity change you didn't ask for, you have 72 hours to undo it with that key.",
			);
		}

		p.note(
			brightNote([
				pc.bold("Final step:"),
				"",
				`Run: ${formatCommand(pm, "pds", "activate")}`,
				"",
				"This enables writes and notifies the network.",
			]),
			"Almost done!",
		);

		p.outro("Identity updated! 🎉");
	},
});

/**
 * Convert a hex-encoded secp256k1 private key to a did:key
 *
 * This imports the private key and returns the did:key representation.
 */
async function getSigningKeyDid(hexPrivateKey: string): Promise<string | null> {
	try {
		const keypair = await Secp256k1Keypair.import(hexPrivateKey);
		return keypair.did();
	} catch {
		return null;
	}
}
