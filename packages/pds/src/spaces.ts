/**
 * Atproto spaces (alpha) — PDS integration.
 *
 * The engine lives in @getcirrus/spaces; this module supplies the
 * account-specific pieces: the concrete Durable Object classes, the host
 * adapter (operator identity, DID resolution, session auth, record
 * validation), and the user's-PDS role endpoints (getDelegationToken,
 * listSpaces). Everything mounts behind the SPACES_ENABLED flag.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import { Secp256k1Keypair, verifySignature } from "@atproto/crypto";
import { createSpaceToken, spaceHostAud } from "@atproto/space";
import {
	SpaceDurableObject as EngineSpaceDurableObject,
	SpaceIndexDurableObject as EngineSpaceIndexDurableObject,
	createSpaceRoutes,
	requireSpaceUri,
	parseSpaceErrorCode,
	spaceErrorStatus,
} from "@getcirrus/spaces";
import type {
	SpaceHostConfig,
	SpaceRoutesHost,
	SpaceScopeMatch,
	SpaceSessionAuth,
	SpaceStub,
	SpaceIndexStub,
} from "@getcirrus/spaces";
import { permissionsFor } from "@getcirrus/oauth-provider";
import { getProvider } from "./oauth.js";
import { verifyAccessToken, TokenExpiredError } from "./session.js";
import { InvalidRecordError, validator } from "./validation.js";
import type { DidResolver } from "./did-resolver.js";
import type { PDSEnv } from "./types.js";

/**
 * The account's space DO: host identity comes from the PDS environment.
 * This is the only place `env.DID` crosses into the engine.
 */
export class SpaceDurableObject extends EngineSpaceDurableObject<PDSEnv> {
	private keypairPromise: Promise<Secp256k1Keypair> | null = null;

	protected getHostConfig(): SpaceHostConfig {
		return {
			operatorDid: this.env.DID,
			getKeypair: () => {
				this.keypairPromise ??= Secp256k1Keypair.import(this.env.SIGNING_KEY);
				return this.keypairPromise;
			},
		};
	}
}

export class SpaceIndexDurableObject extends EngineSpaceIndexDurableObject<PDSEnv> {}

export interface SpacesAppDeps {
	env: PDSEnv;
	didResolver: DidResolver;
	getKeypair: () => Promise<Secp256k1Keypair>;
}

/** Data-location-aware stub creation, matching getAccountDO's handling. */
export function getSpaceDO(env: PDSEnv, uri: string): SpaceStub {
	return locatedStub(env, env.SPACES!, uri);
}

export function getSpaceIndexDO(env: PDSEnv): SpaceIndexStub {
	return locatedStub(env, env.SPACES_INDEX!, "spaces");
}

function locatedStub<T extends Rpc.DurableObjectBranded | undefined>(
	env: PDSEnv,
	namespace: DurableObjectNamespace<T>,
	name: string,
): DurableObjectStub<T> {
	const location = env.DATA_LOCATION;
	// "eu" is a jurisdiction (hard guarantee) — space data must not end up
	// in a different jurisdiction from the account. Everything else is a
	// best-effort hint.
	if (location === "eu") {
		const jurisdiction = namespace.jurisdiction("eu");
		return jurisdiction.get(jurisdiction.idFromName(name));
	}
	const id = namespace.idFromName(name);
	if (location && location !== "auto") {
		return namespace.get(id, { locationHint: location });
	}
	return namespace.get(id);
}

const SESSION_KID_ALLOWED = new Set(["#atproto", "#atproto_space"]);

/**
 * Build the host adapter and the complete spaces Hono app: the engine's
 * space/simplespace routes plus the PDS-level getDelegationToken and
 * listSpaces.
 */
export function createSpacesApp(deps: SpacesAppDeps): Hono {
	const { env, didResolver, getKeypair } = deps;
	if (!env.SPACES || !env.SPACES_INDEX) {
		throw new Error(
			"SPACES_ENABLED is set but the SPACES / SPACES_INDEX Durable Object bindings are missing. Add them to wrangler.jsonc (migration v2).",
		);
	}

	/**
	 * Resolve a DID's signing key to a did:key string, honouring the
	 * requested kid with the proposal's #atproto_space → #atproto fallback.
	 */
	async function getSigningKey(
		iss: string,
		kid: string | undefined,
		forceRefresh: boolean,
	): Promise<string> {
		if (kid && !SESSION_KID_ALLOWED.has(kid)) {
			throw new Error(`Unsupported signing key id: ${kid}`);
		}
		const doc = await didResolver.resolve(iss, { forceRefresh });
		if (!doc) throw new Error(`Could not resolve DID: ${iss}`);
		const methods = (doc.verificationMethod ?? []) as Array<{
			id: string;
			publicKeyMultibase?: string;
		}>;
		const find = (fragment: string) =>
			methods.find((m) => m.id === fragment || m.id.endsWith(fragment));
		const method =
			(kid ? find(kid) : undefined) ?? find("#atproto");
		if (!method?.publicKeyMultibase) {
			throw new Error(`No signing key in DID document for ${iss}`);
		}
		return `did:key:${method.publicKeyMultibase}`;
	}

	/** Resolve a `did[#fragment]` service identifier to its endpoint. */
	async function resolveServiceEndpoint(
		service: string,
	): Promise<string | null> {
		const [did, fragment] = service.split("#") as [string, string?];
		const doc = await didResolver.resolve(did);
		if (!doc) return null;
		const services = (doc.service ?? []) as Array<{
			id: string;
			serviceEndpoint: unknown;
		}>;
		const entry = fragment
			? services.find(
					(s) => s.id === `#${fragment}` || s.id.endsWith(`#${fragment}`),
				)
			: services.find(
					(s) => s.id === "#atproto_pds" || s.id.endsWith("#atproto_pds"),
				);
		return typeof entry?.serviceEndpoint === "string"
			? entry.serviceEndpoint
			: null;
	}

	/**
	 * A space authority's host endpoint: the dedicated #atproto_space_host
	 * entry when published, falling back to #atproto_pds.
	 */
	async function resolveAuthorityEndpoint(did: string): Promise<string | null> {
		return (
			(await resolveServiceEndpoint(`${did}#atproto_space_host`)) ??
			(await resolveServiceEndpoint(did))
		);
	}

	/**
	 * Verify an inbound service-auth JWT from a foreign issuer (notifyWrite
	 * and notifySpaceDeleted): ES256K signature against the issuer's
	 * #atproto key, expiry, and the lxm method binding. Resolution failures
	 * surface as auth errors, never 500s.
	 */
	async function verifyForeignServiceJwt(
		token: string,
		lxm: string,
	): Promise<{ iss: string; aud: string }> {
		const parts = token.split(".");
		if (parts.length !== 3) throw new Error("Malformed service JWT");
		const decode = (part: string) =>
			JSON.parse(
				atob(part.replace(/-/g, "+").replace(/_/g, "/")),
			) as Record<string, unknown>;
		const payload = decode(parts[1]!);
		const iss = payload.iss;
		const aud = payload.aud;
		if (typeof iss !== "string" || typeof aud !== "string") {
			throw new Error("Service JWT missing iss or aud");
		}
		if (payload.lxm !== lxm) {
			throw new Error(`Service JWT not bound to ${lxm}`);
		}
		if (
			typeof payload.exp !== "number" ||
			payload.exp < Math.floor(Date.now() / 1000) - 5
		) {
			throw new Error("Service JWT expired");
		}
		const signingInput = new TextEncoder().encode(
			`${parts[0]}.${parts[1]}`,
		);
		const sigB64 = parts[2]!.replace(/-/g, "+").replace(/_/g, "/");
		const sig = Uint8Array.from(atob(sigB64), (ch) => ch.charCodeAt(0));
		const verifyWith = async (forceRefresh: boolean) =>
			verifySignature(
				await getSigningKey(iss, undefined, forceRefresh),
				signingInput,
				sig,
			);
		// Forced refresh on failure survives key rotation.
		if (!(await verifyWith(false)) && !(await verifyWith(true))) {
			throw new Error("Invalid service JWT signature");
		}
		return { iss, aud };
	}

	/**
	 * Session authentication for space routes. Accepts OAuth tokens
	 * carrying space: grants and the operator's own full-access sessions
	 * (AUTH_TOKEN, password and passkey sessions). App passwords are
	 * excluded in the alpha; service JWTs never reach spaces.
	 */
	async function authenticate(
		c: Context,
	): Promise<SpaceSessionAuth | Response> {
		const auth = c.req.header("Authorization");
		if (!auth) {
			return c.json(
				{ error: "AuthMissing", message: "Authorization header required" },
				401,
			);
		}

		if (auth.startsWith("DPoP ")) {
			const provider = getProvider(env);
			const tokenData = await provider.verifyAccessToken(c.req.raw);
			if (!tokenData) {
				return c.json(
					{
						error: "AuthenticationRequired",
						message: "Invalid OAuth access token",
					},
					401,
				);
			}
			const perms = permissionsFor(tokenData.scope);
			return {
				did: tokenData.sub,
				fullTrust: false,
				allowsSpace: (match: SpaceScopeMatch) =>
					perms.allowsSpace(match as never),
			};
		}

		if (!auth.startsWith("Bearer ")) {
			return c.json(
				{ error: "AuthMissing", message: "Invalid authorization scheme" },
				401,
			);
		}
		const token = auth.slice(7);

		if (token === env.AUTH_TOKEN) {
			return { did: env.DID, fullTrust: true, allowsSpace: () => true };
		}

		try {
			const payload = await verifyAccessToken(
				token,
				env.JWT_SECRET,
				`did:web:${env.PDS_HOSTNAME}`,
			);
			if (payload.sub !== env.DID) {
				return c.json(
					{
						error: "AuthenticationRequired",
						message: "Invalid access token",
					},
					401,
				);
			}
			if (payload.apf === true) {
				// App passwords are a deprecated credential class; there is no
				// reason to widen their reach into a new data model.
				return c.json(
					{
						error: "AuthenticationRequired",
						message: "App passwords cannot access atproto spaces",
					},
					403,
				);
			}
			return { did: env.DID, fullTrust: true, allowsSpace: () => true };
		} catch (err) {
			if (err instanceof TokenExpiredError) {
				return c.json({ error: "ExpiredToken", message: err.message }, 400);
			}
		}

		return c.json(
			{
				error: "AuthenticationRequired",
				message: "Invalid authentication token",
			},
			401,
		);
	}

	const host: SpaceRoutesHost = {
		operatorDid: env.DID,
		publicOrigin: `https://${env.PDS_HOSTNAME}`,
		blobs: env.BLOBS,
		getKeypair,
		getSigningKey,
		resolveServiceEndpoint,
		resolveAuthorityEndpoint,
		verifyServiceJwt: verifyForeignServiceJwt,
		authenticate,
		validateRecord: ({ collection, record, rkey, validate }) => {
			const result = validator.validate({ collection, record, rkey, validate });
			return { record: result.record, status: result.status };
		},
		getSpaceDO: (uri) => getSpaceDO(env, uri),
		getIndexDO: () => getSpaceIndexDO(env),
	};

	const app = createSpaceRoutes(host);

	// ------------------------------------------------------------------
	// User's-PDS role: delegation minting and the space index
	// ------------------------------------------------------------------

	app.get("/xrpc/com.atproto.space.getDelegationToken", async (c) => {
		try {
			const ref = requireSpaceUri(c.req.query("space"));
			const session = await authenticate(c);
			if (session instanceof Response) return session;
			if (!session.fullTrust) {
				// `read` (not read_self) is what getDelegationToken requires:
				// the token unlocks reading other members' repos elsewhere.
				const allowed = session.allowsSpace({
					type: ref.type,
					authority: ref.authority,
					skey: ref.skey,
					action: "read",
				});
				if (!allowed) {
					return c.json(
						{
							error: "InsufficientScope",
							message: "Token does not cover reading this space",
						},
						403,
					);
				}
			}
			const keypair = await getKeypair();
			const token = await createSpaceToken(
				"delegation",
				{
					iss: env.DID,
					sub: ref.uri,
					aud: spaceHostAud(ref.authority),
				},
				keypair,
			);
			return c.json({ token });
		} catch (err) {
			return spacesErrorResponse(c, err);
		}
	});

	app.get("/xrpc/com.atproto.space.listSpaces", async (c) => {
		try {
			const session = await authenticate(c);
			if (session instanceof Response) return session;
			const type = c.req.query("type");
			const authority = c.req.query("did");
			if (!session.fullTrust) {
				// An unfiltered listing needs a wildcard grant.
				const allowed = session.allowsSpace({
					type: type ?? "*",
					authority: authority ?? "*",
					skey: "*",
					action: "read_self",
				});
				if (!allowed) {
					return c.json(
						{
							error: "InsufficientScope",
							message: "Token does not cover listing these spaces",
						},
						403,
					);
				}
			}
			const limitRaw = c.req.query("limit");
			const limit = Math.min(
				Math.max(limitRaw ? Number.parseInt(limitRaw, 10) || 50 : 50, 1),
				100,
			);
			const index = getSpaceIndexDO(env);
			const page = await index.rpcList({
				type,
				authority,
				state: "active",
				limit,
				afterUri: c.req.query("cursor"),
			});
			const last = page.spaces[page.spaces.length - 1];
			return c.json({
				spaces: page.spaces.map((space) => ({ uri: space.uri })),
				...(page.hasMore && last ? { cursor: last.uri } : {}),
			});
		} catch (err) {
			return spacesErrorResponse(c, err);
		}
	});

	return app;
}

function spacesErrorResponse(c: Context, err: unknown): Response {
	if (err instanceof InvalidRecordError) {
		return c.json({ error: "InvalidRecord", message: err.message }, 400);
	}
	const parsed = parseSpaceErrorCode(err);
	if (parsed) {
		return c.json(
			{ error: parsed.code, message: parsed.message },
			spaceErrorStatus(parsed.code) as 400,
		);
	}
	throw err;
}
