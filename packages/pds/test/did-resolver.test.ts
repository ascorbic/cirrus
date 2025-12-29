import { describe, it, expect } from "vitest";
import { parseProxyHeader } from "../src/xrpc-proxy";
import { getServiceEndpoint, type DidDocument } from "@atproto/common-web";

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
			const result = parseProxyHeader(
				"did:plc:abc123xyz#atproto_labeler",
			);
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

	describe("getServiceEndpoint", () => {
		it("should extract endpoint with fragment-only ID", () => {
			const doc: DidDocument = {
				id: "did:web:example.com",
				service: [
					{
						id: "#atproto_labeler",
						type: "AtprotoLabeler",
						serviceEndpoint: "https://labeler.example.com",
					},
				],
			};

			const endpoint = getServiceEndpoint(doc, { id: "#atproto_labeler" });
			expect(endpoint).toBe("https://labeler.example.com");
		});

		it("should extract endpoint with full ID", () => {
			const doc: DidDocument = {
				id: "did:web:example.com",
				service: [
					{
						id: "did:web:example.com#atproto_labeler",
						type: "AtprotoLabeler",
						serviceEndpoint: "https://labeler.example.com",
					},
				],
			};

			const endpoint = getServiceEndpoint(doc, { id: "#atproto_labeler" });
			expect(endpoint).toBe("https://labeler.example.com");
		});

		it("should extract endpoint when serviceId includes hash", () => {
			const doc: DidDocument = {
				id: "did:web:example.com",
				service: [
					{
						id: "#atproto_labeler",
						type: "AtprotoLabeler",
						serviceEndpoint: "https://labeler.example.com",
					},
				],
			};

			const endpoint = getServiceEndpoint(doc, { id: "#atproto_labeler" });
			expect(endpoint).toBe("https://labeler.example.com");
		});

		it("should return undefined for non-existent service", () => {
			const doc: DidDocument = {
				id: "did:web:example.com",
				service: [
					{
						id: "#atproto_labeler",
						type: "AtprotoLabeler",
						serviceEndpoint: "https://labeler.example.com",
					},
				],
			};

			const endpoint = getServiceEndpoint(doc, { id: "#nonexistent" });
			expect(endpoint).toBeUndefined();
		});

		it("should return undefined when no services exist", () => {
			const doc: DidDocument = {
				id: "did:web:example.com",
			};

			const endpoint = getServiceEndpoint(doc, { id: "#atproto_labeler" });
			expect(endpoint).toBeUndefined();
		});

		it("should handle multiple services", () => {
			const doc: DidDocument = {
				id: "did:web:example.com",
				service: [
					{
						id: "#atproto_pds",
						type: "AtprotoPersonalDataServer",
						serviceEndpoint: "https://pds.example.com",
					},
					{
						id: "#atproto_labeler",
						type: "AtprotoLabeler",
						serviceEndpoint: "https://labeler.example.com",
					},
				],
			};

			const endpoint = getServiceEndpoint(doc, { id: "#atproto_labeler" });
			expect(endpoint).toBe("https://labeler.example.com");
		});
	});
});
