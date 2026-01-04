import { describe, it, expect } from "vitest";
import { parseProxyHeader } from "../src/xrpc-proxy";

describe("DID Resolver", () => {
	describe("parseProxyHeader", () => {
		it("should parse valid proxy header", () => {
			const result = parseProxyHeader("did:web:example.com#atproto_labeler");
			expect(result).toEqual({
				did: "did:web:example.com",
				serviceId: "atproto_labeler",
			});
		});

		it("should parse did:plc header", () => {
			const result = parseProxyHeader("did:plc:abc123xyz#atproto_labeler");
			expect(result).toEqual({
				did: "did:plc:abc123xyz",
				serviceId: "atproto_labeler",
			});
		});

		it("should return null for invalid format (no hash)", () => {
			const result = parseProxyHeader("did:web:example.com");
			expect(result).toBeNull();
		});

		it("should return null for invalid format (not a DID)", () => {
			const result = parseProxyHeader("https://example.com#service");
			expect(result).toBeNull();
		});

		it("should return null for multiple hashes", () => {
			const result = parseProxyHeader("did:web:example.com#service#extra");
			expect(result).toBeNull();
		});
	});
});
