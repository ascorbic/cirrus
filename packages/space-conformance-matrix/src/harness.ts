/**
 * Resolvable harness identities and a syncer inbox for the reference run.
 *
 * The identity-gated checks need parties the reference can resolve: a
 * reader whose delegation tokens it verifies, a writer whose service auth
 * it verifies, a foreign space authority whose credentials and revocations
 * it honours, and a syncer / managing app it calls. Each identity gets its
 * own tiny HTTP server and a `did:web:localhost%3A<port>` DID, which the
 * reference resolves over plain http (its did:web resolver does that for
 * `localhost`, and dev-env disables SSRF protection). The server publishes
 * the identity's DID document — `#atproto` plus an `#atproto_pds` service
 * pointing back at itself — and records every XRPC call it receives, so
 * the "syncer" identity doubles as the inbox.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { InboxDelivery, SyncerInbox } from "@getcirrus/space-conformance";
import { KeypairIdentityProvider } from "@getcirrus/space-conformance/full";

export interface HarnessServices {
	identities: KeypairIdentityProvider;
	inbox: SyncerInbox;
	close(): Promise<void>;
}

export async function startHarnessServices(): Promise<HarnessServices> {
	const servers: Server[] = [];
	const deliveries: InboxDelivery[] = [];
	const waiters = new Set<() => void>();
	const responders = new Map<string, (delivery: InboxDelivery) => unknown>();

	const identities: KeypairIdentityProvider = new KeypairIdentityProvider(
		async (role) => {
			let did = "";
			const server = createServer((req, res) => {
				const url = new URL(req.url ?? "/", "http://localhost");
				if (url.pathname === "/.well-known/did.json") {
					void identities.identity(role).then((identity) => {
						res.setHeader("Content-Type", "application/json");
						res.end(
							JSON.stringify(
								KeypairIdentityProvider.didDocument(identity, {
									serviceEndpoint: `http://localhost:${port}`,
								}),
							),
						);
					});
					return;
				}
				const lxm = url.pathname.startsWith("/xrpc/")
					? url.pathname.slice("/xrpc/".length)
					: url.pathname;
				let raw = "";
				req.on("data", (chunk) => (raw += chunk));
				req.on("end", () => {
					let body: unknown;
					try {
						body = raw ? JSON.parse(raw) : undefined;
					} catch {
						body = raw;
					}
					const delivery: InboxDelivery = {
						lxm,
						body,
						params: Object.fromEntries(url.searchParams),
						...(req.headers.authorization
							? { authorization: req.headers.authorization }
							: {}),
						receivedAt: Date.now(),
					};
					// Only the inbox identity records; the others just publish a doc.
					if (did === inboxDid) {
						deliveries.push(delivery);
						for (const wake of waiters) wake();
					}
					const responder = did === inboxDid ? responders.get(lxm) : undefined;
					res.setHeader("Content-Type", "application/json");
					res.end(JSON.stringify(responder ? responder(delivery) : {}));
				});
			});
			await new Promise<void>((resolve) =>
				server.listen(0, "127.0.0.1", resolve),
			);
			servers.push(server);
			const port = (server.address() as AddressInfo).port;
			did = `did:web:localhost%3A${port}`;
			return did;
		},
	);

	const syncer = await identities.identity("syncer");
	const inboxDid = syncer.did;

	const inbox: SyncerInbox = {
		service: inboxDid,
		async waitFor(predicate, timeoutMs) {
			const deadline = Date.now() + timeoutMs;
			for (;;) {
				const found = deliveries.find(predicate);
				if (found) return found;
				const remaining = deadline - Date.now();
				if (remaining <= 0) return null;
				await new Promise<void>((resolve) => {
					const timer = setTimeout(done, remaining);
					function done() {
						clearTimeout(timer);
						waiters.delete(done);
						resolve();
					}
					waiters.add(done);
				});
			}
		},
		respond(lxm, handler) {
			if (handler) responders.set(lxm, handler);
			else responders.delete(lxm);
		},
	};

	return {
		identities,
		inbox,
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
