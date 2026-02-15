/**
 * Status command - comprehensive PDS health and configuration check
 */
import { defineCommand } from "citty";
import pc from "picocolors";
import { getVars } from "../utils/wrangler.js";
import { readDevVars } from "../utils/dotenv.js";
import { PDSClient } from "../utils/pds-client.js";
import { getTargetUrl } from "../utils/cli-helpers.js";
import {
	checkHandleResolutionDetailed,
	checkDidResolution,
	checkRepoInitialised,
	checkBlobsImported,
	checkAppViewIndexing,
} from "../utils/checks.js";

const CHECK = pc.green("✓");
const CROSS = pc.red("✗");
const WARN = pc.yellow("!");
const INFO = pc.cyan("ℹ");

export const statusCommand = defineCommand({
	meta: {
		name: "status",
		description: "Check PDS health and configuration",
	},
	args: {
		dev: {
			type: "boolean",
			description: "Target local development server instead of production",
			default: false,
		},
	},
	async run({ args }) {
		const isDev = args.dev;

		// Load config
		const wranglerVars = getVars();
		const devVars = readDevVars();
		const config = { ...devVars, ...wranglerVars };

		// Get target URL
		let targetUrl: string;
		try {
			targetUrl = getTargetUrl(isDev, config.PDS_HOSTNAME);
		} catch (err) {
			console.error(
				pc.red("Error:"),
				err instanceof Error ? err.message : "Configuration error",
			);
			console.log(pc.dim("Run 'pds init' first to configure your PDS."));
			process.exit(1);
		}

		const authToken = config.AUTH_TOKEN;
		const did = config.DID;
		const handle = config.HANDLE;
		const pdsHostname = config.PDS_HOSTNAME;

		if (!authToken) {
			console.error(
				pc.red("Error:"),
				"No AUTH_TOKEN found. Run 'pds init' first.",
			);
			process.exit(1);
		}

		console.log();
		console.log(pc.bold("PDS Status Check"));
		console.log("=".repeat(50));
		console.log(`Endpoint: ${pc.cyan(targetUrl)}`);
		console.log();

		const client = new PDSClient(targetUrl, authToken);
		let hasErrors = false;
		let hasWarnings = false;

		// ============================================
		// Connectivity
		// ============================================
		console.log(pc.bold("Connectivity"));

		// Check PDS reachable
		const isHealthy = await client.healthCheck();
		if (isHealthy) {
			console.log(`  ${CHECK} PDS reachable`);
		} else {
			console.log(`  ${CROSS} PDS not responding`);
			hasErrors = true;
			console.log();
			console.log(pc.red("Cannot continue - PDS is not reachable."));
			if (!isDev) {
				console.log(
					pc.dim("Make sure your worker is deployed: wrangler deploy"),
				);
			}
			process.exit(1);
		}

		// ============================================
		// Account Status
		// ============================================
		let status;
		try {
			status = await client.getAccountStatus();
			console.log(`  ${CHECK} Account status retrieved`);
		} catch (err) {
			console.log(`  ${CROSS} Failed to get account status`);
			hasErrors = true;
			console.log();
			console.log(
				pc.red("Error:"),
				err instanceof Error ? err.message : "Unknown error",
			);
			process.exit(1);
		}
		console.log();

		// ============================================
		// Repository
		// ============================================
		console.log(pc.bold("Repository"));

		const repoCheck = checkRepoInitialised(status);
		if (repoCheck.ok) {
			const shortCid =
				status.repoCommit!.slice(0, 12) + "..." + status.repoCommit!.slice(-4);
			const shortRev = status.repoRev
				? status.repoRev.slice(0, 8) + "..."
				: "none";
			console.log(
				`  ${CHECK} Initialized: ${pc.dim(shortCid)} (rev: ${shortRev})`,
			);
			console.log(`  ${INFO} ${repoCheck.message}`);
		} else {
			console.log(`  ${WARN} ${repoCheck.message}`);
			if (repoCheck.detail) {
				console.log(pc.dim(`      ${repoCheck.detail}`));
			}
			hasWarnings = true;
		}
		console.log();

		// ============================================
		// Identity
		// ============================================
		console.log(pc.bold("Identity"));

		// Show configured identity
		if (did) {
			const didType = did.startsWith("did:plc:")
				? "did:plc"
				: did.startsWith("did:web:")
					? "did:web"
					: "unknown";
			console.log(`  ${INFO} DID: ${pc.dim(did)} (${didType})`);
		}
		if (handle) {
			console.log(`  ${INFO} Handle: ${pc.cyan(`@${handle}`)}`);
		}

		// Check DID resolution
		if (did) {
			const didCheck = await checkDidResolution(client, did, pdsHostname!);
			if (didCheck.ok) {
				console.log(
					`  ${CHECK} DID resolves to this PDS (via ${didCheck.resolveMethod})`,
				);
			} else if (didCheck.pdsEndpoint) {
				console.log(`  ${CROSS} DID resolves to different PDS`);
				console.log(pc.dim(`      Resolved via: ${didCheck.resolveMethod}`));
				console.log(pc.dim(`      Expected: https://${pdsHostname}`));
				console.log(pc.dim(`      Got: ${didCheck.pdsEndpoint}`));
				hasErrors = true;
			} else {
				console.log(`  ${WARN} Could not resolve DID`);
				if (did.startsWith("did:plc:")) {
					console.log(
						pc.dim("      Check plc.directory or update DID document"),
					);
				} else if (did.startsWith("did:web:")) {
					console.log(
						pc.dim("      Ensure /.well-known/did.json is accessible"),
					);
				}
				hasWarnings = true;
			}
		} else {
			console.log(`  ${WARN} DID not configured`);
			hasWarnings = true;
		}

		// Check handle resolution with method details
		if (handle) {
			const handleCheck = await checkHandleResolutionDetailed(
				client,
				handle,
				did!,
			);
			if (handleCheck.ok) {
				console.log(
					`  ${CHECK} Handle verified via ${handleCheck.methods.join(" + ")}`,
				);
			} else if (handleCheck.httpDid || handleCheck.dnsDid) {
				console.log(`  ${CROSS} Handle resolves to different DID`);
				console.log(pc.dim(`      Expected: ${did}`));
				if (handleCheck.httpDid)
					console.log(pc.dim(`      HTTP well-known: ${handleCheck.httpDid}`));
				if (handleCheck.dnsDid)
					console.log(pc.dim(`      DNS TXT: ${handleCheck.dnsDid}`));
				hasErrors = true;
			} else {
				console.log(`  ${WARN} Handle not resolving`);
				if (handle === pdsHostname) {
					console.log(
						pc.dim("      Ensure /.well-known/atproto-did returns your DID"),
					);
				} else {
					console.log(
						pc.dim(`      Add DNS TXT record: _atproto.${handle} → did=...`),
					);
				}
				hasWarnings = true;
			}
		}
		console.log();

		// ============================================
		// Blobs (if migrated)
		// ============================================
		if (status.expectedBlobs > 0) {
			console.log(pc.bold("Blobs"));
			const blobCheck = checkBlobsImported(status);
			if (blobCheck.ok) {
				console.log(`  ${CHECK} ${blobCheck.message}`);
			} else {
				const missing = status.expectedBlobs - status.importedBlobs;
				console.log(
					`  ${WARN} ${status.importedBlobs}/${status.expectedBlobs} blobs imported (${missing} missing)`,
				);
				hasWarnings = true;
			}
			console.log();
		}

		// ============================================
		// Federation
		// ============================================
		console.log(pc.bold("Federation"));

		// Check AppView indexing
		if (did) {
			const appViewCheck = await checkAppViewIndexing(client, did);
			if (appViewCheck.ok) {
				console.log(`  ${CHECK} ${appViewCheck.message}`);
			} else {
				console.log(`  ${WARN} ${appViewCheck.message}`);
				if (appViewCheck.detail) {
					console.log(pc.dim(`      ${appViewCheck.detail}`));
				}
				hasWarnings = true;
			}
		}

		// Relay status - check both relays
		if (pdsHostname) {
			const relayStatuses = await client.getAllRelayHostStatus(pdsHostname);
			const hasActiveRelay = relayStatuses.some((r) => r.status === "active");
			const hasBannedRelay = relayStatuses.some((r) => r.status === "banned");
			const needsCrawl =
				relayStatuses.length === 0 ||
				relayStatuses.every(
					(r) => r.status === "idle" || r.status === "offline",
				);

			if (relayStatuses.length === 0) {
				console.log(`  ${WARN} No relays have crawled this PDS yet`);
			} else {
				for (const relayStatus of relayStatuses) {
					const relayName = relayStatus.relay.includes("us-west")
						? "us-west"
						: "us-east";
					const statusIcon =
						relayStatus.status === "active"
							? CHECK
							: relayStatus.status === "banned"
								? CROSS
								: WARN;
					console.log(
						`  ${statusIcon} Relay ${relayName}: ${relayStatus.status}${relayStatus.accountCount !== undefined ? ` (${relayStatus.accountCount} accounts, seq: ${relayStatus.seq ?? "none"})` : ""}`,
					);
				}
			}

			// Only warn if ALL relays are problematic
			if (hasBannedRelay && !hasActiveRelay) {
				console.log(`  ${CROSS} PDS is banned from all relays`);
				hasErrors = true;
			} else if (needsCrawl) {
				console.log(
					pc.dim(
						"      Run 'pds activate' or 'pds emit-identity' to request a crawl",
					),
				);
				hasWarnings = true;
			}
		}

		// Firehose status
		try {
			const firehose = await client.getFirehoseStatus();
			console.log(
				`  ${INFO} ${firehose.subscribers} firehose subscriber${firehose.subscribers !== 1 ? "s" : ""}, seq: ${firehose.latestSeq ?? "none"}`,
			);
		} catch {
			console.log(`  ${pc.dim("  Could not get firehose status")}`);
		}
		console.log();

		// ============================================
		// Account
		// ============================================
		console.log(pc.bold("Account"));

		if (status.active) {
			console.log(`  ${CHECK} Active (accepting writes)`);
		} else {
			console.log(`  ${WARN} Deactivated (writes disabled)`);
			console.log(pc.dim("      Run 'pds activate' when ready to go live"));
			hasWarnings = true;
		}
		console.log();

		// ============================================
		// Summary
		// ============================================
		if (hasErrors) {
			console.log(pc.red(pc.bold("Some checks failed!")));
			process.exit(1);
		} else if (hasWarnings) {
			console.log(pc.yellow("All checks passed with warnings."));
		} else {
			console.log(pc.green(pc.bold("All checks passed!")));
		}
	},
});
