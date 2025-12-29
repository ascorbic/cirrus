import { describe, it, expect } from "vitest";
import { parseProxyHeader } from "../src/xrpc-proxy";
import { getServiceEndpoint, type DidDocument } from "@atproto/common-web";

describe("DID Resolver URL Validation", () => {
	describe("Protocol validation", () => {
		it("should reject non-HTTP(S) URLs", () => {
			const doc: DidDocument = {
				id: "did:web:example.com",
				service: [
					{
						id: "#atproto_labeler",
						type: "AtprotoLabeler",
						serviceEndpoint: "ftp://example.com",
					},
				],
			};

			const endpoint = getServiceEndpoint(doc, { id: "#atproto_labeler" });
			expect(endpoint).toBeUndefined();
		});

		it("should reject invalid URLs", () => {
			const doc: DidDocument = {
				id: "did:web:example.com",
				service: [
					{
						id: "#atproto_labeler",
						type: "AtprotoLabeler",
						serviceEndpoint: "not-a-url",
					},
				],
			};

			const endpoint = getServiceEndpoint(doc, { id: "#atproto_labeler" });
			expect(endpoint).toBeUndefined();
		});

		it("should allow HTTP URLs", () => {
			const doc: DidDocument = {
				id: "did:web:example.com",
				service: [
					{
						id: "#atproto_labeler",
						type: "AtprotoLabeler",
						serviceEndpoint: "http://example.com",
					},
				],
			};

			const endpoint = getServiceEndpoint(doc, { id: "#atproto_labeler" });
			expect(endpoint).toBe("http://example.com");
		});

		it("should allow HTTPS URLs", () => {
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

		it("should allow URLs with ports", () => {
			const doc: DidDocument = {
				id: "did:web:example.com",
				service: [
					{
						id: "#atproto_labeler",
						type: "AtprotoLabeler",
						serviceEndpoint: "https://labeler.example.com:8443",
					},
				],
			};

			const endpoint = getServiceEndpoint(doc, { id: "#atproto_labeler" });
			expect(endpoint).toBe("https://labeler.example.com:8443");
		});

		it("should allow URLs with paths", () => {
			const doc: DidDocument = {
				id: "did:web:example.com",
				service: [
					{
						id: "#atproto_labeler",
						type: "AtprotoLabeler",
						serviceEndpoint: "https://example.com/labeler",
					},
				],
			};

			const endpoint = getServiceEndpoint(doc, { id: "#atproto_labeler" });
			expect(endpoint).toBe("https://example.com/labeler");
		});
	});

	describe("Service ID matching", () => {
		it("should match service ID with hash prefix", () => {
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

		it("should match service ID without hash prefix", () => {
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

		it("should match full service ID", () => {
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
	});
});
