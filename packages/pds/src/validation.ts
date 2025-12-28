import { Lexicons } from "@atproto/lexicon";

/**
 * Record validator for AT Protocol records.
 *
 * Validates records against official Bluesky lexicon schemas.
 * Uses optimistic validation strategy:
 * - If a lexicon schema is loaded for the collection, validate the record
 * - If no schema is loaded, allow the record (fail-open)
 *
 * This allows the PDS to accept records for new or unknown collection types
 * while still validating known types when schemas are available.
 */
export class RecordValidator {
	private lex: Lexicons;
	private strictMode: boolean;

	constructor(options: { strict?: boolean; lexicons?: Lexicons } = {}) {
		this.lex = options.lexicons ?? new Lexicons();
		this.strictMode = options.strict ?? false;

		// Load official Bluesky schemas
		this.loadBlueskySchemas();
	}

	/**
	 * Load official Bluesky lexicon schemas from vendored JSON files.
	 * Uses Vite's glob import to automatically load all schema files.
	 */
	private loadBlueskySchemas(): void {
		// Import all lexicon JSON files using Vite's glob import
		const schemas = import.meta.glob<{ default: any }>(
			"./lexicons/*.json",
			{ eager: true },
		);

		// Load each schema into the Lexicons instance
		for (const schema of Object.values(schemas)) {
			this.lex.add(schema.default);
		}
	}

	/**
	 * Validate a record against its lexicon schema.
	 *
	 * @param collection - The NSID of the record type (e.g., "app.bsky.feed.post")
	 * @param record - The record object to validate
	 * @throws {Error} If validation fails and schema is loaded
	 */
	validateRecord(collection: string, record: unknown): void {
		// Check if we have a schema for this collection
		const hasSchema = this.hasSchema(collection);

		if (!hasSchema) {
			// Optimistic validation: if we don't have the schema, allow it
			if (this.strictMode) {
				throw new Error(
					`No lexicon schema loaded for collection: ${collection}. Enable optimistic validation or add the schema.`,
				);
			}
			// In non-strict mode, we allow unknown schemas
			return;
		}

		// We have a schema, so validate against it
		try {
			this.lex.assertValidRecord(collection, record);
		} catch (error) {
			const message =
				error instanceof Error ? error.message : String(error);
			throw new Error(
				`Lexicon validation failed for ${collection}: ${message}`,
			);
		}
	}

	/**
	 * Check if a schema is loaded for a collection.
	 */
	hasSchema(collection: string): boolean {
		try {
			// Try to get the schema - if it exists, this won't throw
			this.lex.getDefOrThrow(collection);
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Add a lexicon schema to the validator.
	 *
	 * @param doc - The lexicon document to add
	 *
	 * @example
	 * ```ts
	 * validator.addSchema({
	 *   lexicon: 1,
	 *   id: "com.example.post",
	 *   defs: { ... }
	 * })
	 * ```
	 */
	addSchema(doc: any): void {
		this.lex.add(doc);
	}

	/**
	 * Get list of all loaded schema NSIDs.
	 */
	getLoadedSchemas(): string[] {
		// Convert the Lexicons iterable to an array and extract IDs
		return Array.from(this.lex).map((doc) => doc.id);
	}

	/**
	 * Get the underlying Lexicons instance for advanced usage.
	 */
	getLexicons(): Lexicons {
		return this.lex;
	}
}

/**
 * Shared validator instance (singleton pattern).
 * Uses optimistic validation by default (strict: false).
 *
 * Automatically loads all schemas from ./lexicons/*.json
 *
 * Additional schemas can be added:
 * ```ts
 * import { validator } from './validation'
 * validator.addSchema(myCustomSchema)
 * ```
 */
export const validator = new RecordValidator({ strict: false });
