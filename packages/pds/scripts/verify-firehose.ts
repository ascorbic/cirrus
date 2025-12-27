#!/usr/bin/env npx tsx
/**
 * Firehose verification script
 * Connects to the PDS firehose and verifies event data integrity
 */

import WebSocket from "ws";
import { decodeAll } from "@atproto/lex-cbor";
import { CarReader } from "@ipld/car";
import type { Cid } from "@atproto/lex-data";

const PDS_URL = process.env.PDS_URL || "wss://pds.mk.gg";
const CURSOR = process.env.CURSOR || "0";
const MAX_EVENTS = parseInt(process.env.MAX_EVENTS || "20", 10);

interface FrameHeader {
	op: number;
	t?: string;
}

interface CommitOp {
	action: "create" | "update" | "delete";
	path: string;
	cid: Cid | null;
}

interface CommitEvent {
	seq: number;
	rebase: boolean;
	tooBig: boolean;
	repo: string;
	commit: Cid;
	rev: string;
	since: string | null;
	blocks: Uint8Array;
	ops: CommitOp[];
	blobs: Cid[];
	time: string;
}

function decodeFrame(data: Uint8Array): { header: FrameHeader; body: unknown } {
	// AT Protocol frame: header CBOR + body CBOR concatenated
	const parts = [...decodeAll(data)];
	if (parts.length < 2) {
		throw new Error(`Expected 2 CBOR values in frame, got ${parts.length}`);
	}
	return { header: parts[0] as FrameHeader, body: parts[1] };
}

async function verifyCommitEvent(
	event: CommitEvent,
	eventNum: number,
): Promise<{ valid: boolean; errors: string[] }> {
	const errors: string[] = [];

	console.log(`\n--- Event ${eventNum} (seq: ${event.seq}) ---`);
	console.log(`  Repo: ${event.repo}`);
	console.log(`  Rev: ${event.rev}`);
	console.log(`  Time: ${event.time}`);
	console.log(`  Ops: ${event.ops.length}`);

	for (const op of event.ops) {
		console.log(`    - ${op.action}: ${op.path} (cid: ${op.cid?.toString() || "null"})`);
	}

	// Check blocks
	console.log(`  Blocks field length: ${event.blocks?.length || 0} bytes`);

	if (!event.blocks || event.blocks.length === 0) {
		errors.push("blocks field is empty!");
		return { valid: false, errors };
	}

	// Try to parse as CAR
	let reader: CarReader;
	try {
		reader = await CarReader.fromBytes(event.blocks);
	} catch (e) {
		errors.push(`Failed to parse blocks as CAR: ${e}`);
		return { valid: false, errors };
	}

	// Check roots
	const roots = await reader.getRoots();
	console.log(`  CAR roots: ${roots.length}`);
	if (roots.length === 0) {
		errors.push("CAR has no roots!");
	}

	// Count blocks in CAR
	const blockCids: string[] = [];
	for await (const block of reader.blocks()) {
		blockCids.push(block.cid.toString());
	}
	console.log(`  CAR blocks: ${blockCids.length}`);

	if (blockCids.length === 0) {
		errors.push("CAR contains no blocks!");
	}

	// Verify commit CID is in blocks
	const commitCidStr = event.commit?.toString();
	if (commitCidStr) {
		const hasCommit = blockCids.includes(commitCidStr);
		console.log(`  Commit CID in blocks: ${hasCommit ? "✓" : "✗"}`);
		if (!hasCommit) {
			errors.push(`Commit CID ${commitCidStr} not found in blocks`);
		}
	}

	// Verify record CIDs from ops are in blocks (for create/update)
	for (const op of event.ops) {
		if (op.action !== "delete" && op.cid) {
			const cidStr = op.cid.toString();
			const hasRecord = blockCids.includes(cidStr);
			console.log(`  Record CID ${cidStr.slice(0, 20)}... in blocks: ${hasRecord ? "✓" : "✗"}`);
			if (!hasRecord) {
				errors.push(`Record CID ${cidStr} for ${op.path} not found in blocks`);
			}
		}
	}

	// Check tooBig flag
	if (event.tooBig) {
		console.log("  ⚠️  tooBig flag is set - blocks may be truncated");
	}

	return { valid: errors.length === 0, errors };
}

async function main() {
	console.log(`Connecting to ${PDS_URL}/xrpc/com.atproto.sync.subscribeRepos?cursor=${CURSOR}`);
	console.log(`Will verify up to ${MAX_EVENTS} events\n`);

	const ws = new WebSocket(
		`${PDS_URL}/xrpc/com.atproto.sync.subscribeRepos?cursor=${CURSOR}`,
	);

	let eventCount = 0;
	let validCount = 0;
	let invalidCount = 0;
	const allErrors: string[] = [];

	return new Promise<void>((resolve, reject) => {
		ws.on("open", () => {
			console.log("✓ Connected to firehose\n");
		});

		ws.on("message", async (data: Buffer) => {
			try {
				eventCount++;
				const { header, body } = decodeFrame(new Uint8Array(data));

				if (header.op === -1) {
					// Error frame
					console.log("Error frame:", body);
					return;
				}

				if (header.t === "#commit") {
					const result = await verifyCommitEvent(
						body as CommitEvent,
						eventCount,
					);
					if (result.valid) {
						validCount++;
						console.log("  ✓ Event valid");
					} else {
						invalidCount++;
						console.log("  ✗ Event INVALID:");
						for (const err of result.errors) {
							console.log(`    - ${err}`);
							allErrors.push(`Event ${eventCount}: ${err}`);
						}
					}
				} else {
					console.log(`Unknown frame type: ${header.t}`);
				}

				if (eventCount >= MAX_EVENTS) {
					ws.close();
				}
			} catch (e) {
				console.error("Error processing message:", e);
				invalidCount++;
			}
		});

		ws.on("error", (err) => {
			console.error("WebSocket error:", err);
			reject(err);
		});

		ws.on("close", () => {
			console.log("\n" + "=".repeat(50));
			console.log("SUMMARY");
			console.log("=".repeat(50));
			console.log(`Total events: ${eventCount}`);
			console.log(`Valid: ${validCount}`);
			console.log(`Invalid: ${invalidCount}`);

			if (allErrors.length > 0) {
				console.log("\nAll errors:");
				for (const err of allErrors) {
					console.log(`  - ${err}`);
				}
			}

			if (invalidCount > 0) {
				console.log("\n❌ FIREHOSE HAS ISSUES");
				process.exit(1);
			} else if (eventCount === 0) {
				console.log("\n⚠️  No events received (firehose may be empty)");
				process.exit(0);
			} else {
				console.log("\n✅ FIREHOSE OK");
				process.exit(0);
			}

			resolve();
		});

		// Timeout after 30 seconds
		setTimeout(() => {
			console.log("\nTimeout reached, closing connection...");
			ws.close();
		}, 30000);
	});
}

main().catch(console.error);
