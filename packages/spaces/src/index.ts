/**
 * @getcirrus/spaces – atproto spaces engine (alpha) for Cloudflare Workers.
 *
 * All space state is isolated from the public repository: alpha-era
 * breaking changes are absorbed by wiping space data (`pds spaces reset`),
 * never by touching the account's MST, blobs or OAuth state.
 */

export { SpaceDurableObject } from "./space-do.js";
export { SpaceIndexDurableObject } from "./index-do.js";
export type { SpaceIndexEntry, SpaceIndexState } from "./index-do.js";

export {
	SpaceError,
	parseSpaceErrorCode,
	spaceErrorStatus,
	SPACE_ERROR_CODES,
} from "./errors.js";
export type { SpaceErrorCode } from "./errors.js";

export {
	formatSpaceUri,
	parseSpaceUri,
	requireSpaceUri,
	spaceId,
	spaceRecordUri,
} from "./space-uri.js";
export type { SpaceRef } from "./space-uri.js";

export {
	spaceBlobKey,
	spaceBlobKeyForUri,
	spaceBlobPrefix,
	spaceBlobRootPrefix,
} from "./blob-keys.js";

export {
	SPACE_SCHEMA_VERSION,
	OPLOG_RETENTION_DAYS,
	OPLOG_RETENTION_OPS,
	NOTIFY_REGISTRATION_DAYS,
} from "./schema.js";

export { createServiceJwt } from "./service-jwt.js";
export type { ServiceJwtParams } from "./service-jwt.js";

export { nextRev, tidCutoff } from "./tid.js";

export type {
	ApplyWritesResult,
	NotifyItem,
	OplogEntry,
	PreparedSpaceWrite,
	RepoState,
	SpaceAppAccess,
	SpaceConfig,
	SpaceHostConfig,
	SpaceMeta,
	SpacePolicy,
	SpaceRecordRow,
} from "./types.js";
