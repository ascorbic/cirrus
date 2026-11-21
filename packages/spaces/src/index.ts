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
	promotePendingSpaceBlob,
	promoteStagedBlobToSpace,
	spaceBlobKey,
	spaceBlobKeyForUri,
	spaceBlobPrefix,
	spaceBlobRootPrefix,
	stagedBlobKey,
} from "./blob-keys.js";

export { createSpaceRoutes } from "./routes.js";
export type {
	SpaceRoutesHost,
	SpaceScopeMatch,
	SpaceSessionAuth,
	SpaceStub,
	SpaceIndexStub,
} from "./routes.js";

export {
	SPACE_AUDIENCE_HEADER,
	SPACE_CREDENTIAL_SCHEME,
	isSpaceCredentialAuth,
	verifyDelegationToken,
	verifySpaceCredentialAuth,
} from "./auth.js";
export type { CheckReplay, CheckRevoked, GetSigningKey } from "./auth.js";

export { verifyClientAttestation } from "./attestation.js";

export {
	MAC_REQUEST_HEADER,
	macExposedHeaders,
	buildCommit,
	bytesToJson,
	commitToJson,
	generateKemKey,
	kemDidKey,
} from "./mac.js";
export type { SpaceCommit } from "./mac.js";

export {
	MEMBER_COLLECTION,
	POLICY_COLLECTION,
	PUBLISHED_COLLECTIONS,
	normalizePolicy,
} from "./policy.js";

export { prepareRecord, recordBytesToJson } from "./records.js";
export type { PreparedRecord } from "./records.js";

export {
	SPACE_SCHEMA_VERSION,
	OPLOG_RETENTION_DAYS,
	OPLOG_RETENTION_OPS,
} from "./schema.js";

export { createServiceJwt } from "./service-jwt.js";
export type { ServiceJwtParams } from "./service-jwt.js";

export { nextRev, tidCutoff, tidTimestampMs } from "./tid.js";

export { createDelegationToken, spaceHostAud } from "./tokens.js";

export {
	MANAGEDSPACE_POLICY,
	MEMBERSPACE_POLICY,
	PERSONALSPACE_POLICY,
} from "./types.js";
export type {
	ApplyWritesResult,
	ImportedRecord,
	NotifyItem,
	OplogEntry,
	PreparedSpaceWrite,
	RepoCommitResult,
	RepoState,
	SpaceHostConfig,
	SpaceMember,
	SpaceMeta,
	SpacePolicy,
	SpaceRecordRow,
	SpaceSequence,
	SpaceSigningKeypair,
	SpaceWriter,
} from "./types.js";
