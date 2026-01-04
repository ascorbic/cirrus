import { encode as cborEncode, decode as cborDecode } from "./cbor-compat";
import { CID } from "@atproto/lex-data";
import { blocksToCarFile, type BlockMap } from "@atproto/repo";
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
	handle: string;
	time: string;
}

/**
 * Repository operation in a commit
 */
export interface RepoOp {
	action: "create" | "update" | "delete";
	path: string;
	cid: CID | null;
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
 * Sequenced event (commit or identity)
 */
export type SeqEvent = SeqCommitEvent | SeqIdentityEvent;

/**
 * Data needed to sequence a commit
 */
export interface CommitData {
	did: string;
	commit: CID;
	rev: string;
	since: string | null;
	newBlocks: BlockMap;
	ops: Array<RecordWriteOp & { cid?: CID | null }>;
}

/**
 * Sequencer manages the firehose event log.
 *
 * Stores commit events in SQLite and provides methods for:
 * - Sequencing new commits
 * - Backfilling events from a cursor
 * - Getting the latest sequence number
 */
export class Sequencer {
	constructor(private sql: SqlStorage) {}

	/**
	 * Add a commit to the firehose sequence.
	 * Returns the complete sequenced event for broadcasting.
	 */
	async sequenceCommit(data: CommitData): Promise<SeqEvent> {
		// Create CAR slice with commit diff
		const carBytes = await blocksToCarFile(data.commit, data.newBlocks);
		const time = new Date().toISOString();

		// Build event payload
		const eventPayload: Omit<CommitEvent, "seq"> = {
			repo: data.did,
			commit: data.commit,
			rev: data.rev,
			since: data.since,
			blocks: carBytes,
			ops: data.ops.map(
				(op): RepoOp => ({
					action: op.action as "create" | "update" | "delete",
					path: `${op.collection}/${op.rkey}`,
					cid: ("cid" in op && op.cid ? op.cid : null) as CID | null,
				}),
			),
			rebase: false,
			tooBig: carBytes.length > 1_000_000,
			blobs: [],
			time,
		};

		// Store in SQLite
		// Type assertion: CBOR handles CID/Uint8Array serialization
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
				// Decode identity event with proper payload
				const decoded = cborDecode(payload) as Omit<IdentityEvent, "seq">;
				events.push({
					seq,
					type: "identity",
					event: { ...decoded, seq },
					time,
				});
			} else {
				// Commit event
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
