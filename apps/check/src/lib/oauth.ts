import type { ActorIdentifier, Did } from "@atcute/lexicons";
import {
	configureOAuth,
	createAuthorizationUrl,
	deleteStoredSession,
	finalizeAuthorization,
	getSession,
	listStoredSessions,
	OAuthUserAgent,
	type Session,
} from "@atcute/oauth-browser-client";
import { createSignal } from "solid-js";
import { actorResolver } from "./resolvers";

const SCOPE = "atproto transition:generic";
const CALLBACK_PATH = "/oauth/callback";

const isLoopback =
	location.hostname === "localhost" || location.hostname === "127.0.0.1";

const REDIRECT_URI = `${location.origin}${CALLBACK_PATH}`;

const CLIENT_ID = isLoopback
	? `http://localhost?${new URLSearchParams({
			redirect_uri: REDIRECT_URI,
			scope: SCOPE,
		}).toString()}`
	: `${location.origin}/client-metadata.json`;

configureOAuth({
	metadata: { client_id: CLIENT_ID, redirect_uri: REDIRECT_URI },
	identityResolver: actorResolver,
});

const [currentDid, setCurrentDid] = createSignal<Did | null>(
	listStoredSessions()[0] ?? null,
);

export const signedInDid = currentDid;

export async function startLogin(identifier: string): Promise<never> {
	const url = await createAuthorizationUrl({
		target: { type: "account", identifier: identifier as ActorIdentifier },
		scope: SCOPE,
	});
	location.assign(url.toString());
	throw new Error("redirecting");
}

export function isCallbackPath(pathname = location.pathname): boolean {
	return pathname === CALLBACK_PATH;
}

export async function completeCallback(): Promise<Session> {
	const params = new URLSearchParams(
		location.hash.startsWith("#") ? location.hash.slice(1) : location.search,
	);
	const { session } = await finalizeAuthorization(params);
	setCurrentDid(session.info.sub);
	return session;
}

export async function getAgent(): Promise<OAuthUserAgent | null> {
	const did = currentDid();
	if (!did) return null;
	try {
		const session = await getSession(did);
		return new OAuthUserAgent(session);
	} catch {
		deleteStoredSession(did);
		setCurrentDid(null);
		return null;
	}
}

export async function signOut(): Promise<void> {
	const agent = await getAgent();
	if (agent) {
		try {
			await agent.signOut();
		} catch {
			// best-effort
		}
	}
	const did = currentDid();
	if (did) deleteStoredSession(did);
	setCurrentDid(null);
}
