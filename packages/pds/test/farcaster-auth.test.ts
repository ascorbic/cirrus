/**
 * Tests for farcaster-auth.ts utilities
 */
import { describe, it, expect } from "vitest";
import {
	fidToDid,
	fidToHandle,
	didToFid,
	hostnameToFid,
} from "../src/farcaster-auth";

const TEST_DOMAIN = "fid.is";

describe("fidToDid", () => {
	it("derives DID from FID", () => {
		expect(fidToDid("123", TEST_DOMAIN)).toBe("did:web:123.fid.is");
		expect(fidToDid("1", TEST_DOMAIN)).toBe("did:web:1.fid.is");
		expect(fidToDid("999999", TEST_DOMAIN)).toBe("did:web:999999.fid.is");
	});

	it("works with custom domains", () => {
		expect(fidToDid("123", "example.com")).toBe("did:web:123.example.com");
	});
});

describe("fidToHandle", () => {
	it("derives handle from FID", () => {
		expect(fidToHandle("123", TEST_DOMAIN)).toBe("123.fid.is");
		expect(fidToHandle("1", TEST_DOMAIN)).toBe("1.fid.is");
	});

	it("works with custom domains", () => {
		expect(fidToHandle("123", "example.com")).toBe("123.example.com");
	});
});

describe("didToFid", () => {
	it("extracts FID from valid DID", () => {
		expect(didToFid("did:web:123.fid.is", TEST_DOMAIN)).toBe("123");
		expect(didToFid("did:web:1.fid.is", TEST_DOMAIN)).toBe("1");
		expect(didToFid("did:web:999999.fid.is", TEST_DOMAIN)).toBe("999999");
	});

	it("returns null for invalid DID format", () => {
		expect(didToFid("did:plc:abc123", TEST_DOMAIN)).toBeNull();
		expect(didToFid("did:web:alice.example.com", TEST_DOMAIN)).toBeNull();
		expect(didToFid("not-a-did", TEST_DOMAIN)).toBeNull();
		expect(didToFid("", TEST_DOMAIN)).toBeNull();
	});

	it("returns null for wrong domain", () => {
		expect(didToFid("did:web:123.example.com", TEST_DOMAIN)).toBeNull();
	});

	it("rejects leading zeros", () => {
		expect(didToFid("did:web:0123.fid.is", TEST_DOMAIN)).toBeNull();
		expect(didToFid("did:web:01989.fid.is", TEST_DOMAIN)).toBeNull();
		expect(didToFid("did:web:007.fid.is", TEST_DOMAIN)).toBeNull();
	});

	it("rejects zero (FID must be positive)", () => {
		expect(didToFid("did:web:0.fid.is", TEST_DOMAIN)).toBeNull();
	});
});

describe("hostnameToFid", () => {
	it("extracts FID from valid subdomain", () => {
		expect(hostnameToFid("123.fid.is", TEST_DOMAIN)).toBe("123");
		expect(hostnameToFid("1.fid.is", TEST_DOMAIN)).toBe("1");
		expect(hostnameToFid("999999.fid.is", TEST_DOMAIN)).toBe("999999");
	});

	it("returns null for invalid hostname format", () => {
		expect(hostnameToFid("alice.fid.is", TEST_DOMAIN)).toBeNull();
		expect(hostnameToFid("fid.is", TEST_DOMAIN)).toBeNull();
		expect(hostnameToFid("123.example.com", TEST_DOMAIN)).toBeNull();
		expect(hostnameToFid("", TEST_DOMAIN)).toBeNull();
	});

	it("rejects leading zeros", () => {
		expect(hostnameToFid("0123.fid.is", TEST_DOMAIN)).toBeNull();
		expect(hostnameToFid("01989.fid.is", TEST_DOMAIN)).toBeNull();
		expect(hostnameToFid("007.fid.is", TEST_DOMAIN)).toBeNull();
	});

	it("rejects zero (FID must be positive)", () => {
		expect(hostnameToFid("0.fid.is", TEST_DOMAIN)).toBeNull();
	});

	it("handles domains with special regex characters", () => {
		// Domain with dots should be escaped properly
		expect(hostnameToFid("123.test.local", "test.local")).toBe("123");
		// Should not match if dots aren't real dots
		expect(hostnameToFid("123atestblocal", "test.local")).toBeNull();
	});
});

describe("round-trip conversion", () => {
	it("FID -> DID -> FID", () => {
		const fid = "12345";
		const did = fidToDid(fid, TEST_DOMAIN);
		const extractedFid = didToFid(did, TEST_DOMAIN);
		expect(extractedFid).toBe(fid);
	});

	it("FID -> handle -> hostname extraction", () => {
		const fid = "12345";
		const handle = fidToHandle(fid, TEST_DOMAIN);
		// Handle initially matches hostname format
		const extractedFid = hostnameToFid(handle, TEST_DOMAIN);
		expect(extractedFid).toBe(fid);
	});
});
