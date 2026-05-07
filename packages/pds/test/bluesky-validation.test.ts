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
			const result = validator.validate({
				collection: "app.bsky.feed.post",
				record: {
					$type: "app.bsky.feed.post",
					text: "Hello, Bluesky!",
					createdAt: new Date().toISOString(),
				},
			});
			expect(result.status).toBe("valid");
		});

		it("rejects posts with missing required fields", () => {
			expect(() => {
				validator.validate({
					collection: "app.bsky.feed.post",
					record: {
						$type: "app.bsky.feed.post",
						text: "Hello",
					},
				});
			}).toThrow(/invalid app\.bsky\.feed\.post record/i);
		});

		it("rejects posts with text exceeding maxLength", () => {
			const longText = "x".repeat(3001);

			expect(() => {
				validator.validate({
					collection: "app.bsky.feed.post",
					record: {
						$type: "app.bsky.feed.post",
						text: longText,
						createdAt: new Date().toISOString(),
					},
				});
			}).toThrow(/invalid app\.bsky\.feed\.post record/i);
		});

		it("allows posts with optional fields", () => {
			const result = validator.validate({
				collection: "app.bsky.feed.post",
				record: {
					$type: "app.bsky.feed.post",
					text: "Post with langs",
					createdAt: new Date().toISOString(),
					langs: ["en"],
				},
			});
			expect(result.status).toBe("valid");
		});
	});

	describe("app.bsky.actor.profile", () => {
		it("validates valid profiles", () => {
			const result = validator.validate({
				collection: "app.bsky.actor.profile",
				record: {
					$type: "app.bsky.actor.profile",
					displayName: "Alice",
					description: "A test user",
				},
				rkey: "self",
			});
			expect(result.status).toBe("valid");
		});

		it("allows empty profiles", () => {
			const result = validator.validate({
				collection: "app.bsky.actor.profile",
				record: { $type: "app.bsky.actor.profile" },
				rkey: "self",
			});
			expect(result.status).toBe("valid");
		});
	});

	describe("app.bsky.feed.like", () => {
		it("rejects likes without required fields", () => {
			expect(() => {
				validator.validate({
					collection: "app.bsky.feed.like",
					record: {
						$type: "app.bsky.feed.like",
						createdAt: new Date().toISOString(),
					},
				});
			}).toThrow(/invalid app\.bsky\.feed\.like record/i);

			expect(() => {
				validator.validate({
					collection: "app.bsky.feed.like",
					record: {
						$type: "app.bsky.feed.like",
						subject: {
							uri: "at://did:plc:abc123/app.bsky.feed.post/xyz",
							cid: "invalid-cid-format",
						},
					},
				});
			}).toThrow(/invalid app\.bsky\.feed\.like record/i);
		});
	});

	describe("app.bsky.graph.follow", () => {
		it("validates valid follows", () => {
			const result = validator.validate({
				collection: "app.bsky.graph.follow",
				record: {
					$type: "app.bsky.graph.follow",
					subject: "did:plc:abc123",
					createdAt: new Date().toISOString(),
				},
			});
			expect(result.status).toBe("valid");
		});

		it("rejects follows without subject", () => {
			expect(() => {
				validator.validate({
					collection: "app.bsky.graph.follow",
					record: {
						$type: "app.bsky.graph.follow",
						createdAt: new Date().toISOString(),
					},
				});
			}).toThrow(/invalid app\.bsky\.graph\.follow record/i);
		});
	});

	describe("unknown schemas (optimistic validation)", () => {
		it("allows records for unknown schemas with status 'unknown'", () => {
			const result = validator.validate({
				collection: "com.example.custom",
				record: { customField: "value" },
			});
			expect(result.status).toBe("unknown");
		});
	});
});
