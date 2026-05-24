import { describe, it, expect } from "vitest";
import { env, worker } from "./helpers";

describe("com.atproto.sync.listReposByCollection", () => {
	it("returns this PDS's DID for a collection with records", async () => {
		const createResponse = await worker.fetch(
			new Request(`http://pds.test/xrpc/com.atproto.repo.createRecord`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${env.AUTH_TOKEN}`,
				},
				body: JSON.stringify({
					repo: env.DID,
					collection: "app.bsky.feed.post",
					record: {
						$type: "app.bsky.feed.post",
						text: "Hello listReposByCollection",
						createdAt: new Date().toISOString(),
					},
				}),
			}),
			env,
		);
		expect(createResponse.status).toBe(200);

		const response = await worker.fetch(
			new Request(
				`http://pds.test/xrpc/com.atproto.sync.listReposByCollection?collection=app.bsky.feed.post`,
			),
			env,
		);

		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			repos: Array<{ did: string }>;
			cursor?: string;
		};
		expect(body.repos).toEqual([{ did: env.DID }]);
		expect(body.cursor).toBeUndefined();
	});

	it("returns an empty list for a collection with no records", async () => {
		const response = await worker.fetch(
			new Request(
				`http://pds.test/xrpc/com.atproto.sync.listReposByCollection?collection=app.bsky.graph.block`,
			),
			env,
		);

		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			repos: Array<{ did: string }>;
		};
		expect(body.repos).toEqual([]);
	});

	it("rejects requests missing the collection parameter", async () => {
		const response = await worker.fetch(
			new Request(
				`http://pds.test/xrpc/com.atproto.sync.listReposByCollection`,
			),
			env,
		);

		expect(response.status).toBe(400);
		const body = (await response.json()) as Record<string, unknown>;
		expect(body.error).toBe("InvalidRequest");
		expect(body.message).toContain("collection");
	});

	it("rejects an invalid collection NSID", async () => {
		const response = await worker.fetch(
			new Request(
				`http://pds.test/xrpc/com.atproto.sync.listReposByCollection?collection=not-an-nsid`,
			),
			env,
		);

		expect(response.status).toBe(400);
		const body = (await response.json()) as Record<string, unknown>;
		expect(body.error).toBe("InvalidRequest");
		expect(body.message).toContain("collection");
	});
});
