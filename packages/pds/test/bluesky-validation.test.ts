import { describe, it, expect } from "vitest";
import { validator } from "../src/validation";

describe("Bluesky Schema Validation", () => {
	it("loads official Bluesky schemas", () => {
		const schemas = validator.getLoadedSchemas();

		expect(schemas).toContain("app.bsky.feed.post");
		expect(schemas).toContain("app.bsky.actor.profile");
		expect(schemas).toContain("app.bsky.feed.like");
		expect(schemas).toContain("app.bsky.feed.repost");
		expect(schemas).toContain("app.bsky.graph.follow");
		expect(schemas).toContain("app.bsky.graph.block");

		expect(schemas.length).toBeGreaterThanOrEqual(6);
	});

	describe("app.bsky.feed.post", () => {
		it("validates valid posts", () => {
			expect(() => {
				validator.validateRecord("app.bsky.feed.post", {
					$type: "app.bsky.feed.post",
					text: "Hello, Bluesky!",
					createdAt: new Date().toISOString(),
				});
			}).not.toThrow();
		});

		it("rejects posts with missing required fields", () => {
			expect(() => {
				validator.validateRecord("app.bsky.feed.post", {
					$type: "app.bsky.feed.post",
					text: "Hello",
					// Missing createdAt
				});
			}).toThrow(/validation failed/i);
		});

		it("rejects posts with text exceeding maxLength", () => {
			const longText = "x".repeat(3001); // maxLength is 3000

			expect(() => {
				validator.validateRecord("app.bsky.feed.post", {
					$type: "app.bsky.feed.post",
					text: longText,
					createdAt: new Date().toISOString(),
				});
			}).toThrow(/validation failed/i);
		});

		it("allows posts with optional fields", () => {
			expect(() => {
				validator.validateRecord("app.bsky.feed.post", {
					$type: "app.bsky.feed.post",
					text: "Post with langs",
					createdAt: new Date().toISOString(),
					langs: ["en"],
				});
			}).not.toThrow();
		});
	});

	describe("app.bsky.actor.profile", () => {
		it("validates valid profiles", () => {
			expect(() => {
				validator.validateRecord("app.bsky.actor.profile", {
					$type: "app.bsky.actor.profile",
					displayName: "Alice",
					description: "A test user",
				});
			}).not.toThrow();
		});

		it("allows empty profiles", () => {
			expect(() => {
				validator.validateRecord("app.bsky.actor.profile", {
					$type: "app.bsky.actor.profile",
				});
			}).not.toThrow();
		});
	});

	describe("app.bsky.feed.like", () => {
		it("rejects likes without required fields", () => {
			expect(() => {
				validator.validateRecord("app.bsky.feed.like", {
					$type: "app.bsky.feed.like",
					createdAt: new Date().toISOString(),
					// Missing subject
				});
			}).toThrow(/validation failed/i);

			expect(() => {
				validator.validateRecord("app.bsky.feed.like", {
					$type: "app.bsky.feed.like",
					subject: {
						uri: "at://did:plc:abc123/app.bsky.feed.post/xyz",
						cid: "invalid-cid-format",
					},
					// Missing createdAt
				});
			}).toThrow(/validation failed/i);
		});
	});

	describe("app.bsky.graph.follow", () => {
		it("validates valid follows", () => {
			expect(() => {
				validator.validateRecord("app.bsky.graph.follow", {
					$type: "app.bsky.graph.follow",
					subject: "did:plc:abc123",
					createdAt: new Date().toISOString(),
				});
			}).not.toThrow();
		});

		it("rejects follows without subject", () => {
			expect(() => {
				validator.validateRecord("app.bsky.graph.follow", {
					$type: "app.bsky.graph.follow",
					createdAt: new Date().toISOString(),
					// Missing subject DID
				});
			}).toThrow(/validation failed/i);
		});
	});

	describe("unknown schemas (optimistic validation)", () => {
		it("allows records for unknown schemas", () => {
			expect(() => {
				validator.validateRecord("com.example.custom", {
					customField: "value",
				});
			}).not.toThrow();
		});
	});
});
