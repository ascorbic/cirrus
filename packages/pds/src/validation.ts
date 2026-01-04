import { parse, ValidationError, type BaseSchema } from "@atcute/lexicons/validations";

// Import record schemas from @atcute/bluesky
import {
	AppBskyActorProfile,
	AppBskyFeedGenerator,
	AppBskyFeedLike,
	AppBskyFeedPost,
	AppBskyFeedPostgate,
	AppBskyFeedRepost,
	AppBskyFeedThreadgate,
	AppBskyGraphBlock,
	AppBskyGraphFollow,
	AppBskyGraphList,
	AppBskyGraphListblock,
	AppBskyGraphListitem,
	AppBskyGraphStarterpack,
	AppBskyGraphVerification,
	AppBskyLabelerService,
} from "@atcute/bluesky";

/**
 * Map of collection NSID to validation schema.
 * Only includes record types that can be created in repositories.
 */
const recordSchemas: Record<string, BaseSchema> = {
	"app.bsky.actor.profile": AppBskyActorProfile.mainSchema,
	"app.bsky.feed.generator": AppBskyFeedGenerator.mainSchema,
	"app.bsky.feed.like": AppBskyFeedLike.mainSchema,
	"app.bsky.feed.post": AppBskyFeedPost.mainSchema,
	"app.bsky.feed.postgate": AppBskyFeedPostgate.mainSchema,
	"app.bsky.feed.repost": AppBskyFeedRepost.mainSchema,
	"app.bsky.feed.threadgate": AppBskyFeedThreadgate.mainSchema,
	"app.bsky.graph.block": AppBskyGraphBlock.mainSchema,
	"app.bsky.graph.follow": AppBskyGraphFollow.mainSchema,
	"app.bsky.graph.list": AppBskyGraphList.mainSchema,
	"app.bsky.graph.listblock": AppBskyGraphListblock.mainSchema,
	"app.bsky.graph.listitem": AppBskyGraphListitem.mainSchema,
	"app.bsky.graph.starterpack": AppBskyGraphStarterpack.mainSchema,
	"app.bsky.graph.verification": AppBskyGraphVerification.mainSchema,
	"app.bsky.labeler.service": AppBskyLabelerService.mainSchema,
};

/**
 * Record validator for AT Protocol records.
 *
 * Validates records against official Bluesky lexicon schemas from @atcute/bluesky.
 * Uses optimistic validation strategy:
 * - If a schema is loaded for the collection, validate the record
 * - If no schema is loaded, allow the record (fail-open)
 *
 * This allows the PDS to accept records for new or unknown collection types
 * while still validating known types.
 */
export class RecordValidator {
	private strictMode: boolean;

	constructor(options: { strict?: boolean } = {}) {
		this.strictMode = options.strict ?? false;
	}

	/**
	 * Validate a record against its lexicon schema.
	 *
	 * @param collection - The NSID of the record type (e.g., "app.bsky.feed.post")
	 * @param record - The record object to validate
	 * @throws {Error} If validation fails and schema is loaded
	 */
	validateRecord(collection: string, record: unknown): void {
		const schema = recordSchemas[collection];

		if (!schema) {
			// Optimistic validation: if we don't have the schema, allow it
			if (this.strictMode) {
				throw new Error(
					`No lexicon schema loaded for collection: ${collection}. Enable optimistic validation or add the schema.`,
				);
			}
			return;
		}

		try {
			parse(schema, record);
		} catch (error) {
			if (error instanceof ValidationError) {
				throw new Error(
					`Lexicon validation failed for ${collection}: ${error.message}`,
				);
			}
			throw error;
		}
	}

	/**
	 * Check if a schema is loaded for a collection.
	 */
	hasSchema(collection: string): boolean {
		return collection in recordSchemas;
	}

	/**
	 * Get list of all loaded schema NSIDs.
	 */
	getLoadedSchemas(): string[] {
		return Object.keys(recordSchemas);
	}
}

/**
 * Shared validator instance (singleton pattern).
 * Uses optimistic validation by default (strict: false).
 */
export const validator = new RecordValidator({ strict: false });
