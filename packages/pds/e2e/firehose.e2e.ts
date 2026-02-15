import { describe, it, expect, beforeAll } from "vitest";
import { AtpAgent } from "@atproto/api";
import WebSocket from "ws";
import {
	createAgent,
	getPort,
	TEST_DID,
	TEST_HANDLE,
	TEST_PASSWORD,
	uniqueRkey,
} from "./helpers";

describe("Firehose (subscribeRepos)", () => {
	let agent: AtpAgent;

	beforeAll(async () => {
		agent = createAgent();
		await agent.login({
			identifier: TEST_HANDLE,
			password: TEST_PASSWORD,
		});
	});

	it("connects to WebSocket endpoint", async () => {
		const port = getPort();
		const wsUrl = `ws://localhost:${port}/xrpc/com.atproto.sync.subscribeRepos`;

		const ws = new WebSocket(wsUrl);

		await new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(() => {
				ws.close();
				reject(new Error("WebSocket connection timeout"));
			}, 5000);

			ws.on("open", () => {
				clearTimeout(timeout);
				resolve();
			});
			ws.on("error", (err) => {
				clearTimeout(timeout);
				reject(err);
			});
		});

		ws.close();
	});

	it("receives commit events when records are created", async () => {
		const port = getPort();
		const wsUrl = `ws://localhost:${port}/xrpc/com.atproto.sync.subscribeRepos`;

		const messages: Buffer[] = [];
		const ws = new WebSocket(wsUrl);

		await new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(() => {
				ws.close();
				reject(new Error("WebSocket connection timeout"));
			}, 5000);

			ws.on("open", () => {
				clearTimeout(timeout);
				resolve();
			});
			ws.on("error", (err) => {
				clearTimeout(timeout);
				reject(err);
			});
		});

		ws.on("message", (data: Buffer) => {
			messages.push(data);
		});

		// Create a record - should trigger event
		const rkey = uniqueRkey();
		await agent.com.atproto.repo.createRecord({
			repo: TEST_DID,
			collection: "app.bsky.feed.post",
			rkey,
			record: {
				$type: "app.bsky.feed.post",
				text: "Firehose test post",
				createdAt: new Date().toISOString(),
			},
		});

		// Wait for event to arrive
		await new Promise((r) => setTimeout(r, 1000));

		ws.close();

		// Should have received at least one message
		expect(messages.length).toBeGreaterThan(0);

		// Messages should be binary (CBOR frames)
		for (const msg of messages) {
			expect(Buffer.isBuffer(msg)).toBe(true);
		}
	});

	it("supports cursor-based backfill", async () => {
		// Create some records first to have history
		for (let i = 0; i < 3; i++) {
			await agent.com.atproto.repo.createRecord({
				repo: TEST_DID,
				collection: "app.bsky.feed.post",
				rkey: uniqueRkey(),
				record: {
					$type: "app.bsky.feed.post",
					text: `Backfill test ${i}`,
					createdAt: new Date().toISOString(),
				},
			});
		}

		const port = getPort();
		// Connect with cursor=0 to get all events from the beginning
		const wsUrl = `ws://localhost:${port}/xrpc/com.atproto.sync.subscribeRepos?cursor=0`;

		const messages: Buffer[] = [];
		const ws = new WebSocket(wsUrl);

		await new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(() => {
				ws.close();
				reject(new Error("WebSocket connection timeout"));
			}, 5000);

			ws.on("open", () => {
				clearTimeout(timeout);
				resolve();
			});
			ws.on("error", (err) => {
				clearTimeout(timeout);
				reject(err);
			});
		});

		ws.on("message", (data: Buffer) => {
			messages.push(data);
		});

		// Wait for backfill to complete
		await new Promise((r) => setTimeout(r, 2000));

		ws.close();

		// Should have received multiple backfilled events
		expect(messages.length).toBeGreaterThan(0);
	});

	it("closes connection gracefully", async () => {
		const port = getPort();
		const wsUrl = `ws://localhost:${port}/xrpc/com.atproto.sync.subscribeRepos`;

		const ws = new WebSocket(wsUrl);

		await new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(() => {
				ws.close();
				reject(new Error("WebSocket connection timeout"));
			}, 5000);

			ws.on("open", () => {
				clearTimeout(timeout);
				resolve();
			});
			ws.on("error", (err) => {
				clearTimeout(timeout);
				reject(err);
			});
		});

		// Gracefully close
		const closePromise = new Promise<void>((resolve) => {
			ws.on("close", () => resolve());
		});

		ws.close();
		await closePromise;

		expect(ws.readyState).toBe(WebSocket.CLOSED);
	});
});
