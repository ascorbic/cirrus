import { describe, it, expect, vi } from "vitest";
import { checkPlcRotationKeys } from "../../src/cli/utils/checks.js";
import type { PDSClient } from "../../src/cli/utils/pds-client.js";
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
