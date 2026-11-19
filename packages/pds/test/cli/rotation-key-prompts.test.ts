import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@clack/prompts", () => ({
	note: vi.fn(),
}));

vi.mock("../../src/cli/utils/cli-helpers.js", () => ({
	promptConfirm: vi.fn(),
	promptKeyBackup: vi.fn(),
}));

import {
	chooseRotationKeys,
	checkRotationKeys,
	describeRotationKeys,
} from "../../src/cli/utils/rotation-key-prompts.js";
import {
	promptConfirm,
	promptKeyBackup,
} from "../../src/cli/utils/cli-helpers.js";
import type { PlcDirectoryClient } from "../../src/cli/utils/plc-client.js";

const confirm = vi.mocked(promptConfirm);
const backup = vi.mocked(promptKeyBackup);

const PDS = "did:key:zQ3shPdsKey";
const SOURCE = "did:key:zQ3shBlueskyKey";
const RECOVERY = "did:key:zQ3shExistingRecovery";

const base = {
	did: "did:plc:abc123",
	handle: "alice.example.com",
	pdsKey: PDS,
	pdsName: "pds.example.com",
	sourceName: "bsky.social",
};

/** Answer confirm prompts in order */
function answers(...values: boolean[]) {
	for (const value of values) {
		confirm.mockResolvedValueOnce(value);
	}
}

beforeEach(() => {
	confirm.mockReset();
	backup.mockReset();
});

describe("chooseRotationKeys", () => {
	it("keeps a recovery key the user holds above the PDS key and drops the source PDS key", async () => {
		answers(true);

		const choice = await chooseRotationKeys({
			...base,
			currentKeys: [RECOVERY, SOURCE],
			sourcePdsKeys: [SOURCE],
		});

		expect(choice.rotationKeys).toEqual([RECOVERY, PDS]);
		expect(choice.removed).toEqual([SOURCE]);
		expect(choice.createdRecoveryKey).toBe(false);
		expect(confirm).toHaveBeenCalledTimes(1);
		expect(confirm.mock.calls[0]![0].initialValue).toBe(true);
	});

	it("never asks about the source PDS's own key", async () => {
		answers(false);

		const choice = await chooseRotationKeys({
			...base,
			currentKeys: [SOURCE],
			sourcePdsKeys: [SOURCE],
		});

		expect(confirm).toHaveBeenCalledTimes(1);
		expect(confirm.mock.calls[0]![0].message).toContain(
			"Create a recovery key",
		);
		expect(choice.rotationKeys).toEqual([PDS]);
		expect(choice.removed).toEqual([SOURCE]);
	});

	it("defaults to keeping keys when the source PDS's keys are unknown", async () => {
		answers(false, false);

		const choice = await chooseRotationKeys({
			...base,
			currentKeys: [SOURCE],
		});

		expect(confirm.mock.calls[0]![0].initialValue).toBe(true);
		expect(confirm.mock.calls[0]![0].message).toContain("Answer no only if");
		expect(choice.rotationKeys).toEqual([PDS]);
	});

	it("keeps held keys without asking", async () => {
		answers(false);

		const choice = await chooseRotationKeys({
			...base,
			currentKeys: [SOURCE, RECOVERY],
			heldKeys: [RECOVERY],
		});

		expect(confirm).toHaveBeenCalledTimes(1);
		expect(confirm.mock.calls[0]![0].message).toContain(SOURCE);
		expect(choice.rotationKeys).toEqual([RECOVERY, PDS]);
		expect(choice.removed).toEqual([SOURCE]);
		expect(backup).not.toHaveBeenCalled();
	});

	it("generates and adds a recovery key once the user has saved it", async () => {
		answers(true);
		backup.mockResolvedValueOnce(true);

		const choice = await chooseRotationKeys({
			...base,
			currentKeys: [SOURCE],
			sourcePdsKeys: [SOURCE],
		});

		expect(choice.createdRecoveryKey).toBe(true);
		expect(choice.rotationKeys).toHaveLength(2);
		const [recovery, pds] = choice.rotationKeys;
		expect(recovery).toMatch(/^did:key:zQ3s/);
		expect(pds).toBe(PDS);

		const backupOptions = backup.mock.calls[0]![0];
		expect(backupOptions.kind).toBe("recovery");
		expect(backupOptions.allowSkip).toBe(false);
		expect(backupOptions.key).toMatch(/^z/);
		expect(backupOptions.details).toContain(`Public key: ${recovery}`);
	});

	it("retries the backup until the user confirms", async () => {
		answers(true, true);
		backup.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

		const choice = await chooseRotationKeys({
			...base,
			currentKeys: [SOURCE],
			sourcePdsKeys: [SOURCE],
		});

		expect(backup).toHaveBeenCalledTimes(2);
		expect(choice.createdRecoveryKey).toBe(true);
	});

	it("leaves the recovery key out if the user gives up saving it", async () => {
		answers(true, false);
		backup.mockResolvedValueOnce(false);

		const choice = await chooseRotationKeys({
			...base,
			currentKeys: [SOURCE],
			sourcePdsKeys: [SOURCE],
		});

		expect(choice.createdRecoveryKey).toBe(false);
		expect(choice.rotationKeys).toEqual([PDS]);
	});

	it("does not offer a recovery key when the user already holds one", async () => {
		answers(true);

		await chooseRotationKeys({
			...base,
			currentKeys: [RECOVERY, SOURCE],
			sourcePdsKeys: [SOURCE],
		});

		expect(backup).not.toHaveBeenCalled();
	});

	it("keeps the PDS key last when it is already a rotation key", async () => {
		answers(true);

		const choice = await chooseRotationKeys({
			...base,
			currentKeys: [PDS, RECOVERY],
			sourcePdsKeys: [],
		});

		expect(confirm).toHaveBeenCalledTimes(1);
		expect(choice.rotationKeys).toEqual([RECOVERY, PDS]);
		expect(choice.removed).toEqual([]);
	});

	it("refuses to keep more keys than leave room for the PDS key", async () => {
		const keys = [1, 2, 3, 4, 5].map((n) => `did:key:zUser${n}`);
		answers(true, true, true, true, true);

		await expect(
			chooseRotationKeys({ ...base, currentKeys: keys, sourcePdsKeys: [] }),
		).rejects.toThrow("at most 5 rotation keys");
	});
});

describe("describeRotationKeys", () => {
	it("lists keys in priority order with descriptions, then removed keys", () => {
		const lines = describeRotationKeys({
			rotationKeys: [RECOVERY, PDS],
			descriptions: new Map([
				[RECOVERY, "your key"],
				[PDS, "pds.example.com (this PDS)"],
				[SOURCE, "bsky.social"],
			]),
			removed: [SOURCE],
			createdRecoveryKey: false,
		}).join("\n");

		expect(lines.indexOf(RECOVERY)).toBeLessThan(lines.indexOf(PDS));
		expect(lines).toContain("1. " + RECOVERY);
		expect(lines).toContain("2. " + PDS);
		expect(lines).toContain("Removed:");
		expect(lines.indexOf("Removed:")).toBeLessThan(lines.indexOf(SOURCE));
		expect(lines).toContain("bsky.social");
	});
});

describe("checkRotationKeys", () => {
	function plcWith(operation: Record<string, unknown> | null) {
		return {
			getLatestOperation: vi.fn(async () => (operation ? { operation } : null)),
		} as unknown as PlcDirectoryClient;
	}

	it("returns null when the keys match in order", async () => {
		const plc = plcWith({
			type: "plc_operation",
			rotationKeys: [RECOVERY, PDS],
		});
		expect(await checkRotationKeys(plc, base.did, [RECOVERY, PDS])).toBeNull();
	});

	it("returns the actual keys when the order differs", async () => {
		const plc = plcWith({
			type: "plc_operation",
			rotationKeys: [PDS, RECOVERY],
		});
		expect(await checkRotationKeys(plc, base.did, [RECOVERY, PDS])).toEqual([
			PDS,
			RECOVERY,
		]);
	});

	it("returns no keys for a tombstoned DID", async () => {
		const plc = plcWith({ type: "plc_tombstone" });
		expect(await checkRotationKeys(plc, base.did, [PDS])).toEqual([]);
	});
});
