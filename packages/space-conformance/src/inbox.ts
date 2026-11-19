/**
 * A ready-made syncer inbox: the `notify` endpoint and managing app the
 * notification checks need, as a fetch-style handler. A harness serves
 * `handle` at `endpoint` however suits it — a node HTTP server, a route in
 * an in-process fixture — and passes `inbox` as `ctx.syncerInbox`.
 *
 * Browser-safe (Request/Response only), though no browser can be reached
 * by a remote host, so the web checker never offers it.
 */

import type { InboxDelivery, SyncerInbox } from "./model.js";
import { toBase64Url } from "./encoding.js";

export interface SyncerInboxHandle {
	inbox: SyncerInbox;
	/** Serve a request addressed to the inbox's endpoint. */
	handle(request: Request): Promise<Response>;
	/** Every delivery so far, oldest first. */
	deliveries(): readonly InboxDelivery[];
}

const json = (status: number, body: unknown) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});

export function createSyncerInbox(opts: {
	/** Base URL the target will call (`{endpoint}/xrpc/<nsid>`). */
	endpoint: string;
	/** A `did#serviceId` reference resolving to `endpoint` (managing app). */
	service: string;
}): SyncerInboxHandle {
	const deliveries: InboxDelivery[] = [];
	const waiters = new Set<() => void>();
	const responders = new Map<string, (d: InboxDelivery) => unknown>();
	const tokens = new Map<string, string>(); // token → space

	const known = (body: unknown) => {
		const b = body as { space?: unknown; token?: unknown } | undefined;
		return (
			typeof b?.token === "string" &&
			typeof b.space === "string" &&
			tokens.get(b.token) === b.space
		);
	};

	async function handle(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const lxm = url.pathname.replace(/^\/xrpc\//, "");
		const raw = request.method === "POST" ? await request.text() : "";
		let body: unknown;
		try {
			body = raw ? JSON.parse(raw) : undefined;
		} catch {
			body = raw;
		}
		let response: Response;
		if (lxm === "com.atproto.space.confirmRegistration") {
			// Echo the challenge only for a token issued for this space.
			response = known(body)
				? json(200, { challenge: (body as { challenge: unknown }).challenge })
				: json(400, { error: "InvalidToken", message: "unknown token" });
		} else if (lxm === "com.atproto.space.notifySpaceUpdate") {
			response = known(body)
				? json(200, {})
				: json(400, { error: "InvalidToken", message: "unknown token" });
		} else {
			const responder = responders.get(lxm);
			response = responder
				? json(
						200,
						responder({
							lxm,
							body,
							params: Object.fromEntries(url.searchParams),
							status: 200,
							receivedAt: Date.now(),
						}),
					)
				: json(501, { error: "MethodNotImplemented" });
		}
		const authorization = request.headers.get("authorization");
		deliveries.push({
			lxm,
			body,
			params: Object.fromEntries(url.searchParams),
			...(authorization ? { authorization } : {}),
			status: response.status,
			receivedAt: Date.now(),
		});
		for (const wake of waiters) wake();
		return response;
	}

	const inbox: SyncerInbox = {
		endpoint: opts.endpoint,
		service: opts.service,
		issueToken(space) {
			const token = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
			tokens.set(token, space);
			return token;
		},
		async waitFor(predicate, timeoutMs) {
			const deadline = Date.now() + timeoutMs;
			for (;;) {
				const found = deliveries.find(predicate);
				if (found) return found;
				const remaining = deadline - Date.now();
				if (remaining <= 0) return null;
				await new Promise<void>((resolve) => {
					const done = () => {
						clearTimeout(timer);
						waiters.delete(done);
						resolve();
					};
					const timer = setTimeout(done, remaining);
					waiters.add(done);
				});
			}
		},
		respond(lxm, handler) {
			if (handler) responders.set(lxm, handler);
			else responders.delete(lxm);
		},
	};

	return { inbox, handle, deliveries: () => deliveries };
}
