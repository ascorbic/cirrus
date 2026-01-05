/**
 * Shared check functions for status and activate commands
 */
import { PDSClient, type MigrationStatus } from "./pds-client.js";
import { resolveHandleToDid } from "./handle-resolver.js";
import { DidResolver } from "../../did-resolver.js";

export interface CheckResult {
	ok: boolean;
	message: string;
	detail?: string;
}

/**
 * Check that handle resolves to the expected DID
 */
export async function checkHandleResolution(
	handle: string,
	expectedDid: string,
): Promise<CheckResult> {
	const resolvedDid = await resolveHandleToDid(handle);
	if (!resolvedDid) {
		return {
			ok: false,
			message: `@${handle} does not resolve to any DID`,
			detail: "Update your DNS TXT record or .well-known/atproto-did file",
		};
	}
	if (resolvedDid !== expectedDid) {
		return {
			ok: false,
			message: `@${handle} resolves to wrong DID`,
			detail: `Expected: ${expectedDid}\n  Got: ${resolvedDid}`,
		};
	}
	return {
		ok: true,
		message: `@${handle} → ${expectedDid.slice(0, 24)}...`,
	};
}

/**
 * Check that handle resolves via DNS and/or HTTP, returning both methods
 */
export async function checkHandleResolutionDetailed(
	client: PDSClient,
	handle: string,
	expectedDid: string,
): Promise<{
	ok: boolean;
	httpDid: string | null;
	dnsDid: string | null;
	methods: string[];
}> {
	const [httpDid, dnsDid] = await Promise.all([
		client.checkHandleViaHttp(handle),
		client.checkHandleViaDns(handle),
	]);
	const httpValid = httpDid === expectedDid;
	const dnsValid = dnsDid === expectedDid;
	const methods: string[] = [];
	if (dnsValid) methods.push("DNS");
	if (httpValid) methods.push("HTTP");
	return {
		ok: httpValid || dnsValid,
		httpDid,
		dnsDid,
		methods,
	};
}

/**
 * Check that DID document points to the expected PDS endpoint
 */
export async function checkDidDocument(
	did: string,
	expectedPdsUrl: string,
): Promise<CheckResult> {
	const didResolver = new DidResolver();
	const didDoc = await didResolver.resolve(did);
	const expectedEndpoint = expectedPdsUrl.replace(/\/$/, "");

	if (!didDoc) {
		return {
			ok: false,
			message: `Could not resolve DID document for ${did}`,
			detail:
				"Make sure your DID is published to the PLC directory or did:web endpoint",
		};
	}

	const pdsService = didDoc.service?.find((s) => {
		const types = Array.isArray(s.type) ? s.type : [s.type];
		return types.includes("AtprotoPersonalDataServer") || s.id === "#atproto_pds";
	}) as { serviceEndpoint?: string } | undefined;

	if (!pdsService?.serviceEndpoint) {
		return {
			ok: false,
			message: "DID document has no PDS service endpoint",
			detail:
				"Update your DID document to include an AtprotoPersonalDataServer service",
		};
	}

	const actualEndpoint = pdsService.serviceEndpoint.replace(/\/$/, "");
	if (actualEndpoint !== expectedEndpoint) {
		return {
			ok: false,
			message: "DID document points to different PDS",
			detail: `Expected: ${expectedEndpoint}\n  Got: ${actualEndpoint}`,
		};
	}

	return {
		ok: true,
		message: `PDS endpoint → ${expectedEndpoint}`,
	};
}

/**
 * Check that DID resolves and returns the PDS endpoint (simpler version using PDSClient)
 */
export async function checkDidResolution(
	client: PDSClient,
	did: string,
	expectedPdsHostname: string,
): Promise<{
	ok: boolean;
	pdsEndpoint: string | null;
	resolveMethod: string;
}> {
	const resolved = await client.resolveDid(did);
	const resolveMethod = did.startsWith("did:plc:")
		? "plc.directory"
		: did.startsWith("did:web:")
			? "/.well-known/did.json"
			: "unknown";

	if (!resolved.pdsEndpoint) {
		return { ok: false, pdsEndpoint: null, resolveMethod };
	}

	const expectedEndpoint = `https://${expectedPdsHostname}`;
	const matches =
		resolved.pdsEndpoint === expectedEndpoint ||
		resolved.pdsEndpoint === expectedPdsHostname;

	return {
		ok: matches,
		pdsEndpoint: resolved.pdsEndpoint,
		resolveMethod,
	};
}

/**
 * Check that all blobs are imported
 */
export function checkBlobsImported(status: MigrationStatus): CheckResult {
	const missingBlobs = status.expectedBlobs - status.importedBlobs;
	if (missingBlobs > 0) {
		return {
			ok: false,
			message: `${missingBlobs} blob${missingBlobs === 1 ? "" : "s"} missing`,
			detail: "Run 'pds migrate' to import missing blobs before activating",
		};
	}
	return {
		ok: true,
		message: `${status.importedBlobs}/${status.expectedBlobs} blobs imported`,
	};
}

/**
 * Check that repository data exists and is properly initialised
 */
export function checkRepoInitialised(status: MigrationStatus): CheckResult {
	if (!status.repoCommit) {
		return {
			ok: false,
			message: "No repo data imported",
			detail: "Run 'pds migrate' to import your repository first",
		};
	}
	if (status.indexedRecords === 0) {
		return {
			ok: false,
			message: "Repository has no indexed records",
			detail: "Run 'pds migrate' to import your repository",
		};
	}
	return {
		ok: true,
		message: `${status.repoBlocks.toLocaleString()} blocks, ${status.indexedRecords.toLocaleString()} records`,
	};
}

/**
 * Check that repo is complete for activation (combines blob and repo checks)
 */
export function checkRepoComplete(status: MigrationStatus): CheckResult {
	// First check repo is initialised
	const repoCheck = checkRepoInitialised(status);
	if (!repoCheck.ok) {
		return repoCheck;
	}

	// Then check blobs if there are any expected
	if (status.expectedBlobs > 0) {
		const blobCheck = checkBlobsImported(status);
		if (!blobCheck.ok) {
			return blobCheck;
		}
	}

	return {
		ok: true,
		message: `${status.repoBlocks} blocks, ${status.importedBlobs} blobs`,
	};
}

/**
 * Check if profile is indexed by AppView
 */
export async function checkAppViewIndexing(
	client: PDSClient,
	did: string,
): Promise<CheckResult> {
	const isIndexed = await client.checkAppViewIndexing(did);
	if (!isIndexed) {
		return {
			ok: false,
			message: "Profile not found on AppView",
			detail: "This may be normal for new accounts",
		};
	}
	return {
		ok: true,
		message: "Profile indexed by AppView",
	};
}
