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

/**
 * The extra grant the spaces conformance run signs in with: every space
 * action on any collection plus create/update/delete management, scoped to
 * the probe space type. `authority=*` because the suite deliberately
 * addresses spaces the user does not own (NotSpaceOwner refusals); with the
 * default `self` those would be scope refusals before the host's own check
 * is reached. A PDS without the spaces alpha rejects the unknown scope at
 * sign-in, which is the right failure — the suite is meaningless there.
 * Keep in sync with the CLI's OAUTH_SCOPE and the worker's registration.
 */
const SPACE_SCOPE =
	"space:earth.cirrus.check.space?authority=*&collection=*&manage=create&manage=update&manage=delete";
export const SPACES_SCOPE = `${SCOPE} ${SPACE_SCOPE}`;

const CALLBACK_PATH = "/oauth/callback";

const isLoopback =
	location.hostname === "localhost" || location.hostname === "127.0.0.1";

const REDIRECT_URI = `${location.origin}${CALLBACK_PATH}`;

const CLIENT_ID = isLoopback
	? `http://localhost?${new URLSearchParams({
			redirect_uri: REDIRECT_URI,
			// The loopback registration is the client_id itself, so it must
			// carry the superset of every scope a flow may request.
			scope: SPACES_SCOPE,
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

export async function startLogin(
	identifier: string,
	scope: string = SCOPE,
): Promise<never> {
	const url = await createAuthorizationUrl({
		target: { type: "account", identifier: identifier as ActorIdentifier },
		scope,
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
