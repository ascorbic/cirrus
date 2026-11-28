/**
 * Interactive steps for choosing a DID's rotation keys, shared by
 * `pds identity` and `pds rotation-keys`.
 */
import * as p from "@clack/prompts";
import pc from "picocolors";
import { Secp256k1Keypair } from "@atproto/crypto";
import type { PlcDirectoryClient } from "./plc-client.js";
import type { PDSClient } from "./pds-client.js";
import { promptConfirm, promptKeyBackup } from "./cli-helpers.js";
import {
	buildRotationKeys,
	generateRecoveryKey,
	labelRotationKeys,
	MAX_ROTATION_KEYS,
} from "./rotation-keys.js";

/**
 * Get the key the deployed PDS signs with, from its recommended
 * credentials. The DID must name this key, which may not be the one in
 * .dev.vars, so a different local key is an error.
 */
export async function getPdsRotationKey(
	client: PDSClient,
	pdsName: string,
	localSigningKey?: string,
): Promise<string> {
	const credentials = await client.getRecommendedDidCredentials();
	const pdsKey = credentials.rotationKeys[0];
	if (!pdsKey || credentials.verificationMethods.atproto !== pdsKey) {
		throw new Error(`${pdsName} returned unexpected credentials`);
	}
	if (localSigningKey) {
		const localKey = (await Secp256k1Keypair.import(localSigningKey)).did();
		if (localKey !== pdsKey) {
			throw new Error(
				`The signing key in .dev.vars (${localKey}) is not the one ${pdsName} uses (${pdsKey}). Restore the deployed key to .dev.vars, or redeploy with the local one, then try again.`,
			);
		}
	}
	return pdsKey;
}

export interface RotationKeyChoice {
	/** The full rotation key list, in priority order */
	rotationKeys: string[];
	/** Description of each key, for display */
	descriptions: Map<string, string>;
	/** Current keys that will be removed */
	removed: string[];
	/** Whether a recovery key was generated */
	createdRecoveryKey: boolean;
}

/**
 * Decide the new rotation keys: keep the current keys the user holds, offer
 * to generate a recovery key if there are none, and put this PDS's key last.
 *
 * @param sourcePdsKeys - Keys held by the previous PDS, if known. Without
 *   them, the user is asked about every key that isn't this PDS's.
 * @param sourceName - Display name for the previous PDS
 * @param heldKeys - Keys known to be the user's, kept without asking
 */
export async function chooseRotationKeys(opts: {
	did: string;
	handle: string;
	currentKeys: string[];
	pdsKey: string;
	pdsName: string;
	sourcePdsKeys?: string[];
	sourceName?: string;
	heldKeys?: string[];
}): Promise<RotationKeyChoice> {
	const descriptions = new Map<string, string>([
		[opts.pdsKey, `${opts.pdsName} (this PDS)`],
	]);
	const labelled = labelRotationKeys(opts.currentKeys, {
		pdsKey: opts.pdsKey,
		sourcePdsKeys: opts.sourcePdsKeys,
	});
	const sourceKnown = opts.sourcePdsKeys !== undefined;

	const userKeys: string[] = [];
	for (const { key, owner } of labelled) {
		if (owner === "source-pds") {
			descriptions.set(key, opts.sourceName ?? "previous PDS");
			continue;
		}
		if (owner === "this-pds") {
			continue;
		}
		if (opts.heldKeys?.includes(key)) {
			userKeys.push(key);
			descriptions.set(key, "your key");
			continue;
		}
		// Keeping a key nobody holds only preserves the status quo, while
		// dropping one the user holds loses it, so the default is to keep
		const keep = await promptConfirm({
			message: sourceKnown
				? `Keep ${pc.cyan(key)}? It isn't held by ${opts.sourceName ?? "your previous PDS"}, so it is probably a recovery key you added.`
				: `Keep ${pc.cyan(key)}? Answer no only if you don't hold this key, such as one belonging to your previous PDS.`,
			initialValue: true,
		});
		if (keep) {
			userKeys.push(key);
			descriptions.set(key, "your key");
		} else {
			descriptions.set(key, "not held by you");
		}
	}

	let createdRecoveryKey = false;
	if (userKeys.length === 0) {
		p.note(
			[
				"A recovery key is a rotation key you keep offline.",
				"It ranks above your PDS's key, so for 72 hours after any",
				"identity change it can override it. If your PDS is lost or",
				"compromised, it is how you take your identity back.",
			].join("\n"),
			"Recovery key",
		);
		const create = await promptConfirm({
			message: "Create a recovery key? (recommended)",
			initialValue: true,
		});
		if (create) {
			const recoveryKey = await generateRecoveryKey();
			const backup = () =>
				promptKeyBackup({
					key: recoveryKey.privateKey,
					kind: "recovery",
					handle: opts.handle,
					details: [`DID: ${opts.did}`, `Public key: ${recoveryKey.did}`],
					allowSkip: false,
				});
			let saved = await backup();
			while (!saved) {
				const retry = await promptConfirm({
					message:
						"Try saving it again? Choosing no continues without a recovery key.",
					initialValue: true,
				});
				if (!retry) break;
				saved = await backup();
			}
			if (saved) {
				userKeys.push(recoveryKey.did);
				descriptions.set(recoveryKey.did, "your new recovery key");
				createdRecoveryKey = true;
			}
		}
	}

	if (userKeys.length > MAX_ROTATION_KEYS - 1) {
		throw new Error(
			`You chose ${userKeys.length} keys to keep, but a DID can have at most ${MAX_ROTATION_KEYS} rotation keys including this PDS's.`,
		);
	}

	const rotationKeys = buildRotationKeys({ userKeys, pdsKey: opts.pdsKey });
	return {
		rotationKeys,
		descriptions,
		removed: opts.currentKeys.filter((k) => !rotationKeys.includes(k)),
		createdRecoveryKey,
	};
}

/**
 * Lines describing a rotation key change, for a note.
 */
export function describeRotationKeys(choice: RotationKeyChoice): string[] {
	const lines = [pc.bold("Rotation keys, highest priority first:")];
	choice.rotationKeys.forEach((key, i) => {
		lines.push(`  ${i + 1}. ${key}`);
		lines.push(`     ${pc.dim(choice.descriptions.get(key) ?? "")}`);
	});
	if (choice.removed.length > 0) {
		lines.push("", pc.bold("Removed:"));
		for (const key of choice.removed) {
			lines.push(`  ${key}`);
			lines.push(`     ${pc.dim(choice.descriptions.get(key) ?? "")}`);
		}
	}
	return lines;
}

/**
 * Read the DID's latest operation back and check its rotation keys.
 * Returns the keys plc.directory has, or null if they match.
 */
export async function checkRotationKeys(
	plcClient: PlcDirectoryClient,
	did: string,
	expected: string[],
): Promise<string[] | null> {
	const latest = await plcClient.getLatestOperation(did);
	const actual =
		latest?.operation.type === "plc_operation"
			? latest.operation.rotationKeys
			: [];
	return actual.length === expected.length &&
		actual.every((key, i) => key === expected[i])
		? null
		: actual;
}
