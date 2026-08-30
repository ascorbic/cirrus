import { waitUntil } from "cloudflare:workers";
import type { PDSEnv } from "./types";
import type { AccountDurableObject } from "./account-do";

const CHECK_INTERVAL_MS = 5 * 60 * 1000;
const POKE_INTERVAL_MS = 60 * 60 * 1000;

let nextCheckAt = 0;
let nextPokeAt = 0;

/** Reset the rate-limit gates (for tests). */
export function resetRelayPokeState(): void {
	nextCheckAt = 0;
	nextPokeAt = 0;
}

/**
 * After a successful write, check that someone is subscribed to the
 * firehose and send the relay a requestCrawl if not. A relay that has
 * marked this host offline never retries on its own — requestCrawl is
 * the only way back onto its crawl list.
 *
 * The subscriber check runs at most every five minutes per isolate and
 * the poke at most hourly. Scheduled via waitUntil so the write response
 * never waits on it; the outbound fetch happens in the Worker, never
 * inside the Durable Object (see repo/firehose.ts).
 *
 * Returns the scheduled work so tests can await it.
 */
export function pokeRelaysIfUnheard(
	env: PDSEnv,
	accountDO: DurableObjectStub<AccountDurableObject>,
): Promise<void> | undefined {
	const now = Date.now();
	if (now < nextCheckAt) return;
	nextCheckAt = now + CHECK_INTERVAL_MS;

	const work = (async () => {
		const status = await accountDO.getFirehoseStatus();
		if (status.subscribers.length > 0) return;

		if (Date.now() < nextPokeAt) return;
		nextPokeAt = Date.now() + POKE_INTERVAL_MS;

		const relays = (env.RELAYS ?? "https://bsky.network").split(",");
		await Promise.all(
			relays.map(async (relay) => {
				try {
					const url = new URL(
						"/xrpc/com.atproto.sync.requestCrawl",
						relay.trim(),
					);
					await fetch(url.toString(), {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ hostname: env.PDS_HOSTNAME }),
					});
				} catch (err) {
					// Invalid RELAYS entry or unreachable relay: the next write
					// retries after the poke interval.
					console.warn(`requestCrawl to ${relay.trim()} failed:`, err);
				}
			}),
		);
	})().catch((err) => {
		console.warn("Firehose subscriber check failed:", err);
	});
	try {
		waitUntil(work);
	} catch {
		// No execution context (direct calls in tests): the caller awaits
		// the returned promise instead.
	}
	return work;
}
