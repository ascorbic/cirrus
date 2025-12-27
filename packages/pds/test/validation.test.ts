import { describe, it, expect, beforeEach } from "vitest";
import { RecordValidator } from "../src/validation";

describe("RecordValidator", () => {
	describe("optimistic validation (default)", () => {
		let validator: RecordValidator;

		beforeEach(() => {
			validator = new RecordValidator({ strict: false });
		});

		it("allows records for unknown schemas", () => {
			// Should not throw for unknown collection
			expect(() => {
				validator.validateRecord("com.example.unknown", {
					text: "test",
					createdAt: new Date().toISOString(),
				});
			}).not.toThrow();
		});

		it("validates records when schema is loaded", () => {
			// Add a simple schema
			validator.addSchema({
				lexicon: 1,
				id: "com.example.post",
				defs: {
					main: {
						type: "record",
						key: "tid",
						record: {
							type: "object",
							required: ["text"],
							properties: {
								text: {
									type: "string",
									maxLength: 100,
								},
							},
						},
					},
				},
			});

			// Valid record should pass
			expect(() => {
				validator.validateRecord("com.example.post", {
					$type: "com.example.post",
					text: "Hello world",
				});
			}).not.toThrow();

			// Invalid record should fail
			expect(() => {
				validator.validateRecord("com.example.post", {
					$type: "com.example.post",
					// Missing required 'text' field
				});
			}).toThrow(/validation failed/i);
		});

		it("checks if schema is loaded", () => {
			validator.addSchema({
				lexicon: 1,
				id: "com.example.test",
				defs: {
					main: {
						type: "record",
						key: "tid",
						record: {
							type: "object",
							properties: {},
						},
					},
				},
			});

			expect(validator.hasSchema("com.example.test")).toBe(true);
			expect(validator.hasSchema("com.example.unknown")).toBe(false);
		});

		it("lists loaded schemas", () => {
			validator.addSchema({
				lexicon: 1,
				id: "com.example.schema1",
				defs: {
					main: {
						type: "record",
						key: "tid",
						record: { type: "object", properties: {} },
					},
				},
			});

			validator.addSchema({
				lexicon: 1,
				id: "com.example.schema2",
				defs: {
					main: {
						type: "record",
						key: "tid",
						record: { type: "object", properties: {} },
					},
				},
			});

			const schemas = validator.getLoadedSchemas();
			expect(schemas).toContain("com.example.schema1");
			expect(schemas).toContain("com.example.schema2");
		});
	});

	describe("strict mode", () => {
		let validator: RecordValidator;

		beforeEach(() => {
			validator = new RecordValidator({ strict: true });
		});

		it("rejects records for unknown schemas", () => {
			expect(() => {
				validator.validateRecord("com.example.unknown", {
					text: "test",
				});
			}).toThrow(/no lexicon schema loaded/i);
		});

		it("validates records when schema is loaded", () => {
			validator.addSchema({
				lexicon: 1,
				id: "com.example.post",
				defs: {
					main: {
						type: "record",
						key: "tid",
						record: {
							type: "object",
							required: ["text"],
							properties: {
								text: {
									type: "string",
								},
							},
						},
					},
				},
			});

			// Valid record should pass
			expect(() => {
				validator.validateRecord("com.example.post", {
					$type: "com.example.post",
					text: "Hello world",
				});
			}).not.toThrow();
		});
	});

	describe("maxLength validation", () => {
		it("rejects strings exceeding maxLength", () => {
			const validator = new RecordValidator();
			validator.addSchema({
				lexicon: 1,
				id: "com.example.shortpost",
				defs: {
					main: {
						type: "record",
						key: "tid",
						record: {
							type: "object",
							required: ["text"],
							properties: {
								text: {
									type: "string",
									maxLength: 10,
								},
							},
						},
					},
				},
			});

			// Short text should pass
			expect(() => {
				validator.validateRecord("com.example.shortpost", {
					$type: "com.example.shortpost",
					text: "short",
				});
			}).not.toThrow();

			// Long text should fail
			expect(() => {
				validator.validateRecord("com.example.shortpost", {
					$type: "com.example.shortpost",
					text: "this text is way too long for the limit",
				});
			}).toThrow(/validation failed/i);
		});
	});

	describe("required fields validation", () => {
		it("rejects records missing required fields", () => {
			const validator = new RecordValidator();
			validator.addSchema({
				lexicon: 1,
				id: "com.example.requiredfields",
				defs: {
					main: {
						type: "record",
						key: "tid",
						record: {
							type: "object",
							required: ["text", "createdAt"],
							properties: {
								text: {
									type: "string",
								},
								createdAt: {
									type: "string",
									format: "datetime",
								},
							},
						},
					},
				},
			});

			// Complete record should pass
			expect(() => {
				validator.validateRecord("com.example.requiredfields", {
					$type: "com.example.requiredfields",
					text: "test",
					createdAt: new Date().toISOString(),
				});
			}).not.toThrow();

			// Incomplete record should fail
			expect(() => {
				validator.validateRecord("com.example.requiredfields", {
					$type: "com.example.requiredfields",
					text: "test",
					// Missing createdAt
				});
			}).toThrow(/validation failed/i);
		});
	});
});
