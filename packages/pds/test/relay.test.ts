import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env, worker, runInDurableObject } from "./helpers";
import type { AccountDurableObject } from "../src/account-do";
import { pokeRelaysIfUnheard, resetRelayPokeState } from "../src/relay";

type Stub = DurableObjectStub<AccountDurableObject>;

function fakeAccountDO(subscriberCount: number): Stub {
	return {
		getFirehoseStatus: async () => ({
			subscribers: Array.from({ length: subscriberCount }, () => ({
				connectedAt: Date.now(),
				cursor: 0,
				ip: null,
			})),
			latestSeq: null,
		}),
	} as unknown as Stub;
}

describe("pokeRelaysIfUnheard", () => {
	beforeEach(() => {
		resetRelayPokeState();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("sends requestCrawl to the default relay when nothing is subscribed", async () => {
		const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);

		await pokeRelaysIfUnheard({ ...env, RELAYS: undefined }, fakeAccountDO(0));

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0]! as unknown as [
			string,
			RequestInit,
		];
		expect(url).toBe("https://bsky.network/xrpc/com.atproto.sync.requestCrawl");
		expect(init.method).toBe("POST");
		expect(JSON.parse(init.body as string)).toEqual({
			hostname: env.PDS_HOSTNAME,
		});
	});

	it("does not poke while a subscriber is connected", async () => {
		const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);

		await pokeRelaysIfUnheard(env, fakeAccountDO(1));

		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("rate-limits the subscriber check", async () => {
		const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);

		await pokeRelaysIfUnheard(env, fakeAccountDO(0));
		const second = pokeRelaysIfUnheard(env, fakeAccountDO(0));

		expect(second).toBeUndefined();
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("pokes every relay in a comma-separated RELAYS override", async () => {
		const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);

		await pokeRelaysIfUnheard(
			{
				...env,
				RELAYS: "https://relay-a.example, https://relay-b.example",
			},
			fakeAccountDO(0),
		);

		const urls = fetchMock.mock.calls.map((call) => call[0] as string).sort();
		expect(urls).toEqual([
			"https://relay-a.example/xrpc/com.atproto.sync.requestCrawl",
			"https://relay-b.example/xrpc/com.atproto.sync.requestCrawl",
		]);
	});

	it("swallows relay fetch failures", async () => {
		const fetchMock = vi.fn(async () => {
			throw new Error("relay unreachable");
		});
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			pokeRelaysIfUnheard(env, fakeAccountDO(0)),
		).resolves.toBeUndefined();
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("pokes the relay after a record write commits with no subscribers", async () => {
		const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);

		const stub = env.ACCOUNT.get(env.ACCOUNT.idFromName(env.DID));
		await runInDurableObject(
			stub,
			async (instance: AccountDurableObject, state) => {
				for (const ws of state.getWebSockets()) {
					ws.close();
				}
			},
		);

		const response = await worker.fetch(
			new Request("http://pds.test/xrpc/com.atproto.repo.createRecord", {
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
						text: "relay poke test",
						createdAt: new Date().toISOString(),
					},
				}),
			}),
			env,
		);
		expect(response.status).toBe(200);

		await vi.waitFor(() => {
			expect(fetchMock).toHaveBeenCalledWith(
				"https://relay.invalid/xrpc/com.atproto.sync.requestCrawl",
				expect.objectContaining({ method: "POST" }),
			);
		});
	});
});
