import { describe, it, expect } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import worker from "../src/index";
import type { AccountDurableObject } from "../src/account-do";

describe("Firehose (subscribeRepos)", () => {
	describe("WebSocket Upgrade", () => {
		it("should reject non-WebSocket requests", async () => {
			const response = await worker.fetch(
				new Request("http://pds.test/xrpc/com.atproto.sync.subscribeRepos"),
				env,
			);

			expect(response.status).toBe(400);
			const data = await response.json();
			expect(data).toMatchObject({
				error: "InvalidRequest",
			});
		});
	});

	describe("Event Sequencing", () => {
		it("should sequence createRecord events", async () => {
			const id = env.ACCOUNT.idFromName("account");
			const stub = env.ACCOUNT.get(id);

			await runInDurableObject(stub, async (instance: AccountDurableObject) => {
				// Ensure storage is initialized
				await instance.getStorage();
				const sequencer = (instance as any).sequencer;

				// Get current seq
				const seqBefore = sequencer.getLatestSeq();

				// Create a record
				await instance.rpcCreateRecord("app.bsky.feed.post", "test-seq-123", {
					text: "Test sequencing",
					createdAt: new Date().toISOString(),
				});

				// Check that event was sequenced
				const seqAfter = sequencer.getLatestSeq();
				expect(seqAfter).toBeGreaterThan(seqBefore);

				// Verify event can be retrieved
				const events = await sequencer.getEventsSince(seqBefore, 10);
				expect(events.length).toBeGreaterThan(0);

				const newEvent = events.find(e =>
					e.event.ops.some(op => op.path === "app.bsky.feed.post/test-seq-123")
				);
				expect(newEvent).toBeDefined();
				if (newEvent) {
					expect(newEvent.type).toBe("commit");
					expect(newEvent.event.repo).toBe(env.DID);
					expect(newEvent.event.ops).toHaveLength(1);
					expect(newEvent.event.ops[0]?.action).toBe("create");
				}
			});
		});

		it("should sequence deleteRecord events", async () => {
			const id = env.ACCOUNT.idFromName("account");
			const stub = env.ACCOUNT.get(id);

			await runInDurableObject(stub, async (instance: AccountDurableObject) => {
				// Ensure storage is initialized
				await instance.getStorage();
				const sequencer = (instance as any).sequencer;

				// Create a record first
				await instance.rpcCreateRecord("app.bsky.feed.post", "to-delete-seq", {
					text: "Will be deleted",
					createdAt: new Date().toISOString(),
				});

				const seqBeforeDelete = sequencer.getLatestSeq();

				// Delete it
				await instance.rpcDeleteRecord("app.bsky.feed.post", "to-delete-seq");

				// Check that delete was sequenced
				const seqAfterDelete = sequencer.getLatestSeq();
				expect(seqAfterDelete).toBeGreaterThan(seqBeforeDelete);

				// Verify delete event
				const events = await sequencer.getEventsSince(seqBeforeDelete, 10);
				expect(events.length).toBeGreaterThan(0);

				const deleteEvent = events[events.length - 1];
				expect(deleteEvent).toBeDefined();
				if (deleteEvent) {
					expect(deleteEvent.event.ops).toHaveLength(1);
					expect(deleteEvent.event.ops[0]?.action).toBe("delete");
					expect(deleteEvent.event.ops[0]?.path).toBe(
						"app.bsky.feed.post/to-delete-seq",
					);
				}
			});
		});
	});

	describe("Cursor Validation", () => {
		it("should handle backfill from cursor", async () => {
			const id = env.ACCOUNT.idFromName("account");
			const stub = env.ACCOUNT.get(id);

			await runInDurableObject(stub, async (instance: AccountDurableObject) => {
				// Ensure storage is initialized
				await instance.getStorage();
				const sequencer = (instance as any).sequencer;

				const seqBefore = sequencer.getLatestSeq();

				// Create some events
				for (let i = 0; i < 3; i++) {
					await instance.rpcCreateRecord(
						"app.bsky.feed.post",
						`backfill-${i}`,
						{
							text: `Backfill ${i}`,
							createdAt: new Date().toISOString(),
						},
					);
				}

				// Get events since the cursor
				const events = await sequencer.getEventsSince(seqBefore, 10);
				expect(events.length).toBe(3);
			});
		});
	});

	describe("Event Retrieval", () => {
		it("should retrieve events since cursor", async () => {
			const id = env.ACCOUNT.idFromName("account");
			const stub = env.ACCOUNT.get(id);

			await runInDurableObject(stub, async (instance: AccountDurableObject) => {
				// Ensure storage is initialized
				await instance.getStorage();
				const sequencer = (instance as any).sequencer;

				// Get current seq
				const currentSeq = sequencer.getLatestSeq();

				// Create 3 new records
				for (let i = 0; i < 3; i++) {
					await instance.rpcCreateRecord(
						"app.bsky.feed.post",
						`cursor-test-${i}`,
						{
							text: `Post ${i}`,
							createdAt: new Date().toISOString(),
						},
					);
				}

				// Get events since the old cursor
				const events = await sequencer.getEventsSince(currentSeq, 10);
				expect(events.length).toBe(3);

				// Verify all are commit events
				for (const event of events) {
					expect(event.type).toBe("commit");
					expect(event.event.repo).toBe(env.DID);
				}
			});
		});

		it("should respect limit parameter", async () => {
			const id = env.ACCOUNT.idFromName("account");
			const stub = env.ACCOUNT.get(id);

			await runInDurableObject(stub, async (instance: AccountDurableObject) => {
				// Ensure storage is initialized
				await instance.getStorage();
				const sequencer = (instance as any).sequencer;

				const currentSeq = sequencer.getLatestSeq();

				// Create 10 records
				for (let i = 0; i < 10; i++) {
					await instance.rpcCreateRecord(
						"app.bsky.feed.post",
						`limit-test-${i}`,
						{
							text: `Post ${i}`,
							createdAt: new Date().toISOString(),
						},
					);
				}

				// Request only 5 events
				const events = await sequencer.getEventsSince(currentSeq, 5);
				expect(events.length).toBe(5);
			});
		});
	});
});
