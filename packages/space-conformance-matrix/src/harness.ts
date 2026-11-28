/**
 * Resolvable harness identities and a syncer inbox for the reference run.
 *
 * The identity-gated checks need parties the reference can resolve: a
 * reader whose delegation tokens it verifies, a writer whose service auth
 * it verifies, and a foreign space authority whose credentials and
 * revocations it honours. Each identity gets its own tiny HTTP server and a
 * `did:web:localhost%3A<port>` DID, which the reference resolves over plain
 * http (its did:web resolver does that for `localhost`, and dev-env runs it
 * in dev mode, so SSRF protection is off). The server publishes the
 * identity's DID document: `#atproto` plus an `#atproto_pds` service
 * pointing back at itself.
 *
 * The "syncer" identity's server also serves the suite's ready-made
 * syncer inbox (`createSyncerInbox`) for every other path: its base URL is
 * the `notify` endpoint, and `<did>#atproto_pds` names it as a managing app.
 */

import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { SyncerInbox } from "@getcirrus/space-conformance";
import {
	KeypairIdentityProvider,
	createSyncerInbox,
	type SyncerInboxHandle,
} from "@getcirrus/space-conformance/full";

export interface HarnessServices {
	identities: KeypairIdentityProvider;
	inbox: SyncerInbox;
	close(): Promise<void>;
}

async function toRequest(
	req: IncomingMessage,
	origin: string,
): Promise<Request> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(chunk as Buffer);
	const headers = new Headers();
	for (const [k, v] of Object.entries(req.headers)) {
		if (typeof v === "string") headers.set(k, v);
	}
	return new Request(new URL(req.url ?? "/", origin), {
		method: req.method,
		headers,
		...(req.method === "GET" || req.method === "HEAD"
			? {}
			: { body: Buffer.concat(chunks) }),
	});
}

export async function startHarnessServices(): Promise<HarnessServices> {
	const servers: Server[] = [];
	let inboxHandle: SyncerInboxHandle | undefined;

	const identities: KeypairIdentityProvider = new KeypairIdentityProvider(
		async (role) => {
			let port = 0;
			const server = createServer((req, res) => {
				const origin = `http://localhost:${port}`;
				void (async () => {
					const url = new URL(req.url ?? "/", origin);
					if (url.pathname === "/.well-known/did.json") {
						const identity = await identities.identity(role);
						res.setHeader("Content-Type", "application/json");
						res.end(
							JSON.stringify(
								KeypairIdentityProvider.didDocument(identity, {
									serviceEndpoint: origin,
								}),
							),
						);
						return;
					}
					if (role !== "syncer" || !inboxHandle) {
						res.statusCode = 404;
						res.end();
						return;
					}
					const response = await inboxHandle.handle(
						await toRequest(req, origin),
					);
					res.statusCode = response.status;
					response.headers.forEach((v, k) => res.setHeader(k, v));
					res.end(Buffer.from(await response.arrayBuffer()));
				})().catch((err) => {
					res.statusCode = 500;
					res.end(String(err));
				});
			});
			await new Promise<void>((resolve) =>
				server.listen(0, "127.0.0.1", resolve),
			);
			servers.push(server);
			port = (server.address() as AddressInfo).port;
			return `did:web:localhost%3A${port}`;
		},
	);

	const syncer = await identities.identity("syncer");
	const port = decodeURIComponent(syncer.did).split(":").at(-1);
	inboxHandle = createSyncerInbox({
		endpoint: `http://localhost:${port}`,
		service: `${syncer.did}#atproto_pds`,
	});

	return {
		identities,
		inbox: inboxHandle.inbox,
		close: async () => {
			await Promise.all(
				servers.map(
					(server) =>
						new Promise<void>((resolve) => {
							server.closeAllConnections();
							server.close(() => resolve());
						}),
				),
			);
		},
	};
}
