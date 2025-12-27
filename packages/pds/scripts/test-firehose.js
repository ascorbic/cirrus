#!/usr/bin/env node
/**
 * Test script for the PDS firehose.
 *
 * This script:
 * 1. Creates some initial test posts
 * 2. Subscribes to the firehose from cursor 0
 * 3. Creates more posts while subscribed
 * 4. Shows all events coming through
 *
 * Usage:
 *   node scripts/test-firehose.js
 *
 * Or with custom PDS:
 *   PDS_URL=https://your-pds.example.com node scripts/test-firehose.js
 */

import WebSocket from "ws";
import { decodeAll as cborDecodeAll } from "@atproto/lex-cbor";

// Configuration from environment
const PDS_URL = process.env.PDS_URL || "http://localhost:5173";
const DID = process.env.DID;
const AUTH_TOKEN = process.env.AUTH_TOKEN;

if (!AUTH_TOKEN) {
	console.error("Error: AUTH_TOKEN environment variable is required");
	console.error("Set it in your shell or create a .dev.vars file");
	process.exit(1);
}

if (!DID) {
	console.error("Error: DID environment variable is required");
	console.error("Set it in your shell or create a .dev.vars file");
	process.exit(1);
}

// Helper to create a post
async function createPost(text) {
	const url = `${PDS_URL}/xrpc/com.atproto.repo.createRecord`;
	const body = {
		repo: DID,
		collection: "app.bsky.feed.post",
		record: {
			text,
			createdAt: new Date().toISOString(),
		},
	};

	console.log(`\n📝 Creating post: "${text}"`, url);

	const response = await fetch(url, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${AUTH_TOKEN}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
	});

	if (!response.ok) {
		const error = await response.text();
		throw new Error(`Failed to create post: ${response.status} ${error}`);
	}

	const result = await response.json();
	console.log(`✅ Created: ${result.uri}`);
	return result;
}

// Helper to delete a post
async function deletePost(rkey) {
	const url = `${PDS_URL}/xrpc/com.atproto.repo.deleteRecord`;
	const body = {
		repo: DID,
		collection: "app.bsky.feed.post",
		rkey,
	};

	console.log(`\n🗑️  Deleting post: ${rkey}`);

	const response = await fetch(url, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${AUTH_TOKEN}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
	});

	if (!response.ok) {
		const error = await response.text();
		throw new Error(`Failed to delete post: ${response.status} ${error}`);
	}

	console.log(`✅ Deleted: ${rkey}`);
}

// Decode a firehose frame
function decodeFrame(data) {
	const bytes = new Uint8Array(data);

	// Decode both header and body using decodeAll
	const [header, body] = Array.from(cborDecodeAll(bytes));

	return { header, body };
}

// Subscribe to firehose
function subscribeToFirehose(cursor = 0) {
	return new Promise((resolve, reject) => {
		const wsUrl = `${PDS_URL.replace("https://", "wss://").replace("http://", "ws://")}/xrpc/com.atproto.sync.subscribeRepos?cursor=${cursor}`;

		console.log(`\n🔌 Connecting to firehose at cursor ${cursor}...`);
		console.log(`   ${wsUrl}\n`);

		const ws = new WebSocket(wsUrl);
		const events = [];

		ws.on("open", () => {
			console.log("✅ Connected to firehose!\n");
		});

		ws.on("message", (data) => {
			try {
				const { header, body } = decodeFrame(data);

				if (header.op === -1) {
					// Error frame
					console.error("❌ Error from server:", body);
					return;
				}

				if (header.op === 1 && header.t === "#commit") {
					events.push(body);

					console.log(`📨 Event #${body.seq}:`);
					console.log(`   Repo: ${body.repo}`);
					console.log(`   Rev: ${body.rev}`);
					console.log(`   Time: ${body.time}`);
					console.log(`   Operations:`);

					for (const op of body.ops) {
						const emoji =
							op.action === "create"
								? "➕"
								: op.action === "delete"
									? "➖"
									: "✏️";
						console.log(`     ${emoji} ${op.action}: ${op.path}`);
					}
					console.log();
				}
			} catch (err) {
				console.error("Failed to decode frame:", err);
			}
		});

		ws.on("error", (err) => {
			console.error("WebSocket error:", err);
			reject(err);
		});

		ws.on("close", (code, reason) => {
			console.log(
				`\n🔌 Disconnected (code: ${code}${reason ? `, reason: ${reason}` : ""})`,
			);
			console.log(`📊 Received ${events.length} events total\n`);
			resolve({ ws, events });
		});

		// Return ws and events array
		setTimeout(() => resolve({ ws, events }), 100);
	});
}

// Main test flow
async function main() {
	console.log("🧪 Testing PDS Firehose\n");
	console.log(`PDS: ${PDS_URL}`);
	console.log(`DID: ${DID}\n`);

	try {
		// Step 1: Create some initial posts
		console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
		console.log("Step 1: Creating initial test posts");
		console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

		await createPost("Hello from the firehose test! 👋");
		await new Promise((resolve) => setTimeout(resolve, 100));

		const post2 = await createPost("This is a second test post 🚀");
		await new Promise((resolve) => setTimeout(resolve, 100));

		await createPost("And a third one for good measure ✨");
		await new Promise((resolve) => setTimeout(resolve, 100));

		// Step 2: Subscribe and backfill
		console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
		console.log("Step 2: Subscribe to firehose from cursor 0");
		console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

		const { ws, events } = await subscribeToFirehose(0);

		// Wait a bit for backfill
		await new Promise((resolve) => setTimeout(resolve, 1000));

		// Step 3: Create more posts while subscribed
		console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
		console.log("Step 3: Creating posts while subscribed");
		console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

		await createPost("This should appear in real-time! ⚡");
		await new Promise((resolve) => setTimeout(resolve, 500));

		await createPost("So should this one! 🎉");
		await new Promise((resolve) => setTimeout(resolve, 500));

		// Step 4: Delete a post
		console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
		console.log("Step 4: Testing delete events");
		console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

		const rkey2 = post2.uri.split("/").pop();
		await deletePost(rkey2);
		await new Promise((resolve) => setTimeout(resolve, 500));

		// Step 5: Close and summarize
		console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
		console.log("Step 5: Summary");
		console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

		ws.close();

		// Wait for close event
		await new Promise((resolve) => setTimeout(resolve, 500));

		console.log("✅ Test completed successfully!");
		console.log("\nWhat happened:");
		console.log("1. Created 3 initial posts");
		console.log("2. Subscribed to firehose (should have backfilled those 3)");
		console.log("3. Created 2 more posts (should have received in real-time)");
		console.log("4. Deleted 1 post (should have received delete event)");
		console.log(`\nTotal events received: ${events.length}`);
		console.log("Expected: 6 events (3 creates + 2 creates + 1 delete)\n");

		if (events.length >= 6) {
			console.log("🎉 Firehose is working correctly!");
		} else {
			console.log("⚠️  Expected more events. Check the logs above.");
		}
	} catch (err) {
		console.error("\n❌ Test failed:", err.message);
		process.exit(1);
	}
}

main();
