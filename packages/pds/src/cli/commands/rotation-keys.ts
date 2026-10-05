/**
 * Rotation keys command - review and fix who can update a did:plc identity
 *
 * Accounts migrated before `pds identity` set rotation keys still have the
 * previous PDS's key and not this PDS's. This command shows the current
 * keys and rewrites them as: keys the user holds, then this PDS's key. The
 * change is signed by whichever key can: this PDS (if it is already a
 * rotation key), the previous PDS (with its password and an email code), or
 * a rotation key the user pastes in.
 */
import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { getVars } from "../utils/wrangler.js";
import { readDevVars } from "../utils/dotenv.js";
import { PDSClient } from "../utils/pds-client.js";
import { SourcePdsPlcClient, PlcDirectoryClient } from "../utils/plc-client.js";
import {
	getTargetUrl,
	getDomain,
	detectPackageManager,
	formatCommand,
	promptConfirm,
	promptSelect,
	promptText,
} from "../utils/cli-helpers.js";
import {
	checkRotationKeys,
	chooseRotationKeys,
	describeRotationKeys,
	getPdsRotationKey,
	type RotationKeyChoice,
} from "../utils/rotation-key-prompts.js";
import {
	findPreviousPdsEndpoint,
	importRotationKey,
	labelRotationKeys,
} from "../utils/rotation-keys.js";
import { signOperation, type SignedPlcOperation } from "../../plc.js";
import type { Keypair } from "@atproto/crypto";

const brightNote = (lines: string[]) =>
	lines.map((l) => `\x1b[0m${l}`).join("\n");

function cancel(message: string): never {
	p.log.error(message);
	p.outro("Rotation keys unchanged.");
	process.exit(1);
}

function displayName(url: string): string {
	const domain = getDomain(url);
	return domain.endsWith(".bsky.network") ? "bsky.social" : domain;
}

export const rotationKeysCommand = defineCommand({
	meta: {
		name: "rotation-keys",
		description:
			"Review your DID's rotation keys and make sure your PDS can update your identity",
	},
	args: {
		dev: {
			type: "boolean",
			description: "Target local development server instead of production",
			default: false,
		},
	},
	async run({ args }) {
		const pm = detectPackageManager();
		const isDev = args.dev;

		p.intro("🔑 Rotation Keys");

		const spinner = p.spinner();

		const config = { ...readDevVars(), ...getVars() };
		const did = config.DID;
		const handle = config.HANDLE;
		const authToken = config.AUTH_TOKEN;

		if (!did || !handle || !authToken) {
			cancel(
				"DID, HANDLE and AUTH_TOKEN must be configured. Run 'pds init' first.",
			);
		}

		if (!did.startsWith("did:plc:")) {
			p.log.info(
				"did:web identities have no rotation keys. Whoever controls the domain controls the identity.",
			);
			p.outro("Nothing to do.");
			return;
		}

		let targetUrl: string;
		try {
			targetUrl = getTargetUrl(isDev, config.PDS_HOSTNAME);
		} catch (err) {
			cancel(err instanceof Error ? err.message : "Configuration error");
		}
		const targetDomain = getDomain(targetUrl);
		const targetEndpoint = targetUrl.replace(/\/$/, "");
		const pdsClient = new PDSClient(targetUrl, authToken);

		spinner.start(`Checking ${targetDomain}...`);
		let pdsKey: string;
		try {
			pdsKey = await getPdsRotationKey(
				pdsClient,
				targetDomain,
				config.SIGNING_KEY,
			);
		} catch (err) {
			spinner.stop("Failed to fetch signing key");
			cancel(
				err instanceof Error
					? err.message
					: `Could not reach ${targetDomain}. Is it deployed?`,
			);
		}
		spinner.stop(`${targetDomain} signs with ${pdsKey}`);

		const plcClient = new PlcDirectoryClient();
		spinner.start("Reading your PLC record...");
		const log = await plcClient.getAuditLog(did).catch(() => null);
		const current = log?.filter((entry) => !entry.nullified).pop();
		if (!log || !current || current.operation.type !== "plc_operation") {
			spinner.stop("Failed to read PLC record");
			cancel(`Could not read the current PLC operation for ${did}`);
		}
		spinner.stop("PLC record loaded");
		const operation = current.operation;

		const currentEndpoint = operation.services.atproto_pds?.endpoint?.replace(
			/\/$/,
			"",
		);
		if (currentEndpoint !== targetEndpoint) {
			cancel(
				`Your DID points to ${currentEndpoint ?? "no PDS"}, not ${targetDomain}. Run '${formatCommand(pm, "pds", "identity")}' to move your identity here first.`,
			);
		}

		const labelled = labelRotationKeys(operation.rotationKeys, { pdsKey });
		const pdsCanSign = operation.rotationKeys.includes(pdsKey);
		p.note(
			brightNote([
				pc.bold("Current rotation keys, highest priority first:"),
				...labelled.map(
					({ key, owner }, i) =>
						`  ${i + 1}. ${key}${owner === "this-pds" ? pc.dim(`  (${targetDomain})`) : ""}`,
				),
				"",
				pdsCanSign
					? `${pc.green("✓")} ${targetDomain} can update your identity.`
					: `${pc.red("✗")} ${targetDomain} can't update your identity, because its key isn't listed.`,
			]),
			"Your identity",
		);

		type Signer = "pds" | "previous" | "key";
		let signer: Signer;
		if (pdsCanSign) {
			signer = "pds";
		} else {
			signer = await promptSelect<Signer>({
				message: "Who should sign the change? It needs one of the keys above.",
				options: [
					{
						value: "previous",
						label: "My previous PDS",
						hint: "needs its password and an email code",
					},
					{
						value: "key",
						label: "A rotation key I hold",
						hint: "such as a recovery key",
					},
				],
			});
		}

		let sourcePdsClient: SourcePdsPlcClient | undefined;
		let sourceName: string | undefined;
		let sourcePdsKeys: string[] | undefined;
		let signingKeypair: Keypair | undefined;

		if (signer === "previous") {
			const previous = findPreviousPdsEndpoint(log, targetEndpoint);
			const sourceUrl = await promptText({
				message: "Your previous PDS:",
				initialValue: previous ?? "https://bsky.social",
				validate: (v) =>
					v && /^https?:\/\//.test(v.trim())
						? undefined
						: "Enter a URL, such as https://bsky.social",
			});
			sourceName = displayName(sourceUrl.trim());
			sourcePdsClient = new SourcePdsPlcClient(sourceUrl.trim());

			const password = await p.password({
				message: `Your password for ${sourceName}:`,
			});
			if (p.isCancel(password)) {
				p.cancel("Rotation keys unchanged.");
				process.exit(0);
			}

			spinner.start(`Logging in to ${sourceName}...`);
			try {
				const session = await new PDSClient(sourceUrl.trim()).createSession(
					did,
					password,
				);
				sourcePdsClient.setAuthToken(session.accessJwt);
				spinner.stop("Authenticated");
			} catch (err) {
				spinner.stop("Login failed");
				cancel(err instanceof Error ? err.message : "Authentication failed");
			}

			try {
				sourcePdsKeys = (await sourcePdsClient.getRecommendedDidCredentials())
					.rotationKeys;
			} catch {
				p.log.warn(`Couldn't ask ${sourceName} which rotation keys it holds.`);
			}
			if (
				sourcePdsKeys &&
				!sourcePdsKeys.some((key) => operation.rotationKeys.includes(key))
			) {
				cancel(
					`${sourceName}'s key isn't one of your rotation keys, so it can't sign this change. Use a rotation key you hold instead.`,
				);
			}
		} else if (signer === "key") {
			const secret = await p.password({
				message: "Paste the private key (multibase or hex):",
			});
			if (p.isCancel(secret)) {
				p.cancel("Rotation keys unchanged.");
				process.exit(0);
			}
			try {
				signingKeypair = await importRotationKey(secret);
			} catch (err) {
				cancel(err instanceof Error ? err.message : "Could not read key");
			}
			if (!operation.rotationKeys.includes(signingKeypair.did())) {
				cancel(
					`That key (${signingKeypair.did()}) isn't one of your rotation keys, so it can't sign this change.`,
				);
			}
			p.log.success(`Signing with ${signingKeypair.did()}`);
		}

		let choice: RotationKeyChoice;
		try {
			choice = await chooseRotationKeys({
				did,
				handle,
				currentKeys: operation.rotationKeys,
				pdsKey,
				pdsName: targetDomain,
				sourcePdsKeys,
				sourceName,
				heldKeys: signingKeypair ? [signingKeypair.did()] : [],
			});
		} catch (err) {
			cancel(err instanceof Error ? err.message : String(err));
		}

		const unchanged =
			choice.rotationKeys.length === operation.rotationKeys.length &&
			choice.rotationKeys.every((key, i) => key === operation.rotationKeys[i]);
		if (unchanged) {
			p.outro("Your rotation keys are already set up. Nothing to change.");
			return;
		}

		p.note(brightNote(describeRotationKeys(choice)), "🔄 New rotation keys");
		const proceed = await promptConfirm({
			message: "Update your rotation keys?",
			initialValue: true,
		});
		if (!proceed) {
			p.outro("Rotation keys unchanged.");
			process.exit(0);
		}

		let signed: SignedPlcOperation;
		if (signer === "pds") {
			spinner.start(`Asking ${targetDomain} to sign...`);
			try {
				const { token, error } = await pdsClient.getMigrationToken();
				if (!token) throw new Error(error ?? "Could not get a token");
				signed = await pdsClient.signPlcOperation(token, {
					rotationKeys: choice.rotationKeys,
				});
			} catch (err) {
				spinner.stop("Signing failed");
				cancel(err instanceof Error ? err.message : "Could not sign");
			}
			spinner.stop("Operation signed");
		} else if (signer === "previous") {
			spinner.start("Requesting a confirmation code...");
			const request = await sourcePdsClient!.requestPlcOperationSignature();
			if (!request.success) {
				spinner.stop("Failed to request code");
				cancel(request.error ?? "Could not request a confirmation code");
			}
			spinner.stop(`${sourceName} has emailed you a confirmation code`);

			const token = await promptText({
				message: "Enter the confirmation code from your email:",
				placeholder: "XXXXX-XXXXX",
				validate: (v) =>
					!v || v.trim().length < 5
						? "Please enter the confirmation code"
						: undefined,
			});

			spinner.start(`Asking ${sourceName} to sign...`);
			const result = await sourcePdsClient!.signPlcOperation(token.trim(), {
				rotationKeys: choice.rotationKeys,
			});
			if (!result.success || !result.signedOperation) {
				spinner.stop("Signing failed");
				cancel(result.error ?? "Could not sign PLC operation");
			}
			signed = result.signedOperation;
			spinner.stop("Operation signed");
		} else {
			signed = await signOperation(
				{
					type: "plc_operation",
					prev: current.cid,
					rotationKeys: choice.rotationKeys,
					verificationMethods: operation.verificationMethods,
					alsoKnownAs: operation.alsoKnownAs,
					services: operation.services,
				},
				signingKeypair!,
			);
		}

		if (
			signed.rotationKeys.length !== choice.rotationKeys.length ||
			signed.rotationKeys.some((key, i) => key !== choice.rotationKeys[i]) ||
			signed.services.atproto_pds?.endpoint?.replace(/\/$/, "") !==
				targetEndpoint
		) {
			cancel(
				"The signed operation doesn't match what was requested, so it was not submitted.",
			);
		}

		spinner.start("Submitting to PLC directory...");
		const submitted = await plcClient.submitOperation(did, signed);
		if (!submitted.success) {
			spinner.stop("Failed to submit operation");
			cancel(submitted.error ?? "PLC directory rejected the operation");
		}
		spinner.stop("Submitted");

		const mismatch = await checkRotationKeys(
			plcClient,
			did,
			choice.rotationKeys,
		).catch(() => undefined);
		if (mismatch) {
			p.log.warn(
				`plc.directory lists these rotation keys: ${mismatch.join(", ") || "none"}`,
			);
		} else if (mismatch === null) {
			p.log.success(`${targetDomain} can now update your identity.`);
		}

		if (choice.createdRecoveryKey) {
			p.log.info(
				"Keep your recovery key offline. If your PDS ever makes an identity change you didn't ask for, you have 72 hours to undo it with that key.",
			);
		}

		p.outro("Rotation keys updated! 🔑");
	},
});
