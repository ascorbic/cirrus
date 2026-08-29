/**
 * Shared types crossing the Worker ↔ Durable Object RPC boundary.
 */

import type { Keypair } from "@atproto/crypto";

/** A write prepared by the Worker: validated, CBOR-encoded, CID computed. */
export type PreparedSpaceWrite =
	| {
			action: "create" | "update";
			collection: string;
			rkey: string;
			cid: string;
			bytes: Uint8Array;
			/** Blob CIDs referenced by the record. */
			blobCids: string[];
	  }
	| {
			action: "delete";
			collection: string;
			rkey: string;
	  };

export interface ApplyWritesResult {
	rev: string;
	/** sha256 digest of the LtHash state after the batch. */
	hash: Uint8Array;
	results: Array<{
		action: "create" | "update" | "delete";
		collection: string;
		rkey: string;
		cid: string | null;
	}>;
}

export interface SpaceMeta {
	uri: string;
	authority: string;
	type: string;
	skey: string;
	isAuthority: boolean;
	createdAt: string;
	deletedAt: string | null;
}

export type SpacePolicy =
	| { kind: "public" }
	| { kind: "member-list" }
	| { kind: "managing-app"; managingApp: string };

export type SpaceAppAccess =
	| { kind: "open" }
	| { kind: "allowList"; allowed: string[] };

export interface SpaceConfig {
	policy: SpacePolicy;
	appAccess: SpaceAppAccess;
}

export interface RepoState {
	setHash: Uint8Array;
	rev: string;
}

export interface SpaceRecordRow {
	collection: string;
	rkey: string;
	cid: string;
	bytes?: Uint8Array;
}

export interface OplogEntry {
	rev: string;
	idx: number;
	collection: string;
	rkey: string;
	cid: string | null;
	prev: string | null;
	/** Current record bytes for creates/updates that are not stale. */
	bytes?: Uint8Array;
}

export interface NotifyItem {
	service: string;
	endpoint: string;
	lxm: string;
	body: Record<string, unknown>;
}

/**
 * Host configuration for the space engine's Durable Objects. Supplied by
 * the host Worker's subclass — the engine never reads env vars itself, so
 * the same class can later serve a dedicated authority DID with no account
 * attached.
 */
export interface SpaceHostConfig {
	/** The DID whose permissioned repos this engine serves. */
	operatorDid: string;
	/** Signing keypair provider (service JWTs for notification fan-out). */
	getKeypair(): Promise<Keypair>;
}
