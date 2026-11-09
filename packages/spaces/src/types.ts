/**
 * Shared types crossing the Worker ↔ Durable Object RPC boundary.
 */

/**
 * The minimal keypair shape the engine signs with: the account's
 * `#atproto` key, for space tokens and service-auth JWTs. Structural, so a
 * host can pass any `@atproto/crypto` keypair without the engine's public
 * types depending on a particular build of that package.
 */
export interface SpaceSigningKeypair {
	jwtAlg: string;
	did(): string;
	sign(msg: Uint8Array): Promise<Uint8Array>;
}

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

/** A repo revision that is owed a write notification. */
export interface RepoCommitResult {
	rev: string;
	/** sha256 digest of the LtHash state: the commit's `data`. */
	data: Uint8Array;
}

export interface ApplyWritesResult extends RepoCommitResult {
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

export const PERSONALSPACE_POLICY = "com.atproto.personalspace.policy";
export const MEMBERSPACE_POLICY = "com.atproto.memberspace.policy";
export const MANAGEDSPACE_POLICY = "com.atproto.managedspace.policy";

/**
 * A space policy as stored and enforced: one of the three baseline
 * policies, normalised with its defaults filled in. The wire shape and the
 * stored shape are the same object.
 */
export type SpacePolicy =
	| { $type: typeof PERSONALSPACE_POLICY }
	| {
			$type: typeof MEMBERSPACE_POLICY;
			publicRead: boolean;
			publicWrite: boolean;
			allowedApps?: string[];
			publishPolicy: boolean;
			publishMembers: boolean;
	  }
	| {
			$type: typeof MANAGEDSPACE_POLICY;
			managingApp: string;
			publishPolicy: boolean;
	  };

export interface SpaceMember {
	did: string;
	read: boolean;
	write: boolean;
}

export interface SpaceWriter {
	did: string;
	repoRev: string;
	data: Uint8Array;
	spaceRev: string;
}

/** The space sequence position assigned to an accepted repo update. */
export interface SpaceSequence {
	spaceRev: string;
	prevSpaceRev?: string;
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

/** A record imported from a repo archive, prepared by the Worker. */
export interface ImportedRecord {
	collection: string;
	rkey: string;
	cid: string;
	bytes: Uint8Array;
	blobCids: string[];
}

export interface NotifyItem {
	service: string;
	endpoint: string;
	lxm: string;
	body: Record<string, unknown>;
	/**
	 * Pending items sharing a key are coalesced: a newer one replaces the
	 * older, resetting its backoff and deadline.
	 */
	coalesceKey?: string;
	/** Give up retrying after this time (ms since epoch). */
	deadline?: number;
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
	/** Signing keypair provider (service JWTs for notification delivery). */
	getKeypair(): Promise<SpaceSigningKeypair>;
}
