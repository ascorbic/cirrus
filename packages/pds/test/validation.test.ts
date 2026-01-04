import { describe, it, expect } from "vitest";
import { RecordValidator, validator } from "../src/validation";

describe("RecordValidator", () => {
	describe("optimistic validation (default)", () => {
		it("allows records for unknown schemas", () => {
			const v = new RecordValidator({ strict: false });
			// Should not throw for unknown collection
			expect(() => {
				v.validateRecord("com.example.unknown", {
					text: "test",
					createdAt: new Date().toISOString(),
				});
			}).not.toThrow();
		});

		it("validates records when schema is loaded", () => {
			const v = new RecordValidator({ strict: false });
			// Valid post should pass
			expect(() => {
				v.validateRecord("app.bsky.feed.post", {
					$type: "app.bsky.feed.post",
					text: "Hello world",
					createdAt: new Date().toISOString(),
				});
			}).not.toThrow();

			// Invalid post (missing createdAt) should fail
			expect(() => {
				v.validateRecord("app.bsky.feed.post", {
					$type: "app.bsky.feed.post",
					text: "Hello world",
				});
			}).toThrow(/validation failed/i);
		});

		it("checks if schema is loaded", () => {
			const v = new RecordValidator();
			expect(v.hasSchema("app.bsky.feed.post")).toBe(true);
			expect(v.hasSchema("app.bsky.actor.profile")).toBe(true);
			expect(v.hasSchema("com.example.unknown")).toBe(false);
		});

		it("lists loaded schemas", () => {
			const v = new RecordValidator();
			const schemas = v.getLoadedSchemas();
			expect(schemas).toContain("app.bsky.feed.post");
			expect(schemas).toContain("app.bsky.actor.profile");
			expect(schemas).toContain("app.bsky.graph.follow");
			expect(schemas.length).toBeGreaterThanOrEqual(10);
		});
	});

	describe("strict mode", () => {
		it("rejects records for unknown schemas", () => {
			const v = new RecordValidator({ strict: true });
			expect(() => {
				v.validateRecord("com.example.unknown", {
					text: "test",
				});
			}).toThrow(/no lexicon schema loaded/i);
		});

		it("validates records when schema is loaded", () => {
			const v = new RecordValidator({ strict: true });
			// Valid record should pass
			expect(() => {
				v.validateRecord("app.bsky.feed.post", {
					$type: "app.bsky.feed.post",
					text: "Hello world",
					createdAt: new Date().toISOString(),
				});
			}).not.toThrow();
		});
	});

	describe("maxLength validation", () => {
		it("rejects strings exceeding maxLength", () => {
			const v = new RecordValidator();
			const longText = "x".repeat(3001); // post maxLength is 3000

			// Short text should pass
			expect(() => {
				v.validateRecord("app.bsky.feed.post", {
					$type: "app.bsky.feed.post",
					text: "short",
					createdAt: new Date().toISOString(),
				});
			}).not.toThrow();

			// Long text should fail
			expect(() => {
				v.validateRecord("app.bsky.feed.post", {
					$type: "app.bsky.feed.post",
					text: longText,
					createdAt: new Date().toISOString(),
				});
			}).toThrow(/validation failed/i);
		});
	});

	describe("required fields validation", () => {
		it("rejects records missing required fields", () => {
			const v = new RecordValidator();

			// Complete record should pass
			expect(() => {
				v.validateRecord("app.bsky.graph.follow", {
					$type: "app.bsky.graph.follow",
					subject: "did:plc:abc123",
					createdAt: new Date().toISOString(),
				});
			}).not.toThrow();

			// Incomplete record should fail (missing subject)
			expect(() => {
				v.validateRecord("app.bsky.graph.follow", {
					$type: "app.bsky.graph.follow",
					createdAt: new Date().toISOString(),
				});
			}).toThrow(/validation failed/i);
		});
	});

	describe("shared validator instance", () => {
		it("exports a shared validator instance", () => {
			expect(validator).toBeInstanceOf(RecordValidator);
			expect(validator.hasSchema("app.bsky.feed.post")).toBe(true);
		});
	});
});
