import { encode as cborEncode, decode as cborDecode } from "./cbor-compat";
import { CID } from "@atproto/lex-data";
import { blocksToCarFile, BlockMap } from "@atproto/repo";
import type { RecordWriteOp } from "@atproto/repo";

/**
 * Commit event payload for the firehose
 */
export interface CommitEvent {
	seq: number;
	rebase: boolean;
	tooBig: boolean;
	repo: string;
	commit: CID;
	rev: string;
	since: string | null;
	prevData: CID | null;
	blocks: Uint8Array;
	ops: RepoOp[];
	blobs: CID[];
	time: string;
}

/**
 * Identity event payload for the firehose
 */
export interface IdentityEvent {
	seq: number;
	did: string;
	handle?: string;
	time: string;
}

/**
 * Sync event payload — broadcast after operations that change repo state
 * without a commit diff (rebase, key rotation, repo import).
 * `blocks` is a CAR containing just the current commit block.
 */
export interface SyncEvent {
	seq: number;
	did: string;
	rev: string;
	blocks: Uint8Array;
	time: string;
}

/**
 * Account event payload — broadcast on activation, deactivation, takedown,
 * or deletion. `status` is omitted when active=true.
 */
export type AccountStatus =
	| "takendown"
	| "suspended"
	| "deleted"
	| "deactivated";

export interface AccountEvent {
	seq: number;
	did: string;
	active: boolean;
	status?: AccountStatus;
	time: string;
}

/**
 * Repository operation in a commit
 */
export interface RepoOp {
	action: "create" | "update" | "delete";
	path: string;
	cid: CID | null;
	prev?: CID;
}

/**
 * Sequenced commit event wrapper
 */
export interface SeqCommitEvent {
	seq: number;
	type: "commit";
	event: CommitEvent;
	time: string;
}

/**
 * Sequenced identity event wrapper
 */
export interface SeqIdentityEvent {
	seq: number;
	type: "identity";
	event: IdentityEvent;
	time: string;
}

/**
 * Sequenced sync event wrapper
 */
export interface SeqSyncEvent {
	seq: number;
	type: "sync";
	event: SyncEvent;
	time: string;
}

/**
 * Sequenced account event wrapper
 */
export interface SeqAccountEvent {
	seq: number;
	type: "account";
	event: AccountEvent;
	time: string;
}

/**
 * Sequenced event (commit, identity, sync, or account)
 */
export type SeqEvent =
	| SeqCommitEvent
	| SeqIdentityEvent
	| SeqSyncEvent
	| SeqAccountEvent;

/**
 * Data needed to sequence a commit. Pass `newBlocks` and `relevantBlocks`
 * from @atproto/repo's CommitData; both are needed in the CAR slice so
 * relays can run the sync 1.1 MST inversion check.
 */
export interface CommitData {
	did: string;
	commit: CID;
	rev: string;
	since: string | null;
	prevData: CID | null;
	newBlocks: BlockMap;
	relevantBlocks: BlockMap;
	ops: Array<RecordWriteOp & { cid?: CID | null; prev?: CID }>;
}

/**
 * Data needed to sequence a sync event.
 */
export interface SyncEventData {
	did: string;
	rev: string;
	cid: CID;
	blocks: BlockMap;
}

/**
 * Sequencer manages the firehose event log.
 *
 * Stores commit events in SQLite and provides methods for:
 * - Sequencing new commits, identity, sync, and account events
 * - Backfilling events from a cursor
 * - Getting the latest sequence number
 */
export class Sequencer {
	constructor(private sql: SqlStorage) {}

	/**
	 * Add a commit to the firehose sequence.
	 * Returns the complete sequenced event for broadcasting.
	 */
	async sequenceCommit(data: CommitData): Promise<SeqCommitEvent> {
		// Sync 1.1: CAR slice must contain both newly created blocks AND the
		// MST covering proof for the touched paths so consumers can invert
		// the MST and verify the commit without re-fetching the repo.
		const blocksToSend = new BlockMap();
		blocksToSend.addMap(data.newBlocks);
		blocksToSend.addMap(data.relevantBlocks);

		const carBytes = await blocksToCarFile(data.commit, blocksToSend);
		const time = new Date().toISOString();

		const eventPayload: Omit<CommitEvent, "seq"> = {
			repo: data.did,
			commit: data.commit,
			rev: data.rev,
			since: data.since,
			prevData: data.prevData,
			blocks: carBytes,
			ops: data.ops.map((op): RepoOp => {
				const out: RepoOp = {
					action: op.action as "create" | "update" | "delete",
					path: `${op.collection}/${op.rkey}`,
					cid: ("cid" in op && op.cid ? op.cid : null) as CID | null,
				};
				if (op.prev) out.prev = op.prev;
				return out;
			}),
			rebase: false,
			tooBig: false,
			blobs: [],
			time,
		};

		const payload = cborEncode(eventPayload);
		const result = this.sql
			.exec(
				`INSERT INTO firehose_events (event_type, payload)
       VALUES ('commit', ?)
       RETURNING seq`,
				payload,
			)
			.one();

		const seq = result.seq as number;

		return {
			seq,
			type: "commit",
			event: {
				...eventPayload,
				seq,
			},
			time,
		};
	}

	/**
	 * Add an identity event to the firehose.
	 * `handle` is optional per sync 1.1; presence does not signal change.
	 */
	async sequenceIdentity(input: {
		did: string;
		handle?: string;
	}): Promise<SeqIdentityEvent> {
		const time = new Date().toISOString();

		const eventPayload: Omit<IdentityEvent, "seq"> = {
			did: input.did,
			time,
			...(input.handle ? { handle: input.handle } : {}),
		};

		const payload = cborEncode(eventPayload);
		const result = this.sql
			.exec(
				`INSERT INTO firehose_events (event_type, payload)
       VALUES ('identity', ?)
       RETURNING seq`,
				payload,
			)
			.one();

		const seq = result.seq as number;

		return {
			seq,
			type: "identity",
			event: { ...eventPayload, seq },
			time,
		};
	}

	/**
	 * Add a sync event to the firehose.
	 * Used after repo state changes that don't produce a commit diff
	 * (import, rebase, key rotation, account activation).
	 */
	async sequenceSync(data: SyncEventData): Promise<SeqSyncEvent> {
		const carBytes = await blocksToCarFile(data.cid, data.blocks);
		const time = new Date().toISOString();

		const eventPayload: Omit<SyncEvent, "seq"> = {
			did: data.did,
			rev: data.rev,
			blocks: carBytes,
			time,
		};

		const payload = cborEncode(eventPayload);
		const result = this.sql
			.exec(
				`INSERT INTO firehose_events (event_type, payload)
       VALUES ('sync', ?)
       RETURNING seq`,
				payload,
			)
			.one();

		const seq = result.seq as number;

		return {
			seq,
			type: "sync",
			event: { ...eventPayload, seq },
			time,
		};
	}

	/**
	 * Add an account status event to the firehose.
	 */
	async sequenceAccount(input: {
		did: string;
		active: boolean;
		status?: AccountStatus;
	}): Promise<SeqAccountEvent> {
		const time = new Date().toISOString();

		const eventPayload: Omit<AccountEvent, "seq"> = {
			did: input.did,
			active: input.active,
			time,
			...(input.status ? { status: input.status } : {}),
		};

		const payload = cborEncode(eventPayload);
		const result = this.sql
			.exec(
				`INSERT INTO firehose_events (event_type, payload)
       VALUES ('account', ?)
       RETURNING seq`,
				payload,
			)
			.one();

		const seq = result.seq as number;

		return {
			seq,
			type: "account",
			event: { ...eventPayload, seq },
			time,
		};
	}

	/**
	 * Get events from a cursor position.
	 * Returns up to `limit` events after the cursor.
	 * Skips identity events that have empty payloads.
	 */
	async getEventsSince(cursor: number, limit = 100): Promise<SeqEvent[]> {
		const rows = this.sql
			.exec(
				`SELECT seq, event_type, payload, created_at
       FROM firehose_events
       WHERE seq > ?
       ORDER BY seq ASC
       LIMIT ?`,
				cursor,
				limit,
			)
			.toArray();

		const events: SeqEvent[] = [];

		for (const row of rows) {
			const eventType = row.event_type as string;
			const payload = new Uint8Array(row.payload as ArrayBuffer);
			const seq = row.seq as number;
			const time = row.created_at as string;

			if (eventType === "identity") {
				// Skip legacy identity events with empty payload
				if (payload.length === 0) {
					continue;
				}
				const decoded = cborDecode(payload) as Omit<IdentityEvent, "seq">;
				events.push({
					seq,
					type: "identity",
					event: { ...decoded, seq },
					time,
				});
			} else if (eventType === "sync") {
				const decoded = cborDecode(payload) as Omit<SyncEvent, "seq">;
				events.push({
					seq,
					type: "sync",
					event: { ...decoded, seq },
					time,
				});
			} else if (eventType === "account") {
				const decoded = cborDecode(payload) as Omit<AccountEvent, "seq">;
				events.push({
					seq,
					type: "account",
					event: { ...decoded, seq },
					time,
				});
			} else {
				const decoded = cborDecode(payload) as Omit<CommitEvent, "seq">;
				events.push({
					seq,
					type: "commit",
					event: { ...decoded, seq },
					time,
				});
			}
		}

		return events;
	}

	/**
	 * Get the latest sequence number.
	 * Returns 0 if no events have been sequenced yet.
	 */
	getLatestSeq(): number {
		const result = this.sql
			.exec("SELECT MAX(seq) as seq FROM firehose_events")
			.one();
		return (result?.seq as number) ?? 0;
	}

	/**
	 * Get the earliest sequence number still in the log.
	 * Used to detect cursors that fall before the backfill window
	 * (so the firehose can send an OutdatedCursor info frame).
	 */
	getEarliestSeq(): number | null {
		const result = this.sql
			.exec("SELECT MIN(seq) as seq FROM firehose_events")
			.one();
		const seq = result?.seq;
		return typeof seq === "number" ? seq : null;
	}

	/**
	 * Prune old events to keep the log from growing indefinitely.
	 * Keeps the most recent `keepCount` events.
	 */
	async pruneOldEvents(keepCount = 10000): Promise<void> {
		this.sql.exec(
			`DELETE FROM firehose_events
       WHERE seq < (SELECT MAX(seq) - ? FROM firehose_events)`,
			keepCount,
		);
	}
}
