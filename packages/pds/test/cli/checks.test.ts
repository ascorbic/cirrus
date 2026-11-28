import { describe, it, expect, vi } from "vitest";
import {
	checkBlobsImported,
	checkPlcRotationKeys,
	countMissingBlobs,
} from "../../src/cli/utils/checks.js";
import type {
	MigrationStatus,
	PDSClient,
} from "../../src/cli/utils/pds-client.js";
import type { PlcDirectoryClient } from "../../src/cli/utils/plc-client.js";

const PDS = "did:key:zQ3shPdsKey";
const DID = "did:plc:abc123";

function pdsWith(rotationKeys: string[]) {
	return {
		getRecommendedDidCredentials: vi.fn(async () => ({
			rotationKeys,
			verificationMethods: { atproto: rotationKeys[0] },
		})),
	} as unknown as PDSClient;
}

function plcWith(operation: Record<string, unknown> | null) {
	return {
		getLatestOperation: vi.fn(async () => (operation ? { operation } : null)),
	} as unknown as PlcDirectoryClient;
}

describe("checkPlcRotationKeys", () => {
	it("reports that the PDS can sign, with the number of other keys", async () => {
		const result = await checkPlcRotationKeys(
			pdsWith([PDS]),
			DID,
			plcWith({
				type: "plc_operation",
				rotationKeys: ["did:key:zRecovery", PDS],
			}),
		);
		expect(result).toEqual({ pdsCanSign: true, otherKeys: 1 });
	});

	it("reports when the PDS key is missing", async () => {
		const result = await checkPlcRotationKeys(
			pdsWith([PDS]),
			DID,
			plcWith({ type: "plc_operation", rotationKeys: ["did:key:zOldPds"] }),
		);
		expect(result).toEqual({ pdsCanSign: false, otherKeys: 1 });
	});

	it("returns null when the PLC state can't be read", async () => {
		expect(
			await checkPlcRotationKeys(pdsWith([PDS]), DID, plcWith(null)),
		).toBeNull();
		expect(
			await checkPlcRotationKeys(
				pdsWith([PDS]),
				DID,
				plcWith({ type: "plc_tombstone" }),
			),
		).toBeNull();
	});

	it("returns null when the PDS can't be reached", async () => {
		const pds = {
			getRecommendedDidCredentials: vi.fn(async () => {
				throw new Error("offline");
			}),
		} as unknown as PDSClient;
		expect(
			await checkPlcRotationKeys(
				pds,
				DID,
				plcWith({ type: "plc_operation", rotationKeys: [PDS] }),
			),
		).toBeNull();
	});
});

function statusWith(
	expectedBlobs: number,
	importedBlobs: number,
): MigrationStatus {
	return { expectedBlobs, importedBlobs } as MigrationStatus;
}

describe("checkBlobsImported", () => {
	it("does not report more imported blobs than expected", () => {
		const result = checkBlobsImported(statusWith(294, 815), 0);
		expect(result.ok).toBe(true);
		expect(result.message).toBe("All 294 migrated blobs imported");
	});

	it("fails when migrated blobs are missing, even if more blobs are stored than expected", () => {
		const result = checkBlobsImported(statusWith(294, 815), 3);
		expect(result.ok).toBe(false);
		expect(result.message).toBe("3 of 294 migrated blobs missing");
	});

	it("falls back to the status counts when the missing count is unknown", () => {
		expect(checkBlobsImported(statusWith(10, 10)).ok).toBe(true);
		expect(checkBlobsImported(statusWith(10, 815)).ok).toBe(true);
		const result = checkBlobsImported(statusWith(10, 9));
		expect(result.ok).toBe(false);
		expect(result.message).toBe("1 of 10 migrated blobs missing");
	});
});

describe("countMissingBlobs", () => {
	it("counts distinct missing blobs across pages", async () => {
		const pages = [
			{
				blobs: [
					{ cid: "bafy1", recordUri: "at://did:plc:abc123/a/1" },
					{ cid: "bafy1", recordUri: "at://did:plc:abc123/a/2" },
				],
				cursor: "bafy1",
			},
			{ blobs: [{ cid: "bafy2", recordUri: "at://did:plc:abc123/a/3" }] },
		];
		const listMissingBlobs = vi.fn(async () => pages.shift()!);
		const client = { listMissingBlobs } as unknown as PDSClient;

		expect(await countMissingBlobs(client)).toBe(2);
		expect(listMissingBlobs).toHaveBeenNthCalledWith(2, 500, "bafy1");
	});
});
