import { Lexicons } from "@atproto/lexicon";

// Import official Bluesky lexicon schemas
// Core AT Proto schemas
import strongRefSchema from "./lexicons/com.atproto.repo.strongRef.json" with { type: "json" };
import labelDefsSchema from "./lexicons/com.atproto.label.defs.json" with { type: "json" };

// Feed schemas
import postSchema from "./lexicons/app.bsky.feed.post.json" with { type: "json" };
import likeSchema from "./lexicons/app.bsky.feed.like.json" with { type: "json" };
import repostSchema from "./lexicons/app.bsky.feed.repost.json" with { type: "json" };
import threadgateSchema from "./lexicons/app.bsky.feed.threadgate.json" with { type: "json" };

// Actor schemas
import profileSchema from "./lexicons/app.bsky.actor.profile.json" with { type: "json" };

// Graph schemas
import followSchema from "./lexicons/app.bsky.graph.follow.json" with { type: "json" };
import blockSchema from "./lexicons/app.bsky.graph.block.json" with { type: "json" };
import listSchema from "./lexicons/app.bsky.graph.list.json" with { type: "json" };
import listitemSchema from "./lexicons/app.bsky.graph.listitem.json" with { type: "json" };

// Richtext schemas
import facetSchema from "./lexicons/app.bsky.richtext.facet.json" with { type: "json" };

// Embed schemas
import imagesSchema from "./lexicons/app.bsky.embed.images.json" with { type: "json" };
import externalSchema from "./lexicons/app.bsky.embed.external.json" with { type: "json" };
import recordSchema from "./lexicons/app.bsky.embed.record.json" with { type: "json" };
import recordWithMediaSchema from "./lexicons/app.bsky.embed.recordWithMedia.json" with { type: "json" };

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
	 */
	private loadBlueskySchemas(): void {
		// Core AT Proto schemas (must be loaded first - they're referenced by other schemas)
		this.lex.add(strongRefSchema);
		this.lex.add(labelDefsSchema);

		// Richtext schemas (referenced by posts)
		this.lex.add(facetSchema);

		// Embed schemas (referenced by posts)
		this.lex.add(imagesSchema);
		this.lex.add(externalSchema);
		this.lex.add(recordSchema);
		this.lex.add(recordWithMediaSchema);

		// Feed schemas
		this.lex.add(postSchema);
		this.lex.add(likeSchema);
		this.lex.add(repostSchema);
		this.lex.add(threadgateSchema);

		// Actor schemas
		this.lex.add(profileSchema);

		// Graph schemas
		this.lex.add(followSchema);
		this.lex.add(blockSchema);
		this.lex.add(listSchema);
		this.lex.add(listitemSchema);
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
 * Pre-loaded with official Bluesky schemas:
 * - Core: com.atproto.repo.strongRef, com.atproto.label.defs
 * - Feed: app.bsky.feed.{post, like, repost, threadgate}
 * - Actor: app.bsky.actor.profile
 * - Graph: app.bsky.graph.{follow, block, list, listitem}
 * - Richtext: app.bsky.richtext.facet
 * - Embed: app.bsky.embed.{images, external, record, recordWithMedia}
 *
 * Additional schemas can be added:
 * ```ts
 * import { validator } from './validation'
 * validator.addSchema(myCustomSchema)
 * ```
 */
export const validator = new RecordValidator({ strict: false });
