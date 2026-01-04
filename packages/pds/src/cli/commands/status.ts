/**
 * Status command - comprehensive PDS health and configuration check
 */
import { defineCommand } from "citty";
import pc from "picocolors";
import { getVars } from "../utils/wrangler.js";
import { readDevVars } from "../utils/dotenv.js";
import { PDSClient } from "../utils/pds-client.js";
import { getTargetUrl } from "../utils/cli-helpers.js";

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
			console.error(pc.red("Error:"), "No AUTH_TOKEN found. Run 'pds init' first.");
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
				console.log(pc.dim("Make sure your worker is deployed: wrangler deploy"));
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

		if (status.repoCommit && status.indexedRecords > 0) {
			const shortCid =
				status.repoCommit.slice(0, 12) + "..." + status.repoCommit.slice(-4);
			const shortRev = status.repoRev
				? status.repoRev.slice(0, 8) + "..."
				: "none";
			console.log(`  ${CHECK} Initialized: ${pc.dim(shortCid)} (rev: ${shortRev})`);
			console.log(
				`  ${INFO} ${status.repoBlocks.toLocaleString()} blocks, ${status.indexedRecords.toLocaleString()} records`,
			);
		} else {
			console.log(`  ${WARN} Repository empty (no records)`);
			console.log(pc.dim("      Run 'pds migrate' to import from another PDS"));
			hasWarnings = true;
		}
		console.log();

		// ============================================
		// Identity
		// ============================================
		console.log(pc.bold("Identity"));

		// Show configured identity
		if (did) {
			const didType = did.startsWith("did:plc:") ? "did:plc" : did.startsWith("did:web:") ? "did:web" : "unknown";
			console.log(`  ${INFO} DID: ${pc.dim(did)} (${didType})`);
		}
		if (handle) {
			console.log(`  ${INFO} Handle: ${pc.cyan(`@${handle}`)}`);
		}

		// Check DID resolution
		if (did) {
			const resolved = await client.resolveDid(did);
			const resolveMethod = did.startsWith("did:plc:")
				? "plc.directory"
				: did.startsWith("did:web:")
					? "/.well-known/did.json"
					: "unknown";

			if (resolved.pdsEndpoint) {
				const expectedEndpoint = `https://${pdsHostname}`;
				if (
					resolved.pdsEndpoint === expectedEndpoint ||
					resolved.pdsEndpoint === pdsHostname
				) {
					console.log(`  ${CHECK} DID resolves to this PDS (via ${resolveMethod})`);
				} else {
					console.log(`  ${CROSS} DID resolves to different PDS`);
					console.log(pc.dim(`      Resolved via: ${resolveMethod}`));
					console.log(pc.dim(`      Expected: ${expectedEndpoint}`));
					console.log(pc.dim(`      Got: ${resolved.pdsEndpoint}`));
					hasErrors = true;
				}
			} else {
				console.log(`  ${WARN} Could not resolve DID`);
				if (did.startsWith("did:plc:")) {
					console.log(pc.dim("      Check plc.directory or update DID document"));
				} else if (did.startsWith("did:web:")) {
					console.log(pc.dim("      Ensure /.well-known/did.json is accessible"));
				}
				hasWarnings = true;
			}
		} else {
			console.log(`  ${WARN} DID not configured`);
			hasWarnings = true;
		}

		// Check handle resolution with method details
		if (handle) {
			const [httpDid, dnsDid] = await Promise.all([
				client.checkHandleViaHttp(handle),
				client.checkHandleViaDns(handle),
			]);

			const httpValid = httpDid === did;
			const dnsValid = dnsDid === did;

			if (httpValid || dnsValid) {
				const methods: string[] = [];
				if (dnsValid) methods.push("DNS");
				if (httpValid) methods.push("HTTP");
				console.log(`  ${CHECK} Handle verified via ${methods.join(" + ")}`);
			} else if (httpDid || dnsDid) {
				console.log(`  ${CROSS} Handle resolves to different DID`);
				console.log(pc.dim(`      Expected: ${did}`));
				if (httpDid) console.log(pc.dim(`      HTTP well-known: ${httpDid}`));
				if (dnsDid) console.log(pc.dim(`      DNS TXT: ${dnsDid}`));
				hasErrors = true;
			} else {
				console.log(`  ${WARN} Handle not resolving`);
				if (handle === pdsHostname) {
					console.log(pc.dim("      Ensure /.well-known/atproto-did returns your DID"));
				} else {
					console.log(pc.dim(`      Add DNS TXT record: _atproto.${handle} → did=...`));
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
			if (status.importedBlobs === status.expectedBlobs) {
				console.log(
					`  ${CHECK} ${status.importedBlobs}/${status.expectedBlobs} blobs imported`,
				);
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
			const isIndexed = await client.checkAppViewIndexing(did);
			if (isIndexed) {
				console.log(`  ${CHECK} Profile indexed by AppView`);
			} else {
				console.log(`  ${WARN} Profile not found on AppView`);
				console.log(pc.dim("      This may be normal for new accounts"));
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
