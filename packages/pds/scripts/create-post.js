#!/usr/bin/env node
/**
 * Quick script to create a test post.
 *
 * Usage:
 *   node scripts/create-post.js "Hello, world!"
 *   node scripts/create-post.js "My post" --rkey my-custom-key
 */

const PDS_URL = process.env.PDS_URL || "http://localhost:5173";
const DID = process.env.DID;
const AUTH_TOKEN = process.env.AUTH_TOKEN;

if (!AUTH_TOKEN) {
	console.error("Error: AUTH_TOKEN environment variable is required");
	process.exit(1);
}

if (!DID) {
	console.error("Error: DID environment variable is required");
	process.exit(1);
}

const args = process.argv.slice(2);
const text = args.find((arg) => !arg.startsWith("--")) || "Test post";
const rkeyIndex = args.indexOf("--rkey");
const rkey = rkeyIndex >= 0 ? args[rkeyIndex + 1] : undefined;

async function createPost() {
	const url = `${PDS_URL}/xrpc/com.atproto.repo.createRecord`;
	const body = {
		repo: DID,
		collection: "app.bsky.feed.post",
		...(rkey && { rkey }),
		record: {
			text,
			createdAt: new Date().toISOString(),
		},
	};

	console.log(`Creating post: "${text}"`);

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
		console.error(`Error: ${response.status} ${error}`);
		process.exit(1);
	}

	const result = await response.json();
	console.log("\n✅ Post created!");
	console.log(`URI: ${result.uri}`);
	console.log(`CID: ${result.cid}`);
	console.log(`Rev: ${result.commit.rev}`);
}

createPost();
