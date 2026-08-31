/**
 * OAuth loopback sign-in for the CLI — the `gh auth login` shape: start an
 * ephemeral 127.0.0.1 callback server, register as an atproto loopback
 * client, open the authorization URL in the user's browser, and exchange
 * the callback for a DPoP-bound session.
 *
 * This is the auth path that involves no password at all and works against
 * any PDS with an atproto OAuth server. The session's tokens are DPoP-bound
 * — unusable as a plain bearer — so the run authenticates through
 * `operator.fetch`, with the client library signing every request (and
 * handling nonce challenges) rather than a static header.
 */

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import {
	NodeOAuthClient,
	type NodeSavedSession,
	type NodeSavedState,
	type OAuthSession,
} from "@atproto/oauth-client-node";

/**
 * The scope the conformance run signs in with: generic repo access (for
 * uploadBlob) plus full record actions and space management on the probe
 * space type under the user's own authority. Mirrors the web checker.
 */
const OAUTH_SCOPE =
	"atproto transition:generic space:app.bsky.group?collection=*&manage=create&manage=update&manage=delete";

/** How long to wait for the user to complete the browser flow. */
const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

export interface OAuthOperator {
	/** Signs same-origin requests with the session's DPoP key. */
	fetch: typeof fetch;
	did: string;
	/** Best-effort token revocation once the run is done. */
	signOut(): Promise<void>;
}

/**
 * A fetch that routes requests for `origin` through the session (which
 * signs them) and everything else through the plain global fetch — the
 * same shape as the web adapter, so checks keep their bare `ctx.fetch`
 * for deliberately-anonymous requests.
 */
export function originGatedFetch(
	signing: (pathname: string, init?: RequestInit) => Promise<Response>,
	origin: string,
): typeof fetch {
	return (input, init) => {
		const url = new URL(
			typeof input === "string"
				? input
				: input instanceof URL
					? input.toString()
					: input.url,
		);
		if (url.origin === origin) {
			return signing(url.pathname + url.search, init);
		}
		return fetch(input, init);
	};
}

/** Open a URL in the platform browser, best-effort; never throws. */
function openBrowser(url: string): void {
	const [cmd, args] =
		process.platform === "darwin"
			? ["open", [url]]
			: process.platform === "win32"
				? ["cmd", ["/c", "start", "", url]]
				: ["xdg-open", [url]];
	try {
		spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
	} catch {
		// The URL is printed either way; opening is a convenience.
	}
}

export async function oauthSignIn(options: {
	handle: string;
	targetOrigin: string;
	log?: (message: string) => void;
}): Promise<OAuthOperator> {
	const log = options.log ?? (() => {});

	// An ephemeral callback server; the OS picks the port, which then
	// becomes part of the loopback client's registration.
	let resolveParams!: (params: URLSearchParams) => void;
	let rejectParams!: (err: Error) => void;
	const paramsPromise = new Promise<URLSearchParams>((resolve, reject) => {
		resolveParams = resolve;
		rejectParams = reject;
	});
	const server = createServer((req, res) => {
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		if (url.pathname !== "/callback") {
			res.writeHead(404).end();
			return;
		}
		res
			.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
			.end(
				"<!doctype html><meta charset=utf-8><title>space-conformance</title>" +
					"<p style='font:16px system-ui;margin:3em'>Signed in — you can close this tab and return to the terminal.</p>",
			);
		resolveParams(url.searchParams);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (address === null || typeof address !== "object") {
		server.close();
		throw new Error("could not bind the OAuth callback server");
	}
	const redirectUri = `http://127.0.0.1:${address.port}/callback`;

	const timer = setTimeout(() => {
		rejectParams(
			new Error(
				`timed out after ${CALLBACK_TIMEOUT_MS / 60000} minutes waiting for the browser sign-in`,
			),
		);
	}, CALLBACK_TIMEOUT_MS);

	try {
		// A loopback client: the client_id itself carries the registration.
		// One-shot in-memory stores — the session lives and dies with this
		// process, which is the point of a conformance run.
		const clientId = `http://localhost?${new URLSearchParams({
			redirect_uri: redirectUri,
			scope: OAUTH_SCOPE,
		}).toString()}`;
		const stateStore = new Map<string, NodeSavedState>();
		const sessionStore = new Map<string, NodeSavedSession>();
		const client = new NodeOAuthClient({
			clientMetadata: {
				client_id: clientId,
				redirect_uris: [redirectUri as `http://127.0.0.1:${string}`],
				scope: OAUTH_SCOPE,
				token_endpoint_auth_method: "none",
				grant_types: ["authorization_code", "refresh_token"],
				response_types: ["code"],
				dpop_bound_access_tokens: true,
			},
			stateStore: {
				set: async (key, value) => void stateStore.set(key, value),
				get: async (key) => stateStore.get(key),
				del: async (key) => void stateStore.delete(key),
			},
			sessionStore: {
				set: async (key, value) => void sessionStore.set(key, value),
				get: async (key) => sessionStore.get(key),
				del: async (key) => void sessionStore.delete(key),
			},
			// Local dev targets (wrangler dev, the reference harness) are http.
			allowHttp: options.targetOrigin.startsWith("http://"),
		});

		const authorizeUrl = await client.authorize(options.handle, {
			scope: OAUTH_SCOPE,
		});
		log(`Opening browser to authorize ${options.handle}…`);
		log(`If it does not open, visit:\n  ${authorizeUrl.toString()}`);
		openBrowser(authorizeUrl.toString());

		const params = await paramsPromise;
		const { session } = await client.callback(params);
		log(`Signed in as ${session.did}`);
		return {
			did: session.did,
			fetch: originGatedFetch(
				(pathname, init) => session.fetchHandler(pathname, init),
				options.targetOrigin,
			),
			signOut: () => sessionSignOut(session),
		};
	} finally {
		clearTimeout(timer);
		server.close();
	}
}

async function sessionSignOut(session: OAuthSession): Promise<void> {
	try {
		await session.signOut();
	} catch {
		// Best-effort: the tokens die with the process either way.
	}
}
