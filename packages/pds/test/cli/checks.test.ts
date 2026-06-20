/**
 * Tests for CLI preflight check helpers.
 *
 * `checkRepoDidMatches` is a pure function; we exercise its three branches
 * (matching DID, mismatched DID, and no-repo-yet) directly.
 */
import { describe, it, expect } from "vitest";
import { checkRepoDidMatches } from "../../src/cli/utils/checks.js";
import type { MigrationStatus } from "../../src/cli/utils/pds-client.js";

function makeStatus(overrides: Partial<MigrationStatus> = {}): MigrationStatus {
	return {
		activated: true,
		active: true,
		validDid: true,
		did: "did:plc:account",
		repoCommit: "bafyreigh2akiscaildc7ypw7e6tqocp3vy3uwgyq37e6kz3sm6f5l3hbjm",
		repoRev: "3kabc",
		repoBlocks: 10,
		indexedRecords: 5,
		expectedBlobs: 0,
		importedBlobs: 0,
		...overrides,
	};
}

describe("checkRepoDidMatches", () => {
	it("passes when the repo DID matches the account DID", () => {
		const result = checkRepoDidMatches(
			makeStatus({ did: "did:plc:account" }),
			"did:plc:account",
		);
		expect(result.ok).toBe(true);
		expect(result.message).toContain("matches account DID");
	});

	it("fails with reset guidance when the repo DID differs", () => {
		const result = checkRepoDidMatches(
			makeStatus({ did: "did:web:pds.example.com" }),
			"did:plc:account",
		);
		expect(result.ok).toBe(false);
		expect(result.message).toContain("did:web:pds.example.com");
		expect(result.message).toContain("did:plc:account");
		expect(result.detail).toContain("resetMigration");
	});

	it("passes (skips) when no repo exists yet", () => {
		const result = checkRepoDidMatches(
			makeStatus({ did: null }),
			"did:plc:account",
		);
		expect(result.ok).toBe(true);
		expect(result.message).toContain("no repo yet");
	});
});
