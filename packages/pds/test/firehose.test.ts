import { describe, it, expect } from "vitest";
import { CarReader } from "@ipld/car";
import { decodeAll } from "@atproto/lex-cbor";
import { env, worker, runInDurableObject } from "./helpers";
import type { AccountDurableObject } from "../src/account-do";
import type {
	SeqCommitEvent,
	SeqIdentityEvent,
	SeqSyncEvent,
	SeqAccountEvent,
} from "../src/sequencer";

/**
 * Decode a firehose frame into header and body.
 * Frames are two concatenated CBOR values: header + body.
 */
function decodeFrame(frame: Uint8Array): { header: unknown; body: unknown } {
	const decoded = [...decodeAll(frame)];
	if (decoded.length !== 2) {
		throw new Error(`Expected 2 CBOR values in frame, got ${decoded.length}`);
	}
	return { header: decoded[0], body: decoded[1] };
}

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
				const sequencer: Exclude<AccountDurableObject["sequencer"], null> = (
					instance as any
				).sequencer;

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

				const newEvent = events.find((e) =>
					e.event.ops.some(
						(op) => op.path === "app.bsky.feed.post/test-seq-123",
					),
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

	describe("Event Blocks", () => {
		it("should include CAR blocks with record data in events", async () => {
			const id = env.ACCOUNT.idFromName("account");
			const stub = env.ACCOUNT.get(id);

			await runInDurableObject(stub, async (instance: AccountDurableObject) => {
				await instance.getStorage();
				const sequencer = (instance as any).sequencer;

				const seqBefore = sequencer.getLatestSeq();

				// Create a record
				const result = await instance.rpcCreateRecord(
					"app.bsky.feed.post",
					"blocks-test-123",
					{
						$type: "app.bsky.feed.post",
						text: "Test blocks content",
						createdAt: new Date().toISOString(),
					},
				);

				// Get the event
				const events = await sequencer.getEventsSince(seqBefore, 10);
				const event = events.find((e: any) =>
					e.event.ops.some(
						(op: any) => op.path === "app.bsky.feed.post/blocks-test-123",
					),
				);

				expect(event).toBeDefined();
				expect(event!.event.blocks).toBeInstanceOf(Uint8Array);
				expect(event!.event.blocks.length).toBeGreaterThan(0);

				// Verify blocks can be parsed as CAR
				const reader = await CarReader.fromBytes(event!.event.blocks);
				const roots = await reader.getRoots();
				expect(roots.length).toBe(1);

				// Verify we can get the commit block
				const commitBlock = await reader.get(roots[0]!);
				expect(commitBlock).toBeDefined();

				// Verify record CID is in the blocks
				const recordCidStr = result.cid;
				let foundRecord = false;
				for await (const block of reader.blocks()) {
					if (block.cid.toString() === recordCidStr) {
						foundRecord = true;
						break;
					}
				}
				expect(foundRecord).toBe(true);
			});
		});

		it("should not have empty blocks in events", async () => {
			const id = env.ACCOUNT.idFromName("account");
			const stub = env.ACCOUNT.get(id);

			await runInDurableObject(stub, async (instance: AccountDurableObject) => {
				await instance.getStorage();
				const sequencer = (instance as any).sequencer;

				const seqBefore = sequencer.getLatestSeq();

				// Create a record
				await instance.rpcCreateRecord("app.bsky.feed.post", "non-empty-test", {
					$type: "app.bsky.feed.post",
					text: "Must have blocks",
					createdAt: new Date().toISOString(),
				});

				const events = await sequencer.getEventsSince(seqBefore, 10);
				expect(events.length).toBeGreaterThan(0);

				// All events should have non-empty blocks
				for (const event of events) {
					expect(event.event.blocks.length).toBeGreaterThan(50);
				}
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

	describe("Frame Encoding", () => {
		it("should encode commit events with #commit frame type", async () => {
			const id = env.ACCOUNT.idFromName("account");
			const stub = env.ACCOUNT.get(id);

			await runInDurableObject(stub, async (instance: AccountDurableObject) => {
				await instance.getStorage();
				const sequencer = (instance as any).sequencer;
				const encodeEventFrame = (instance as any).encodeEventFrame.bind(
					instance,
				);

				const seqBefore = sequencer.getLatestSeq();

				// Create a record to get a commit event
				await instance.rpcCreateRecord(
					"app.bsky.feed.post",
					"frame-type-test",
					{
						text: "Test frame type",
						createdAt: new Date().toISOString(),
					},
				);

				// Get the event
				const events = await sequencer.getEventsSince(seqBefore, 1);
				expect(events.length).toBe(1);
				expect(events[0].type).toBe("commit");

				// Encode the event and verify frame header
				const frame = encodeEventFrame(events[0] as SeqCommitEvent);
				const { header, body } = decodeFrame(frame);

				expect(header).toMatchObject({
					op: 1,
					t: "#commit",
				});
				expect(body).toMatchObject({
					repo: env.DID,
				});
			});
		});

		it("should encode identity events with #identity frame type", async () => {
			const id = env.ACCOUNT.idFromName("account");
			const stub = env.ACCOUNT.get(id);

			await runInDurableObject(stub, async (instance: AccountDurableObject) => {
				await instance.getStorage();
				const encodeEventFrame = (instance as any).encodeEventFrame.bind(
					instance,
				);

				// Create a mock identity event to test encoding
				const identityEvent: SeqIdentityEvent = {
					seq: 1,
					type: "identity",
					event: {
						seq: 1,
						did: env.DID,
						handle: env.HANDLE,
						time: new Date().toISOString(),
					},
					time: new Date().toISOString(),
				};

				// Encode and verify frame header uses #identity
				const frame = encodeEventFrame(identityEvent);
				const { header, body } = decodeFrame(frame);

				expect(header).toMatchObject({
					op: 1,
					t: "#identity",
				});
				expect(body).toMatchObject({
					did: env.DID,
					handle: env.HANDLE,
				});
			});
		});

		it("should dispatch to correct encoder based on event type", async () => {
			const id = env.ACCOUNT.idFromName("account");
			const stub = env.ACCOUNT.get(id);

			await runInDurableObject(stub, async (instance: AccountDurableObject) => {
				await instance.getStorage();
				const encodeEventFrame = (instance as any).encodeEventFrame.bind(
					instance,
				);
				const sequencer = (instance as any).sequencer;

				const seqBefore = sequencer.getLatestSeq();

				// Create a record
				await instance.rpcCreateRecord("app.bsky.feed.post", "dispatch-test", {
					text: "Test dispatch",
					createdAt: new Date().toISOString(),
				});

				const events = await sequencer.getEventsSince(seqBefore, 1);
				const commitEvent = events[0] as SeqCommitEvent;

				// Verify commit event gets #commit header
				const commitFrame = encodeEventFrame(commitEvent);
				const commitDecoded = decodeFrame(commitFrame);
				expect((commitDecoded.header as any).t).toBe("#commit");

				// Create identity event and verify it gets #identity header
				const identityEvent: SeqIdentityEvent = {
					...commitEvent,
					type: "identity",
					event: {
						seq: commitEvent.seq,
						did: env.DID,
						handle: env.HANDLE,
						time: new Date().toISOString(),
					},
				};

				const identityFrame = encodeEventFrame(identityEvent);
				const identityDecoded = decodeFrame(identityFrame);
				expect((identityDecoded.header as any).t).toBe("#identity");
			});
		});
	});

	describe("Identity Events", () => {
		it("should emit identity events with correct frame format", async () => {
			const id = env.ACCOUNT.idFromName("account");
			const stub = env.ACCOUNT.get(id);

			await runInDurableObject(stub, async (instance: AccountDurableObject) => {
				await instance.getStorage();

				// Emit an identity event
				const result = await instance.rpcEmitIdentityEvent(env.HANDLE);

				expect(result).toHaveProperty("seq");
				expect(typeof result.seq).toBe("number");
				expect(result.seq).toBeGreaterThan(0);
			});
		});

		it("emits an identity event without a handle (handle is optional per sync 1.1)", async () => {
			const id = env.ACCOUNT.idFromName("account");
			const stub = env.ACCOUNT.get(id);

			await runInDurableObject(stub, async (instance: AccountDurableObject) => {
				await instance.getStorage();
				const sequencer = (instance as any).sequencer;
				const seqBefore = sequencer.getLatestSeq();

				await instance.rpcEmitIdentityEvent();

				const events = await sequencer.getEventsSince(seqBefore, 10);
				const identityEvent = events.find(
					(e: any) => e.type === "identity",
				) as SeqIdentityEvent | undefined;
				expect(identityEvent).toBeDefined();
				expect(identityEvent!.event.did).toBe(env.DID);
				expect(identityEvent!.event.handle).toBeUndefined();
			});
		});
	});

	describe("sync 1.1 #commit shape", () => {
		it("emits prevData on every commit so relays can run MST inversion", async () => {
			const id = env.ACCOUNT.idFromName("account");
			const stub = env.ACCOUNT.get(id);

			await runInDurableObject(stub, async (instance: AccountDurableObject) => {
				await instance.getStorage();
				const sequencer = (instance as any).sequencer;
				const seqBefore = sequencer.getLatestSeq();

				await instance.rpcCreateRecord(
					"app.bsky.feed.post",
					"prevdata-test-1",
					{
						text: "first",
						createdAt: new Date().toISOString(),
					},
				);
				await instance.rpcCreateRecord(
					"app.bsky.feed.post",
					"prevdata-test-2",
					{
						text: "second",
						createdAt: new Date().toISOString(),
					},
				);

				const events = (await sequencer.getEventsSince(
					seqBefore,
					10,
				)) as SeqCommitEvent[];
				expect(events.length).toBeGreaterThanOrEqual(2);

				// Every commit must carry prevData. Decoded events come back
				// with prevData as a CidLinkWrapper — access via .$link.
				for (const event of events) {
					expect(event.event.prevData).toBeDefined();
					expect(event.event.prevData).not.toBeNull();
					expect(
						(event.event.prevData as unknown as { $link: string }).$link,
					).toMatch(/^bafy/);
				}

				// MST root changes after each write, so the two prevData CIDs
				// from consecutive writes must differ.
				const [first, second] = events;
				const firstLink = (
					first!.event.prevData as unknown as { $link: string }
				).$link;
				const secondLink = (
					second!.event.prevData as unknown as { $link: string }
				).$link;
				expect(firstLink).not.toBe(secondLink);
			});
		});

		it("sets tooBig=false unconditionally (deprecated per sync 1.1)", async () => {
			const id = env.ACCOUNT.idFromName("account");
			const stub = env.ACCOUNT.get(id);

			await runInDurableObject(stub, async (instance: AccountDurableObject) => {
				await instance.getStorage();
				const sequencer = (instance as any).sequencer;
				const seqBefore = sequencer.getLatestSeq();

				await instance.rpcCreateRecord("app.bsky.feed.post", "toobig-test", {
					text: "small",
					createdAt: new Date().toISOString(),
				});

				const [event] = (await sequencer.getEventsSince(
					seqBefore,
					1,
				)) as SeqCommitEvent[];
				expect(event!.event.tooBig).toBe(false);
			});
		});

		it("sets ops[].prev on delete and update, omits on create", async () => {
			const id = env.ACCOUNT.idFromName("account");
			const stub = env.ACCOUNT.get(id);

			await runInDurableObject(stub, async (instance: AccountDurableObject) => {
				await instance.getStorage();
				const sequencer = (instance as any).sequencer;

				const createResult = await instance.rpcCreateRecord(
					"app.bsky.feed.post",
					"prev-test-record",
					{
						text: "v1",
						createdAt: new Date().toISOString(),
					},
				);
				const originalCid = createResult.cid;

				const seqBeforeUpdate = sequencer.getLatestSeq();
				const updateResult = await instance.rpcPutRecord(
					"app.bsky.feed.post",
					"prev-test-record",
					{
						text: "v2",
						createdAt: new Date().toISOString(),
					},
				);
				const updatedCid = updateResult.cid;

				const seqBeforeDelete = sequencer.getLatestSeq();
				await instance.rpcDeleteRecord(
					"app.bsky.feed.post",
					"prev-test-record",
				);

				const updateEvents = (await sequencer.getEventsSince(
					seqBeforeUpdate,
					1,
				)) as SeqCommitEvent[];
				const updateOp = updateEvents[0]!.event.ops[0]!;
				expect(updateOp.action).toBe("update");
				expect((updateOp.prev as unknown as { $link: string }).$link).toBe(
					originalCid,
				);

				const deleteEvents = (await sequencer.getEventsSince(
					seqBeforeDelete,
					1,
				)) as SeqCommitEvent[];
				const deleteOp = deleteEvents[0]!.event.ops[0]!;
				expect(deleteOp.action).toBe("delete");
				expect(deleteOp.cid).toBeNull();
				expect((deleteOp.prev as unknown as { $link: string }).$link).toBe(
					updatedCid,
				);

				// Sanity: creates have no prev field.
				const seqBeforeCreate = sequencer.getLatestSeq();
				await instance.rpcCreateRecord("app.bsky.feed.post", "no-prev-test", {
					text: "fresh",
					createdAt: new Date().toISOString(),
				});
				const createEvents = (await sequencer.getEventsSince(
					seqBeforeCreate,
					1,
				)) as SeqCommitEvent[];
				const createOp = createEvents[0]!.event.ops[0]!;
				expect(createOp.action).toBe("create");
				expect(createOp.prev).toBeUndefined();
			});
		});

		it("prevData on commit N equals the prior commit's data MST root", async () => {
			const id = env.ACCOUNT.idFromName("account");
			const stub = env.ACCOUNT.get(id);

			await runInDurableObject(stub, async (instance: AccountDurableObject) => {
				await instance.getStorage();
				const sequencer = (instance as any).sequencer;
				const seqBefore = sequencer.getLatestSeq();

				await instance.rpcCreateRecord("app.bsky.feed.post", "prevdata-link-a", {
					text: "a",
					createdAt: new Date().toISOString(),
				});
				await instance.rpcCreateRecord("app.bsky.feed.post", "prevdata-link-b", {
					text: "b",
					createdAt: new Date().toISOString(),
				});

				const events = (await sequencer.getEventsSince(
					seqBefore,
					10,
				)) as SeqCommitEvent[];
				expect(events.length).toBeGreaterThanOrEqual(2);
				const [first, second] = events;

				// Decode the first commit block from its CAR to read its `data` field.
				const firstReader = await CarReader.fromBytes(first!.event.blocks);
				const firstRoots = await firstReader.getRoots();
				const firstCommitBlock = await firstReader.get(firstRoots[0]!);
				expect(firstCommitBlock).toBeDefined();
				// The commit object is DAG-CBOR. Decode and pull out `data`.
				const { decode: decodeCbor } = await import("../src/cbor-compat");
				const decodedCommit = decodeCbor(firstCommitBlock!.bytes) as {
					data: { $link: string };
				};
				expect(decodedCommit.data?.$link).toMatch(/^bafy/);

				const secondPrevDataLink = (
					second!.event.prevData as unknown as { $link: string }
				).$link;
				expect(secondPrevDataLink).toBe(decodedCommit.data.$link);
			});
		});

		it("rejects applyWrites with more than 200 ops (sync 1.1 cap)", async () => {
			const id = env.ACCOUNT.idFromName("account");
			const stub = env.ACCOUNT.get(id);

			await runInDurableObject(stub, async (instance: AccountDurableObject) => {
				await instance.getStorage();
				const writes = Array.from({ length: 201 }, (_, i) => ({
					$type: "com.atproto.repo.applyWrites#create",
					collection: "app.bsky.feed.post",
					value: {
						text: `bulk ${i}`,
						createdAt: new Date().toISOString(),
					},
				}));
				await expect(instance.rpcApplyWrites(writes)).rejects.toThrow(
					/at most 200 operations/,
				);
			});
		});
	});

	describe("sync 1.1 #account and #sync events", () => {
		it("emits #account(active=false) on deactivate and #account+#sync on activate", async () => {
			const id = env.ACCOUNT.idFromName("account");
			const stub = env.ACCOUNT.get(id);

			await runInDurableObject(stub, async (instance: AccountDurableObject) => {
				await instance.getStorage();
				const sequencer = (instance as any).sequencer;

				// Make sure there's a repo root so activate can emit #sync.
				await instance.rpcCreateRecord("app.bsky.feed.post", "ensure-root", {
					text: "x",
					createdAt: new Date().toISOString(),
				});

				const seqBeforeDeactivate = sequencer.getLatestSeq();
				await instance.rpcDeactivateAccount();
				const deactivateEvents = await sequencer.getEventsSince(
					seqBeforeDeactivate,
					10,
				);
				const accountEvt = deactivateEvents.find(
					(e: any) => e.type === "account",
				) as SeqAccountEvent | undefined;
				expect(accountEvt).toBeDefined();
				expect(accountEvt!.event.active).toBe(false);
				expect(accountEvt!.event.status).toBe("deactivated");

				const seqBeforeActivate = sequencer.getLatestSeq();
				await instance.rpcActivateAccount();
				const activateEvents = await sequencer.getEventsSince(
					seqBeforeActivate,
					10,
				);
				const account = activateEvents.find(
					(e: any) => e.type === "account",
				) as SeqAccountEvent | undefined;
				const identity = activateEvents.find(
					(e: any) => e.type === "identity",
				) as SeqIdentityEvent | undefined;
				const sync = activateEvents.find(
					(e: any) => e.type === "sync",
				) as SeqSyncEvent | undefined;

				expect(account).toBeDefined();
				expect(account!.event.active).toBe(true);
				expect(account!.event.status).toBeUndefined();

				expect(identity).toBeDefined();
				expect(identity!.event.did).toBe(env.DID);

				expect(sync).toBeDefined();
				expect(sync!.event.did).toBe(env.DID);
				expect(sync!.event.blocks).toBeInstanceOf(Uint8Array);
				expect(sync!.event.blocks.length).toBeGreaterThan(0);

				// Sync event's blocks CAR contains exactly the current commit block.
				const reader = await CarReader.fromBytes(sync!.event.blocks);
				const roots = await reader.getRoots();
				expect(roots).toHaveLength(1);
				const commitBlock = await reader.get(roots[0]!);
				expect(commitBlock).toBeDefined();
			});
		});

		it("idempotent activate/deactivate do not emit duplicate events", async () => {
			const id = env.ACCOUNT.idFromName("account");
			const stub = env.ACCOUNT.get(id);

			await runInDurableObject(stub, async (instance: AccountDurableObject) => {
				await instance.getStorage();
				const sequencer = (instance as any).sequencer;

				await instance.rpcActivateAccount(); // ensure active
				const seqBefore = sequencer.getLatestSeq();
				await instance.rpcActivateAccount(); // no-op
				expect(sequencer.getLatestSeq()).toBe(seqBefore);
			});
		});

		it("#sync and #account frames decode to the right t-tag", async () => {
			const id = env.ACCOUNT.idFromName("account");
			const stub = env.ACCOUNT.get(id);

			await runInDurableObject(stub, async (instance: AccountDurableObject) => {
				await instance.getStorage();
				const encodeEventFrame = (instance as any).encodeEventFrame.bind(
					instance,
				);

				const accountEvt: SeqAccountEvent = {
					seq: 1,
					type: "account",
					time: new Date().toISOString(),
					event: {
						seq: 1,
						did: env.DID,
						active: true,
						time: new Date().toISOString(),
					},
				};
				const accountFrame = encodeEventFrame(accountEvt);
				const accountDecoded = decodeFrame(accountFrame);
				expect((accountDecoded.header as any).t).toBe("#account");

				const syncEvt: SeqSyncEvent = {
					seq: 2,
					type: "sync",
					time: new Date().toISOString(),
					event: {
						seq: 2,
						did: env.DID,
						rev: "3kt7qsl4nrk2x",
						blocks: new Uint8Array(),
						time: new Date().toISOString(),
					},
				};
				const syncFrame = encodeEventFrame(syncEvt);
				const syncDecoded = decodeFrame(syncFrame);
				expect((syncDecoded.header as any).t).toBe("#sync");
			});
		});
	});

	describe("#info OutdatedCursor", () => {
		it("sends an OutdatedCursor info frame when cursor is before retention window", async () => {
			const id = env.ACCOUNT.idFromName("account");
			const stub = env.ACCOUNT.get(id);

			await runInDurableObject(stub, async (instance: AccountDurableObject) => {
				await instance.getStorage();
				const sequencer = (instance as any).sequencer;
				const backfillFirehose = (instance as any).backfillFirehose.bind(
					instance,
				);

				// Generate a few events so getEarliestSeq is non-null.
				await instance.rpcCreateRecord(
					"app.bsky.feed.post",
					"outdated-cursor-seed-1",
					{ text: "a", createdAt: new Date().toISOString() },
				);
				await instance.rpcCreateRecord(
					"app.bsky.feed.post",
					"outdated-cursor-seed-2",
					{ text: "b", createdAt: new Date().toISOString() },
				);

				// Prune so the earliest seq is no longer 1; cursor of 0
				// becomes "before the retention window".
				await sequencer.pruneOldEvents(1);
				const earliest = sequencer.getEarliestSeq();
				expect(earliest).toBeGreaterThan(1);

				// Capture frames the backfill would send.
				const sent: Uint8Array[] = [];
				const fakeWs = {
					send(frame: Uint8Array) {
						sent.push(frame);
					},
					deserializeAttachment() {
						return { cursor: 0 };
					},
					serializeAttachment() {},
					close() {},
				};

				await backfillFirehose(fakeWs as any, 0);

				expect(sent.length).toBeGreaterThan(0);
				const { header, body } = decodeFrame(sent[0]!);
				expect(header).toMatchObject({ op: 1, t: "#info" });
				expect(body).toMatchObject({ name: "OutdatedCursor" });
			});
		});
	});
});
