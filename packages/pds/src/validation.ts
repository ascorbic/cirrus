import {
	parse,
	safeParse,
	ValidationError,
} from "@atcute/lexicons/validations";
import type {
	BaseSchema,
	RecordSchema,
	ObjectSchema,
	RecordKeySchema,
} from "@atcute/lexicons/validations";
import { isRecordKey } from "@atcute/lexicons/syntax";
import { isLegacyBlobRef } from "@atproto/lex-data";

import {
	AppBskyActorProfile,
	AppBskyActorStatus,
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
	AppBskyNotificationDeclaration,
	ChatBskyActorDeclaration,
} from "@atcute/bluesky";
import { ComAtprotoLexiconSchema } from "@atcute/atproto";

type AnyRecordSchema = RecordSchema<ObjectSchema, RecordKeySchema>;

const recordSchemas: Record<string, AnyRecordSchema> = {
	"app.bsky.actor.profile": AppBskyActorProfile.mainSchema as AnyRecordSchema,
	"app.bsky.actor.status": AppBskyActorStatus.mainSchema as AnyRecordSchema,
	"app.bsky.feed.generator": AppBskyFeedGenerator.mainSchema as AnyRecordSchema,
	"app.bsky.feed.like": AppBskyFeedLike.mainSchema as AnyRecordSchema,
	"app.bsky.feed.post": AppBskyFeedPost.mainSchema as AnyRecordSchema,
	"app.bsky.feed.postgate": AppBskyFeedPostgate.mainSchema as AnyRecordSchema,
	"app.bsky.feed.repost": AppBskyFeedRepost.mainSchema as AnyRecordSchema,
	"app.bsky.feed.threadgate":
		AppBskyFeedThreadgate.mainSchema as AnyRecordSchema,
	"app.bsky.graph.block": AppBskyGraphBlock.mainSchema as AnyRecordSchema,
	"app.bsky.graph.follow": AppBskyGraphFollow.mainSchema as AnyRecordSchema,
	"app.bsky.graph.list": AppBskyGraphList.mainSchema as AnyRecordSchema,
	"app.bsky.graph.listblock":
		AppBskyGraphListblock.mainSchema as AnyRecordSchema,
	"app.bsky.graph.listitem":
		AppBskyGraphListitem.mainSchema as AnyRecordSchema,
	"app.bsky.graph.starterpack":
		AppBskyGraphStarterpack.mainSchema as AnyRecordSchema,
	"app.bsky.graph.verification":
		AppBskyGraphVerification.mainSchema as AnyRecordSchema,
	"app.bsky.labeler.service":
		AppBskyLabelerService.mainSchema as AnyRecordSchema,
	"app.bsky.notification.declaration":
		AppBskyNotificationDeclaration.mainSchema as AnyRecordSchema,
	"chat.bsky.actor.declaration":
		ChatBskyActorDeclaration.mainSchema as AnyRecordSchema,
	"com.atproto.lexicon.schema":
		ComAtprotoLexiconSchema.mainSchema as AnyRecordSchema,
};

export type ValidationStatus = "valid" | "unknown";

export class InvalidRecordError extends Error {
	override readonly name = "InvalidRecordError";
}

/**
 * Thrown when a write targets an rkey that already exists in the repo.
 * Uses a `name` field rather than relying on class identity, so the error
 * survives a Cloudflare DO RPC boundary (RPC preserves message + name + stack
 * but not the prototype chain).
 */
export class RecordAlreadyExistsError extends Error {
	override readonly name = "RecordAlreadyExistsError";
}

export function isRecordAlreadyExistsError(err: unknown): err is Error {
	if (!(err instanceof Error)) return false;
	// Cloudflare DO RPC reconstructs errors as plain Error and folds the
	// original `${name}: ${message}` into the wrapper's `.message`. So check
	// both the preserved name (DO-local throws) and the message prefix
	// (errors that crossed the RPC boundary).
	return (
		err.name === "RecordAlreadyExistsError" ||
		err.message.startsWith("RecordAlreadyExistsError:")
	);
}

export type ValidateOptions = {
	collection: string;
	record: unknown;
	rkey?: string;
	/**
	 * `true` requires a known schema and rejects unknown collections.
	 * `false` skips schema validation but still reconciles `$type` and
	 * rejects legacy blob refs.
	 * `undefined` (default) validates known schemas optimistically and
	 * accepts unknown collections with status `"unknown"`.
	 */
	validate?: boolean;
};

export type ValidationResult = {
	record: Record<string, unknown>;
	status?: ValidationStatus;
};

export class RecordValidator {
	validate(opts: ValidateOptions): ValidationResult {
		const reconciled = reconcileType(opts.record, opts.collection);
		rejectLegacyBlobRefs(reconciled);

		// Generic rkey shape is a repo-structural concern, not a lex schema
		// concern: it must hold even when the client passes `validate: false`,
		// otherwise auto-generated profiles could land at an arbitrary TID
		// rather than the literal "self" the schema would require.
		if (opts.rkey !== undefined && !isRecordKey(opts.rkey)) {
			throw new InvalidRecordError(`Invalid record key: ${opts.rkey}`);
		}

		if (opts.validate === false) {
			return { record: reconciled };
		}

		const schema = recordSchemas[opts.collection];
		if (!schema) {
			if (opts.validate === true) {
				throw new InvalidRecordError(
					`Unknown lexicon type: ${opts.collection}`,
				);
			}
			return { record: reconciled, status: "unknown" };
		}

		if (opts.rkey !== undefined) {
			const keyResult = safeParse(schema.key as BaseSchema, opts.rkey);
			if (!keyResult.ok) {
				throw new InvalidRecordError(
					`Invalid record key for ${opts.collection}: ${keyResult.message}`,
				);
			}
		}

		try {
			parse(schema as BaseSchema, reconciled);
		} catch (err) {
			if (err instanceof ValidationError) {
				throw new InvalidRecordError(
					`Invalid ${opts.collection} record: ${err.message}`,
				);
			}
			throw err;
		}

		return { record: reconciled, status: "valid" };
	}

	hasSchema(collection: string): boolean {
		return collection in recordSchemas;
	}

	getLoadedSchemas(): string[] {
		return Object.keys(recordSchemas);
	}
}

export const validator = new RecordValidator();

function reconcileType(
	record: unknown,
	collection: string,
): Record<string, unknown> {
	if (record === null || typeof record !== "object" || Array.isArray(record)) {
		throw new InvalidRecordError("Record must be an object");
	}
	const obj = record as Record<string, unknown>;
	const declared = obj.$type;
	if (declared === undefined) {
		return { ...obj, $type: collection };
	}
	if (declared !== collection) {
		throw new InvalidRecordError(
			`Invalid $type: expected ${collection}, got ${String(declared)}`,
		);
	}
	return obj;
}

function rejectLegacyBlobRefs(value: unknown): void {
	const stack: unknown[] = [value];
	const visited = new WeakSet<object>();
	while (stack.length > 0) {
		const current = stack.pop();
		if (current === null || typeof current !== "object") continue;
		if (visited.has(current)) continue;
		visited.add(current);
		if (Array.isArray(current)) {
			for (const item of current) stack.push(item);
			continue;
		}
		if (isLegacyBlobRef(current)) {
			throw new InvalidRecordError(
				`Legacy blobs are not allowed (${(current as { cid: string }).cid})`,
			);
		}
		for (const v of Object.values(current as Record<string, unknown>)) {
			if (v !== null && typeof v === "object") stack.push(v);
		}
	}
}
