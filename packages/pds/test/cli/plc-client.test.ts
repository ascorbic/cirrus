/**
 * Tests for PLC client utilities
 *
 * These test the SourcePdsPlcClient and PlcDirectoryClient classes.
 * For getPdsEndpoint and getAtprotoVerificationMaterial, we use them
 * directly from @atcute/identity (no need to re-test library code).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
	SourcePdsPlcClient,
	PlcDirectoryClient,
} from "../../src/cli/utils/plc-client.js";

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

beforeEach(() => {
	mockFetch.mockReset();
});

afterEach(() => {
	vi.restoreAllMocks();
});

/**
 * Create a mock Response that matches what @atcute/client expects
 */
function mockXrpcResponse(body: unknown, status = 200) {
	return {
		ok: status >= 200 && status < 300,
		status,
		headers: new Headers({ "content-type": "application/json" }),
		json: () => Promise.resolve(body),
		text: () => Promise.resolve(JSON.stringify(body)),
	};
}

describe("SourcePdsPlcClient", () => {
	describe("requestPlcOperationSignature", () => {
		it("returns success when request succeeds", async () => {
			// This endpoint returns 200 with empty body on success
			mockFetch.mockResolvedValueOnce(mockXrpcResponse({}));

			const client = new SourcePdsPlcClient(
				"https://bsky.social",
				"test-token",
			);
			const result = await client.requestPlcOperationSignature();

			expect(result.success).toBe(true);
			expect(result.credentialInfo?.type).toBe("email");
		});

		it("returns error on network failure", async () => {
			mockFetch.mockRejectedValueOnce(new Error("Network error"));

			const client = new SourcePdsPlcClient(
				"https://bsky.social",
				"test-token",
			);
			const result = await client.requestPlcOperationSignature();

			expect(result.success).toBe(false);
			expect(result.error).toBe("Network error");
		});

		it("sends auth header when token provided", async () => {
			mockFetch.mockResolvedValueOnce(mockXrpcResponse({}));

			const client = new SourcePdsPlcClient("https://bsky.social", "my-token");
			await client.requestPlcOperationSignature();

			const [, init] = mockFetch.mock.calls[0];
			const headers = init.headers as Headers;
			expect(headers.get("Authorization")).toBe("Bearer my-token");
		});
	});

	describe("signPlcOperation", () => {
		it("returns signed operation on success", async () => {
			const mockOperation = {
				type: "plc_operation",
				prev: "abc123",
				sig: "xyz789",
				rotationKeys: ["did:key:rot1"],
				verificationMethods: { atproto: "did:key:new" },
				alsoKnownAs: ["at://user.bsky.social"],
				services: {
					atproto_pds: {
						type: "AtprotoPersonalDataServer",
						endpoint: "https://new-pds.com",
					},
				},
			};

			mockFetch.mockResolvedValueOnce(
				mockXrpcResponse({ operation: mockOperation }),
			);

			const client = new SourcePdsPlcClient(
				"https://bsky.social",
				"test-token",
			);
			const result = await client.signPlcOperation(
				"email-token",
				"https://new-pds.com",
				"did:key:new",
			);

			expect(result.success).toBe(true);
			expect(result.signedOperation).toEqual(mockOperation);
		});

		it("handles expired token error", async () => {
			mockFetch.mockRejectedValueOnce(new Error("ExpiredToken: token expired"));

			const client = new SourcePdsPlcClient(
				"https://bsky.social",
				"test-token",
			);
			const result = await client.signPlcOperation(
				"old-token",
				"https://new-pds.com",
				"did:key:new",
			);

			expect(result.success).toBe(false);
			expect(result.error).toContain("expired");
		});

		it("handles invalid token error", async () => {
			mockFetch.mockRejectedValueOnce(new Error("InvalidToken: bad token"));

			const client = new SourcePdsPlcClient(
				"https://bsky.social",
				"test-token",
			);
			const result = await client.signPlcOperation(
				"bad-token",
				"https://new-pds.com",
				"did:key:new",
			);

			expect(result.success).toBe(false);
			expect(result.error).toContain("Invalid token");
		});
	});

	describe("setAuthToken", () => {
		it("updates auth token for subsequent requests", async () => {
			mockFetch.mockResolvedValue(mockXrpcResponse({}));

			const client = new SourcePdsPlcClient("https://bsky.social");
			client.setAuthToken("new-token");
			await client.requestPlcOperationSignature();

			const [, init] = mockFetch.mock.calls[0];
			const headers = init.headers as Headers;
			expect(headers.get("Authorization")).toBe("Bearer new-token");
		});
	});
});

describe("PlcDirectoryClient", () => {
	describe("getAuditLog", () => {
		it("returns audit log on success", async () => {
			const mockLog = [
				{
					did: "did:plc:abc123",
					operation: { type: "plc_operation", prev: null, sig: "sig1" },
					cid: "cid1",
					nullified: false,
					createdAt: "2024-01-01T00:00:00Z",
				},
			];

			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: () => Promise.resolve(mockLog),
			});

			const client = new PlcDirectoryClient();
			const result = await client.getAuditLog("did:plc:abc123");

			expect(result).toEqual(mockLog);
			expect(mockFetch).toHaveBeenCalledWith(
				"https://plc.directory/did:plc:abc123/log/audit",
			);
		});

		it("throws on HTTP error", async () => {
			mockFetch.mockResolvedValueOnce({
				ok: false,
				status: 404,
			});

			const client = new PlcDirectoryClient();
			await expect(client.getAuditLog("did:plc:notfound")).rejects.toThrow(
				"Failed to fetch audit log: 404",
			);
		});
	});

	describe("getDocument", () => {
		it("returns document on success", async () => {
			const mockDoc = {
				id: "did:plc:abc123",
				service: [
					{
						id: "#atproto_pds",
						type: "AtprotoPersonalDataServer",
						serviceEndpoint: "https://pds.example.com",
					},
				],
			};

			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: () => Promise.resolve(mockDoc),
			});

			const client = new PlcDirectoryClient();
			const result = await client.getDocument("did:plc:abc123");

			expect(result).toEqual(mockDoc);
		});

		it("returns null on 404", async () => {
			mockFetch.mockResolvedValueOnce({
				ok: false,
				status: 404,
			});

			const client = new PlcDirectoryClient();
			const result = await client.getDocument("did:plc:notfound");

			expect(result).toBeNull();
		});

		it("throws on other HTTP errors", async () => {
			mockFetch.mockResolvedValueOnce({
				ok: false,
				status: 500,
			});

			const client = new PlcDirectoryClient();
			await expect(client.getDocument("did:plc:abc123")).rejects.toThrow(
				"Failed to fetch DID document: 500",
			);
		});
	});

	describe("submitOperation", () => {
		it("returns success when operation accepted", async () => {
			mockFetch.mockResolvedValueOnce({
				ok: true,
			});

			const client = new PlcDirectoryClient();
			const result = await client.submitOperation("did:plc:abc123", {
				type: "plc_operation",
				prev: "abc",
				sig: "xyz",
				rotationKeys: ["did:key:rot"],
				verificationMethods: { atproto: "did:key:sig" },
				alsoKnownAs: ["at://user.bsky.social"],
				services: {
					atproto_pds: {
						type: "AtprotoPersonalDataServer",
						endpoint: "https://pds.example.com",
					},
				},
			});

			expect(result.success).toBe(true);
		});

		it("returns error when operation rejected", async () => {
			mockFetch.mockResolvedValueOnce({
				ok: false,
				text: () => Promise.resolve("invalid signature"),
			});

			const client = new PlcDirectoryClient();
			const result = await client.submitOperation("did:plc:abc123", {
				type: "plc_operation",
				prev: "abc",
				sig: "bad",
				rotationKeys: [],
				verificationMethods: {},
				alsoKnownAs: [],
				services: {},
			});

			expect(result.success).toBe(false);
			expect(result.error).toContain("invalid signature");
		});

		it("handles network errors", async () => {
			mockFetch.mockRejectedValueOnce(new Error("Connection refused"));

			const client = new PlcDirectoryClient();
			const result = await client.submitOperation("did:plc:abc123", {
				type: "plc_operation",
				prev: null,
				sig: "xyz",
				rotationKeys: [],
				verificationMethods: {},
				alsoKnownAs: [],
				services: {},
			});

			expect(result.success).toBe(false);
			expect(result.error).toBe("Connection refused");
		});
	});

	describe("custom PLC URL", () => {
		it("uses custom URL when provided", async () => {
			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: () => Promise.resolve([]),
			});

			const client = new PlcDirectoryClient("https://custom-plc.example.com");
			await client.getAuditLog("did:plc:abc123");

			expect(mockFetch).toHaveBeenCalledWith(
				"https://custom-plc.example.com/did:plc:abc123/log/audit",
			);
		});
	});
});
