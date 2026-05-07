import { describe, it, expect } from "vitest";
import {
	InvalidRecordError,
	RecordValidator,
	validator,
} from "../src/validation";

const post = (overrides: Record<string, unknown> = {}) => ({
	$type: "app.bsky.feed.post",
	text: "Hello world",
	createdAt: new Date().toISOString(),
	...overrides,
});

describe("RecordValidator", () => {
	describe("default (optimistic) mode", () => {
		const v = new RecordValidator();

		it("accepts records for unknown collections with status 'unknown'", () => {
			const result = v.validate({
				collection: "com.example.unknown",
				record: { text: "test" },
			});
			expect(result.status).toBe("unknown");
		});

		it("validates known collections and reports 'valid'", () => {
			const result = v.validate({
				collection: "app.bsky.feed.post",
				record: post(),
			});
			expect(result.status).toBe("valid");
		});

		it("throws InvalidRecordError when a known record is invalid", () => {
			expect(() => {
				v.validate({
					collection: "app.bsky.feed.post",
					record: { $type: "app.bsky.feed.post", text: "no createdAt" },
				});
			}).toThrow(InvalidRecordError);
		});
	});

	describe("validate flag", () => {
		const v = new RecordValidator();

		it("validate=true rejects unknown collections", () => {
			expect(() => {
				v.validate({
					collection: "com.example.unknown",
					record: { text: "test" },
					validate: true,
				});
			}).toThrow(/unknown lexicon type/i);
		});

		it("validate=false skips schema validation and round-trips the record", () => {
			const record = {
				$type: "app.bsky.feed.post",
				text: "no createdAt",
			};
			const result = v.validate({
				collection: "app.bsky.feed.post",
				record,
				validate: false,
			});
			expect(result.status).toBeUndefined();
			// Confirm a record that *would* fail schema validation passes through
			// when validate=false (the schema requires createdAt).
			expect(result.record).toMatchObject({
				$type: "app.bsky.feed.post",
				text: "no createdAt",
			});
			expect(result.record.createdAt).toBeUndefined();
		});

		it("validate=false still rejects legacy blob refs", () => {
			expect(() => {
				v.validate({
					collection: "app.bsky.feed.post",
					record: post({
						embed: { cid: "bafyreib2rxk3rybk3aobmv5cjuql3bm2twh4jo5uxgf5kkkqg5jkvqg5va", mimeType: "image/png" },
					}),
					validate: false,
				});
			}).toThrow(/legacy blobs/i);
		});

		it("validate=false still reconciles $type with collection", () => {
			const { record } = v.validate({
				collection: "app.bsky.feed.post",
				record: { text: "no type", createdAt: new Date().toISOString() },
				validate: false,
			});
			expect(record.$type).toBe("app.bsky.feed.post");
		});
	});

	describe("$type reconciliation", () => {
		const v = new RecordValidator();

		it("fills in missing $type from collection", () => {
			const result = v.validate({
				collection: "app.bsky.feed.post",
				record: { text: "Hi", createdAt: new Date().toISOString() },
			});
			expect(result.record.$type).toBe("app.bsky.feed.post");
			expect(result.status).toBe("valid");
		});

		it("rejects mismatched $type", () => {
			expect(() => {
				v.validate({
					collection: "app.bsky.feed.post",
					record: { $type: "app.bsky.feed.like", text: "Hi" },
				});
			}).toThrow(/expected app\.bsky\.feed\.post/);
		});
	});

	describe("rkey validation", () => {
		const v = new RecordValidator();

		it("rejects an invalid rkey for app.bsky.actor.profile (must be 'self')", () => {
			expect(() => {
				v.validate({
					collection: "app.bsky.actor.profile",
					record: { $type: "app.bsky.actor.profile" },
					rkey: "not-self",
				});
			}).toThrow(/invalid record key/i);
		});

		it("rejects empty-string rkey unconditionally (even with validate=false)", () => {
			expect(() => {
				v.validate({
					collection: "com.example.unknown",
					record: { foo: "bar" },
					rkey: "",
					validate: false,
				});
			}).toThrow(/invalid record key/i);
		});

		it("rejects rkey containing path-traversal chars unconditionally", () => {
			expect(() => {
				v.validate({
					collection: "com.example.unknown",
					record: { foo: "bar" },
					rkey: "../etc",
					validate: false,
				});
			}).toThrow(/invalid record key/i);
		});

		it("accepts the literal 'self' rkey for profile", () => {
			const result = v.validate({
				collection: "app.bsky.actor.profile",
				record: { $type: "app.bsky.actor.profile" },
				rkey: "self",
			});
			expect(result.status).toBe("valid");
		});
	});

	describe("legacy blob rejection", () => {
		const v = new RecordValidator();

		it("rejects records containing a legacy blob ref", () => {
			expect(() => {
				v.validate({
					collection: "com.example.unknown",
					record: {
						avatar: {
							cid: "bafyreib2rxk3rybk3aobmv5cjuql3bm2twh4jo5uxgf5kkkqg5jkvqg5va",
							mimeType: "image/png",
						},
					},
				});
			}).toThrow(/legacy blobs/i);
		});
	});

	describe("required fields", () => {
		const v = new RecordValidator();

		it("rejects records missing required fields", () => {
			expect(() => {
				v.validate({
					collection: "app.bsky.graph.follow",
					record: {
						$type: "app.bsky.graph.follow",
						createdAt: new Date().toISOString(),
					},
				});
			}).toThrow(InvalidRecordError);
		});
	});

	describe("schema set", () => {
		const v = new RecordValidator();

		it("includes app.bsky and com.atproto record schemas", () => {
			expect(v.hasSchema("app.bsky.feed.post")).toBe(true);
			expect(v.hasSchema("app.bsky.actor.profile")).toBe(true);
			expect(v.hasSchema("com.atproto.lexicon.schema")).toBe(true);
			expect(v.hasSchema("chat.bsky.actor.declaration")).toBe(true);
			expect(v.hasSchema("com.example.unknown")).toBe(false);
		});

		it("loads at least the expected number of record types", () => {
			expect(v.getLoadedSchemas().length).toBeGreaterThanOrEqual(18);
		});
	});

	describe("shared validator instance", () => {
		it("exports a default validator", () => {
			expect(validator).toBeInstanceOf(RecordValidator);
			expect(validator.hasSchema("app.bsky.feed.post")).toBe(true);
		});
	});
});
