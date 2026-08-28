/**
 * Hono route factory for `com.atproto.space.*` and
 * `com.atproto.simplespace.*`.
 *
 * The factory is host-agnostic: everything account-specific — session
 * authentication, DID resolution, record validation, the operator identity
 * — arrives through {@link SpaceRoutesHost}. The host mounts the returned
 * app behind its feature flag.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import { createSpaceToken, serializeRepo, spaceHostAud } from "@atproto/space";
import type { SerializedRecord } from "@atproto/space";
import type { Keypair } from "@atproto/crypto";
import { fromBase64, parseCid } from "@atproto/lex-data";
import { now as tidNow } from "@atcute/tid";
import {
	isSpaceCredentialAuth,
	verifyDelegationAuth,
	verifySpaceCredentialAuth,
	type CheckReplay,
	type GetSigningKey,
} from "./auth.js";
import { verifyClientAttestation } from "./attestation.js";
import { bytesToJson, commitToJson, signCommit } from "./commit.js";
import { SpaceError, parseSpaceErrorCode, spaceErrorStatus } from "./errors.js";
import { prepareRecord, recordBytesToJson } from "./records.js";
import { createServiceJwt } from "./service-jwt.js";
import { spaceBlobPrefix, spaceBlobKey, stagedBlobKey } from "./blob-keys.js";
import { requireSpaceUri, spaceId, spaceRecordUri } from "./space-uri.js";
import type { SpaceRef } from "./space-uri.js";
import type { SpaceDurableObject } from "./space-do.js";
import type { SpaceIndexDurableObject } from "./index-do.js";
import type {
	NotifyItem,
	PreparedSpaceWrite,
	SpaceAppAccess,
	SpaceConfig,
	SpacePolicy,
} from "./types.js";

const NOTIFY_WRITE_LXM = "com.atproto.space.notifyWrite";
const SPACE_DELETED_LXM = "com.atproto.space.notifySpaceDeleted";
const CHECK_USER_ACCESS_LXM = "com.atproto.simplespace.checkUserAccess";
/** A managing app that doesn't answer within this window denies access. */
const CHECK_USER_ACCESS_TIMEOUT_MS = 5000;

export type SpaceStub = DurableObjectStub<SpaceDurableObject>;
export type SpaceIndexStub = DurableObjectStub<SpaceIndexDurableObject>;

/** The operation shapes checked against a session's `space:` grants. */
export type SpaceScopeMatch = { type: string; authority: string; skey: string } & (
	| { action: "read" | "read_self" }
	| { action: "create" | "update" | "delete"; collection: string }
	| { manage: "create" | "update" | "delete" }
);

/**
 * A host session (OAuth token with `space:` grants, or a fully-trusted
 * operator session). App passwords are excluded in the alpha — the host's
 * authenticate() must not produce one of these for them.
 */
export interface SpaceSessionAuth {
	did: string;
	/** Fully-trusted operator session: skips scope checks. */
	fullTrust: boolean;
	allowsSpace(match: SpaceScopeMatch): boolean;
}

export interface SpaceRoutesHost {
	operatorDid: string;
	/** Public origin clients address, e.g. `https://pds.example.com`. */
	publicOrigin: string;
	/** R2 bucket for blobs; space blob endpoints 503 without it. */
	blobs?: R2Bucket;
	getKeypair(): Promise<Keypair>;
	/** DID-doc signing key resolution for foreign issuers. */
	getSigningKey: GetSigningKey;
	/**
	 * Resolve a service identifier (`did` or `did#fragment`) to an HTTPS
	 * endpoint, or null when unresolvable.
	 */
	resolveServiceEndpoint(service: string): Promise<string | null>;
	/**
	 * Resolve a space authority's host endpoint: try
	 * `#atproto_space_host`, fall back to `#atproto_pds`.
	 */
	resolveAuthorityEndpoint(did: string): Promise<string | null>;
	/** Verify an inbound service-auth JWT bound to `lxm`. */
	verifyServiceJwt(
		token: string,
		lxm: string,
	): Promise<{ iss: string; aud: string }>;
	/**
	 * Host session authentication (OAuth / operator sessions). Returns a
	 * Response for authentication failures.
	 */
	authenticate(c: Context): Promise<SpaceSessionAuth | Response>;
	/**
	 * Lexicon validation with the host's validator. Throws on invalid
	 * records; the thrown message is surfaced as an InvalidRecord error.
	 */
	validateRecord(input: {
		collection: string;
		record: unknown;
		rkey: string;
		validate?: boolean;
	}): { record: unknown; status?: "valid" | "unknown" };
	getSpaceDO(uri: string): SpaceStub;
	getIndexDO(): SpaceIndexStub;
	/** Fetch override for outbound calls (tests). */
	outboundFetch?: typeof fetch;
}

// ---------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------

function errorResponse(c: Context, err: unknown): Response {
	const parsed = parseSpaceErrorCode(err);
	if (parsed) {
		return c.json(
			{ error: parsed.code, message: parsed.message },
			spaceErrorStatus(parsed.code) as 400,
		);
	}
	throw err;
}

function waitUntil(c: Context, promise: Promise<unknown>): void {
	try {
		c.executionCtx.waitUntil(promise);
	} catch {
		// No execution context (tests): let it float.
		void promise.catch((err) => console.warn("background task failed", err));
	}
}

function replayChecker(stub: SpaceStub): CheckReplay {
	return (kind, key, expiresAtSec) => stub.rpcCheckReplay(kind, key, expiresAtSec);
}

interface AuthedRead {
	kind: "credential" | "session";
}

export function createSpaceRoutes(host: SpaceRoutesHost): Hono {
	const app = new Hono();
	const doFetch: typeof fetch = host.outboundFetch ?? fetch;

	/** The `repo` param on every repo-host method must be the operator DID. */
	function requireRepoParam(repo: unknown): void {
		if (repo !== host.operatorDid) {
			throw new SpaceError(
				"RepoNotFound",
				`Repository not found: ${String(repo)}`,
			);
		}
	}

	const verifyOpts = (c: Context, stub: SpaceStub) => ({
		htm: c.req.method,
		url: c.req.url,
		publicOrigin: host.publicOrigin,
		dpopProof: c.req.header("DPoP"),
		getSigningKey: host.getSigningKey,
		checkReplay: replayChecker(stub),
	});

	/**
	 * Authenticate a read: a space credential for the requested space, or a
	 * host session covering `read_self` on it. The `repo` param on every
	 * repo-host method must be the operator DID — anything else is
	 * RepoNotFound, deliberately indistinguishable from an absent repo.
	 */
	async function readAuth(
		c: Context,
		ref: SpaceRef,
		repo: string | undefined,
	): Promise<AuthedRead | Response> {
		if (repo !== host.operatorDid) {
			throw new SpaceError("RepoNotFound", `Repository not found: ${repo}`);
		}
		const authHeader = c.req.header("Authorization");
		if (isSpaceCredentialAuth(authHeader)) {
			const stub = host.getSpaceDO(ref.uri);
			await verifySpaceCredentialAuth(
				authHeader!.slice(5),
				ref,
				verifyOpts(c, stub),
			);
			return { kind: "credential" };
		}
		const session = await host.authenticate(c);
		if (session instanceof Response) return session;
		if (!session.fullTrust) {
			const allowed = session.allowsSpace({
				type: ref.type,
				authority: ref.authority,
				skey: ref.skey,
				action: "read_self",
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
		return { kind: "session" };
	}

	/** Session-only auth for writes and management. */
	async function sessionAuth(
		c: Context,
	): Promise<SpaceSessionAuth | Response> {
		return host.authenticate(c);
	}

	function assertScope(
		c: Context,
		session: SpaceSessionAuth,
		match: SpaceScopeMatch,
	): Response | null {
		if (session.fullTrust) return null;
		if (session.allowsSpace(match)) return null;
		return c.json(
			{
				error: "InsufficientScope",
				message: "Token does not cover this space operation",
			},
			403,
		);
	}

	/** The operator hosts this space, or SpaceNotFound. */
	function assertSpaceHost(ref: SpaceRef): void {
		if (ref.authority !== host.operatorDid) {
			throw new SpaceError("SpaceNotFound", `Space not found: ${ref.uri}`);
		}
	}

	/**
	 * The simplespace user-access policy, applied at credential mint and to
	 * inbound notifyWrite writers. The authority itself always passes; a
	 * managing app that errors or times out denies.
	 */
	async function authorizeUser(
		config: SpaceConfig,
		ref: SpaceRef,
		userDid: string,
		clientId: string | undefined,
		stub: SpaceStub,
	): Promise<boolean> {
		if (userDid === ref.authority) return true;
		switch (config.policy.kind) {
			case "public":
				return true;
			case "member-list":
				return stub.rpcIsMember(userDid);
			case "managing-app": {
				const managingApp = config.policy.managingApp;
				try {
					const endpoint = await host.resolveServiceEndpoint(managingApp);
					if (!endpoint) return false;
					const keypair = await host.getKeypair();
					const token = await createServiceJwt(
						{
							iss: host.operatorDid,
							aud: managingApp,
							lxm: CHECK_USER_ACCESS_LXM,
						},
						keypair,
					);
					const url = new URL(`${endpoint}/xrpc/${CHECK_USER_ACCESS_LXM}`);
					url.searchParams.set("space", ref.uri);
					url.searchParams.set("user", userDid);
					if (clientId) url.searchParams.set("clientId", clientId);
					const res = await doFetch(url.toString(), {
						headers: { Authorization: `Bearer ${token}` },
						signal: AbortSignal.timeout(CHECK_USER_ACCESS_TIMEOUT_MS),
					});
					if (!res.ok) return false;
					const body = (await res.json()) as { authorized?: unknown };
					return body.authorized === true;
				} catch {
					// No decision caching in the alpha; unreachable app denies.
					return false;
				}
			}
		}
	}

	/**
	 * Ensure the space DO exists for a write. First write into a foreign
	 * space registers it `pending` in the index, initialises the DO as
	 * repo-host, then activates the entry. Spaces under the operator's own
	 * authority must have been created via simplespace first.
	 */
	async function ensureSpaceForWrite(ref: SpaceRef, stub: SpaceStub): Promise<void> {
		const meta = await stub.rpcGetMeta();
		if (meta && !meta.deletedAt) return;
		if (ref.authority === host.operatorDid) {
			throw new SpaceError(
				"SpaceNotFound",
				`Space not found: ${ref.uri}. Create it with com.atproto.simplespace.createSpace.`,
			);
		}
		const index = host.getIndexDO();
		await index.rpcRegister({
			uri: ref.uri,
			authority: ref.authority,
			type: ref.type,
			skey: ref.skey,
			isAuthority: false,
		});
		await stub.rpcInit({
			uri: ref.uri,
			authority: ref.authority,
			type: ref.type,
			skey: ref.skey,
			isAuthority: false,
		});
		await index.rpcActivate(ref.uri);
	}

	/**
	 * Promote staged blobs to the space's R2 prefix. Runs before the DO
	 * commit so nothing reacting to the commit sees a 404. Idempotent per
	 * CID; CIDs that are neither staged nor at the destination are skipped.
	 */
	async function promoteSpaceBlobs(
		ref: SpaceRef,
		blobCids: string[],
	): Promise<void> {
		if (!host.blobs || blobCids.length === 0) return;
		const id = await spaceId(ref.uri);
		await Promise.all(
			blobCids.map(async (cid) => {
				const destKey = spaceBlobKey(host.operatorDid, id, cid);
				if (await host.blobs!.head(destKey)) return;
				const staged = await host.blobs!.get(
					stagedBlobKey(host.operatorDid, cid),
				);
				if (!staged) return;
				await host.blobs!.put(destKey, staged.body, {
					httpMetadata: staged.httpMetadata,
				});
			}),
		);
	}

	/**
	 * Step 8 of the write path: after the commit is applied, record the
	 * writer and fan out (own authority) or send one best-effort
	 * notifyWrite to the space's authority (foreign space).
	 */
	async function postWrite(
		ref: SpaceRef,
		stub: SpaceStub,
		rev: string,
		hash: Uint8Array,
	): Promise<void> {
		if (ref.authority === host.operatorDid) {
			await stub.rpcRecordWriter(host.operatorDid, rev, hash);
			const registrations = await stub.rpcGetActiveRegistrations();
			if (registrations.length === 0) return;
			const body = {
				space: ref.uri,
				repo: host.operatorDid,
				rev,
				hash: bytesToJson(hash),
			};
			const items: NotifyItem[] = registrations.map((registration) => ({
				service: registration.service,
				endpoint: registration.endpoint,
				lxm: NOTIFY_WRITE_LXM,
				body,
			}));
			await stub.rpcEnqueueNotify(items);
			return;
		}
		// One attempt, logged on failure: notifications are best-effort and
		// syncers self-heal, so a retry queue for the writer role is not
		// worth its complexity.
		try {
			const endpoint = await host.resolveAuthorityEndpoint(ref.authority);
			if (!endpoint) {
				console.warn(`notifyWrite: no endpoint for ${ref.authority}`);
				return;
			}
			const keypair = await host.getKeypair();
			const token = await createServiceJwt(
				{ iss: host.operatorDid, aud: ref.authority, lxm: NOTIFY_WRITE_LXM },
				keypair,
			);
			const res = await doFetch(`${endpoint}/xrpc/${NOTIFY_WRITE_LXM}`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${token}`,
				},
				body: JSON.stringify({
					space: ref.uri,
					repo: host.operatorDid,
					rev,
					hash: bytesToJson(hash),
				}),
			});
			if (!res.ok) {
				console.warn(
					`notifyWrite to ${ref.authority} failed: ${res.status}`,
				);
			}
		} catch (err) {
			console.warn(`notifyWrite to ${ref.authority} errored:`, err);
		}
	}

	interface WriteInput {
		action: "create" | "update" | "delete";
		collection: string;
		rkey?: string;
		value?: unknown;
	}

	/**
	 * Common write pipeline for createRecord/putRecord/deleteRecord and
	 * applyWrites: validate, prepare bytes and CIDs, promote blobs, ensure
	 * the space DO, apply the batch, notify in the background.
	 */
	async function runWrites(
		c: Context,
		ref: SpaceRef,
		session: SpaceSessionAuth,
		writes: WriteInput[],
		validate: boolean | undefined,
	): Promise<
		| Response
		| {
				rev: string;
				results: Array<{
					action: string;
					collection: string;
					rkey: string;
					cid: string | null;
					validationStatus?: string;
				}>;
		  }
	> {
		const prepared: PreparedSpaceWrite[] = [];
		const statuses: Array<string | undefined> = [];
		const blobCids = new Set<string>();

		for (const write of writes) {
			const scopeError = assertScope(c, session, {
				type: ref.type,
				authority: ref.authority,
				skey: ref.skey,
				action: write.action,
				collection: write.collection,
			});
			if (scopeError) return scopeError;

			if (write.action === "delete") {
				prepared.push({
					action: "delete",
					collection: write.collection,
					rkey: write.rkey!,
				});
				statuses.push(undefined);
				continue;
			}

			const rkey = write.rkey ?? tidNow();
			let validated;
			try {
				validated = host.validateRecord({
					collection: write.collection,
					record: write.value,
					rkey,
					validate,
				});
			} catch (err) {
				return c.json(
					{
						error: "InvalidRecord",
						message: err instanceof Error ? err.message : String(err),
					},
					400,
				);
			}
			const preparedRecord = await prepareRecord(validated.record);
			for (const cid of preparedRecord.blobCids) blobCids.add(cid);
			prepared.push({
				action: write.action,
				collection: write.collection,
				rkey,
				cid: preparedRecord.cid,
				bytes: preparedRecord.bytes,
				blobCids: preparedRecord.blobCids,
			});
			statuses.push(validated.status);
		}

		// The copy completes before the DO commit is applied, so a relay or
		// syncer reacting to the commit never sees a 404.
		await promoteSpaceBlobs(ref, Array.from(blobCids));

		const stub = host.getSpaceDO(ref.uri);
		await ensureSpaceForWrite(ref, stub);
		const result = await stub.rpcApplyWrites(prepared);

		waitUntil(c, postWrite(ref, stub, result.rev, result.hash));

		return {
			rev: result.rev,
			results: result.results.map((r, i) => ({
				...r,
				...(statuses[i] !== undefined
					? { validationStatus: statuses[i] }
					: {}),
			})),
		};
	}

	// ---------------------------------------------------------------
	// Write endpoints (repo host, session auth)
	// ---------------------------------------------------------------

	app.post("/xrpc/com.atproto.space.createRecord", async (c) => {
		try {
			const body = await c.req.json<{
				space?: string;
				repo?: string;
				collection?: string;
				rkey?: string;
				validate?: boolean;
				record?: unknown;
			}>();
			const ref = requireSpaceUri(body.space);
			requireRepoParam(body.repo);
			requireString(body.collection, "collection");
			const session = await sessionAuth(c);
			if (session instanceof Response) return session;
			const result = await runWrites(
				c,
				ref,
				session,
				[
					{
						action: "create",
						collection: body.collection!,
						rkey: body.rkey,
						value: body.record,
					},
				],
				body.validate,
			);
			if (result instanceof Response) return result;
			const write = result.results[0]!;
			return c.json({
				uri: spaceRecordUri(
					ref.uri,
					host.operatorDid,
					write.collection,
					write.rkey,
				),
				cid: write.cid,
				...(write.validationStatus
					? { validationStatus: write.validationStatus }
					: {}),
			});
		} catch (err) {
			return errorResponse(c, err);
		}
	});

	app.post("/xrpc/com.atproto.space.putRecord", async (c) => {
		try {
			const body = await c.req.json<{
				space?: string;
				repo?: string;
				collection?: string;
				rkey?: string;
				validate?: boolean;
				record?: unknown;
			}>();
			const ref = requireSpaceUri(body.space);
			requireRepoParam(body.repo);
			requireString(body.collection, "collection");
			requireString(body.rkey, "rkey");
			const session = await sessionAuth(c);
			if (session instanceof Response) return session;

			// Upsert: the scope asserted is the operation actually performed.
			const stub = host.getSpaceDO(ref.uri);
			const meta = await stub.rpcGetMeta();
			const exists =
				meta && !meta.deletedAt
					? (await stub.rpcGetRecord(body.collection!, body.rkey!)) !== null
					: false;

			const result = await runWrites(
				c,
				ref,
				session,
				[
					{
						action: exists ? "update" : "create",
						collection: body.collection!,
						rkey: body.rkey,
						value: body.record,
					},
				],
				body.validate,
			);
			if (result instanceof Response) return result;
			const write = result.results[0]!;
			return c.json({
				uri: spaceRecordUri(
					ref.uri,
					host.operatorDid,
					write.collection,
					write.rkey,
				),
				cid: write.cid,
				...(write.validationStatus
					? { validationStatus: write.validationStatus }
					: {}),
			});
		} catch (err) {
			return errorResponse(c, err);
		}
	});

	app.post("/xrpc/com.atproto.space.deleteRecord", async (c) => {
		try {
			const body = await c.req.json<{
				space?: string;
				repo?: string;
				collection?: string;
				rkey?: string;
			}>();
			const ref = requireSpaceUri(body.space);
			requireRepoParam(body.repo);
			requireString(body.collection, "collection");
			requireString(body.rkey, "rkey");
			const session = await sessionAuth(c);
			if (session instanceof Response) return session;
			const result = await runWrites(
				c,
				ref,
				session,
				[
					{
						action: "delete",
						collection: body.collection!,
						rkey: body.rkey,
					},
				],
				undefined,
			);
			if (result instanceof Response) return result;
			return c.json({});
		} catch (err) {
			// Deleting an absent record succeeds: nothing committed, nothing
			// notified.
			if (parseSpaceErrorCode(err)?.code === "RecordNotFound") {
				return c.json({});
			}
			return errorResponse(c, err);
		}
	});

	app.post("/xrpc/com.atproto.space.applyWrites", async (c) => {
		try {
			const body = await c.req.json<{
				space?: string;
				repo?: string;
				validate?: boolean;
				writes?: Array<{
					$type?: string;
					collection?: string;
					rkey?: string;
					value?: unknown;
				}>;
			}>();
			const ref = requireSpaceUri(body.space);
			requireRepoParam(body.repo);
			if (!Array.isArray(body.writes)) {
				throw new SpaceError("InvalidRequest", "writes must be an array");
			}
			if (body.writes.length > 200) {
				throw new SpaceError("InvalidRequest", "Too many writes. Max: 200");
			}
			const session = await sessionAuth(c);
			if (session instanceof Response) return session;

			const inputs: WriteInput[] = body.writes.map((write, i) => {
				const action =
					write.$type === "com.atproto.space.applyWrites#create"
						? ("create" as const)
						: write.$type === "com.atproto.space.applyWrites#update"
							? ("update" as const)
							: write.$type === "com.atproto.space.applyWrites#delete"
								? ("delete" as const)
								: null;
				if (!action || !write.collection) {
					throw new SpaceError(
						"InvalidRequest",
						`Write ${i}: unknown $type or missing collection`,
					);
				}
				if (action !== "create" && !write.rkey) {
					throw new SpaceError(
						"InvalidRequest",
						`Write ${i}: ${action} requires rkey`,
					);
				}
				return {
					action,
					collection: write.collection,
					rkey: write.rkey,
					value: write.value,
				};
			});

			const result = await runWrites(c, ref, session, inputs, body.validate);
			if (result instanceof Response) return result;
			return c.json({
				results: result.results.map((write) => {
					if (write.action === "delete") {
						return { $type: "com.atproto.space.applyWrites#deleteResult" };
					}
					return {
						$type: `com.atproto.space.applyWrites#${write.action}Result`,
						uri: spaceRecordUri(
							ref.uri,
							host.operatorDid,
							write.collection,
							write.rkey,
						),
						cid: write.cid,
						...(write.validationStatus
							? { validationStatus: write.validationStatus }
							: {}),
					};
				}),
			});
		} catch (err) {
			return errorResponse(c, err);
		}
	});

	// ---------------------------------------------------------------
	// Read and sync endpoints (credential or session auth)
	// ---------------------------------------------------------------

	app.get("/xrpc/com.atproto.space.getRecord", async (c) => {
		try {
			const ref = requireSpaceUri(c.req.query("space"));
			const auth = await readAuth(c, ref, c.req.query("repo"));
			if (auth instanceof Response) return auth;
			const collection = c.req.query("collection");
			const rkey = c.req.query("rkey");
			requireString(collection, "collection");
			requireString(rkey, "rkey");

			const stub = host.getSpaceDO(ref.uri);
			await requireRepoExists(stub, ref);
			const record = await stub.rpcGetRecord(collection!, rkey!);
			const uri = spaceRecordUri(ref.uri, host.operatorDid, collection!, rkey!);
			if (!record) {
				throw new SpaceError(
					"RecordNotFound",
					`Could not locate record: ${uri}`,
				);
			}
			return c.json({
				uri,
				cid: record.cid,
				value: recordBytesToJson(record.bytes),
			});
		} catch (err) {
			return errorResponse(c, err);
		}
	});

	app.get("/xrpc/com.atproto.space.listRecords", async (c) => {
		try {
			const ref = requireSpaceUri(c.req.query("space"));
			const auth = await readAuth(c, ref, c.req.query("repo"));
			if (auth instanceof Response) return auth;
			const collection = c.req.query("collection");
			const limit = clampLimit(c.req.query("limit"), 50, 1000);
			const reverse = c.req.query("reverse") === "true";
			const excludeValues = c.req.query("excludeValues") === "true";
			const after = parseRecordCursor(c.req.query("cursor"));

			const stub = host.getSpaceDO(ref.uri);
			await requireRepoExists(stub, ref);
			const page = await stub.rpcListRecords({
				collection,
				limit,
				after,
				reverse,
				excludeValues,
			});
			const records = page.records.map((record) => ({
				collection: record.collection,
				rkey: record.rkey,
				cid: record.cid,
				...(record.bytes
					? { value: recordBytesToJson(new Uint8Array(record.bytes)) }
					: {}),
			}));
			const last = page.records[page.records.length - 1];
			return c.json({
				records,
				...(page.hasMore && last
					? { cursor: `${last.collection}/${last.rkey}` }
					: {}),
			});
		} catch (err) {
			return errorResponse(c, err);
		}
	});

	app.get("/xrpc/com.atproto.space.getLatestCommit", async (c) => {
		try {
			const ref = requireSpaceUri(c.req.query("space"));
			const auth = await readAuth(c, ref, c.req.query("repo"));
			if (auth instanceof Response) return auth;
			const stub = host.getSpaceDO(ref.uri);
			await requireRepoExists(stub, ref);
			const state = await stub.rpcGetRepoState();
			if (!state) {
				throw new SpaceError(
					"RepoNotFound",
					`Could not find repo for space: ${ref.uri}`,
				);
			}
			const keypair = await host.getKeypair();
			const commit = await signCommit(
				{
					spaceUri: ref.uri,
					author: host.operatorDid,
					state: {
						setHash: new Uint8Array(state.setHash),
						rev: state.rev,
					},
				},
				keypair,
			);
			return c.json({ commit: commitToJson(commit) });
		} catch (err) {
			return errorResponse(c, err);
		}
	});

	app.get("/xrpc/com.atproto.space.listRepoOps", async (c) => {
		try {
			const ref = requireSpaceUri(c.req.query("space"));
			const auth = await readAuth(c, ref, c.req.query("repo"));
			if (auth instanceof Response) return auth;
			const limit = clampLimit(c.req.query("limit"), 100, 1000);
			const since = c.req.query("since");
			const excludeValues = c.req.query("excludeValues") === "true";
			const after = parseOpsCursor(c.req.query("cursor"));

			const stub = host.getSpaceDO(ref.uri);
			await requireRepoExists(stub, ref);
			const page = await stub.rpcListRepoOps({
				since,
				after,
				limit,
				excludeValues,
			});
			const ops = page.ops.map((op) => ({
				rev: op.rev,
				collection: op.collection,
				rkey: op.rkey,
				cid: op.cid,
				prev: op.prev,
				...(op.bytes
					? { value: recordBytesToJson(new Uint8Array(op.bytes)) }
					: {}),
			}));
			if (!page.head) {
				const last = page.ops[page.ops.length - 1];
				return c.json({
					ops,
					...(last ? { cursor: `${last.rev}/${last.idx}` } : {}),
				});
			}
			const keypair = await host.getKeypair();
			const commit = await signCommit(
				{
					spaceUri: ref.uri,
					author: host.operatorDid,
					state: {
						setHash: new Uint8Array(page.head.setHash),
						rev: page.head.rev,
					},
				},
				keypair,
			);
			return c.json({ ops, commit: commitToJson(commit) });
		} catch (err) {
			return errorResponse(c, err);
		}
	});

	app.get("/xrpc/com.atproto.space.getRepo", async (c) => {
		try {
			const ref = requireSpaceUri(c.req.query("space"));
			const auth = await readAuth(c, ref, c.req.query("repo"));
			if (auth instanceof Response) return auth;
			const excludeValues = c.req.query("excludeValues") === "true";

			const stub = host.getSpaceDO(ref.uri);
			await requireRepoExists(stub, ref);
			const state = await stub.rpcGetRepoState();
			if (!state) {
				throw new SpaceError(
					"RepoNotFound",
					`Could not find repo for space: ${ref.uri}`,
				);
			}
			const keypair = await host.getKeypair();
			const commit = await signCommit(
				{
					spaceUri: ref.uri,
					author: host.operatorDid,
					state: {
						setHash: new Uint8Array(state.setHash),
						rev: state.rev,
					},
				},
				keypair,
			);

			// Records are pulled from the DO in pages. serializeRepo collects
			// them before writing, so the whole repo passes through Worker
			// memory — acceptable for the alpha (see spec open questions).
			async function* records(): AsyncIterable<SerializedRecord> {
				let after: { collection: string; rkey: string } | undefined;
				for (;;) {
					const page = await stub.rpcListRecords({
						limit: 500,
						after,
						reverse: true, // ascending
						excludeValues: false,
					});
					for (const record of page.records) {
						yield {
							collection: record.collection,
							rkey: record.rkey,
							cid: parseCid(record.cid),
							bytes: new Uint8Array(record.bytes!),
						};
					}
					const last = page.records[page.records.length - 1];
					if (!page.hasMore || !last) return;
					after = { collection: last.collection, rkey: last.rkey };
				}
			}

			const car = serializeRepo(commit, records(), { excludeValues });
			const stream = new ReadableStream<Uint8Array>({
				async start(controller) {
					try {
						for await (const chunk of car) {
							controller.enqueue(chunk);
						}
						controller.close();
					} catch (err) {
						controller.error(err);
					}
				},
			});
			return new Response(stream, {
				status: 200,
				headers: { "Content-Type": "application/vnd.ipld.car" },
			});
		} catch (err) {
			return errorResponse(c, err);
		}
	});

	app.get("/xrpc/com.atproto.space.listBlobs", async (c) => {
		try {
			const ref = requireSpaceUri(c.req.query("space"));
			const auth = await readAuth(c, ref, c.req.query("repo"));
			if (auth instanceof Response) return auth;
			const limit = clampLimit(c.req.query("limit"), 500, 1000);
			const since = c.req.query("since");
			const afterCid = c.req.query("cursor");

			const stub = host.getSpaceDO(ref.uri);
			await requireRepoExists(stub, ref);
			const page = await stub.rpcListBlobs({ since, limit, afterCid });
			const last = page.cids[page.cids.length - 1];
			return c.json({
				cids: page.cids,
				...(page.hasMore && last ? { cursor: last } : {}),
			});
		} catch (err) {
			return errorResponse(c, err);
		}
	});

	app.get("/xrpc/com.atproto.space.getBlob", async (c) => {
		try {
			const ref = requireSpaceUri(c.req.query("space"));
			const auth = await readAuth(c, ref, c.req.query("repo"));
			if (auth instanceof Response) return auth;
			const cid = c.req.query("cid");
			requireString(cid, "cid");
			if (!host.blobs) {
				return c.json(
					{
						error: "ServiceUnavailable",
						message: "Blob storage is not configured",
					},
					503,
				);
			}

			const stub = host.getSpaceDO(ref.uri);
			await requireRepoExists(stub, ref);
			// Refuse before touching the blobstore: do not reveal whether an
			// unreferenced blob exists.
			if (!(await stub.rpcHasSpaceBlob(cid!))) {
				throw new SpaceError("BlobNotFound", `Blob not found: ${cid}`);
			}
			const key = spaceBlobKey(host.operatorDid, await spaceId(ref.uri), cid!);
			const blob = await host.blobs.get(key);
			if (!blob) {
				throw new SpaceError("BlobNotFound", `Blob not found: ${cid}`);
			}
			return new Response(blob.body, {
				status: 200,
				headers: {
					"Content-Type":
						blob.httpMetadata?.contentType ?? "application/octet-stream",
					"Content-Length": blob.size.toString(),
					// A shared cache in front of the PDS must never store a
					// response whose authorisation was per-credential.
					"Cache-Control": "private, no-store",
					Vary: "Authorization, DPoP",
					"X-Content-Type-Options": "nosniff",
					"Content-Disposition": `attachment; filename="${cid}"`,
					"Content-Security-Policy": "default-src 'none'; sandbox",
				},
			});
		} catch (err) {
			return errorResponse(c, err);
		}
	});

	// ---------------------------------------------------------------
	// Space host endpoints (authority role)
	// ---------------------------------------------------------------

	app.post("/xrpc/com.atproto.space.getSpaceCredential", async (c) => {
		try {
			const body = await c.req.json<{
				space?: string;
				clientAttestation?: string;
			}>();
			const ref = requireSpaceUri(body.space);
			assertSpaceHost(ref);

			const authHeader = c.req.header("Authorization");
			if (!authHeader?.startsWith("Bearer ")) {
				throw new SpaceError(
					"InvalidDelegationToken",
					"Expected a Bearer delegation token",
				);
			}
			const stub = host.getSpaceDO(ref.uri);
			const delegation = await verifyDelegationAuth(
				authHeader.slice(7),
				ref,
				verifyOpts(c, stub),
			);

			const { meta, config } = await stub.rpcGetAuthorityState();
			if (meta?.deletedAt) {
				// The durable signal that a space is gone: a syncer that missed
				// notifySpaceDeleted learns to drop its copy here.
				throw new SpaceError("SpaceDeleted", `Space deleted: ${ref.uri}`);
			}
			if (!meta || !config) {
				throw new SpaceError("SpaceNotFound", `Space not found: ${ref.uri}`);
			}

			// App perimeter first, so a refused app is never disclosed to a
			// third-party managing app.
			let clientId: string | undefined;
			if (config.appAccess.kind === "allowList") {
				if (!body.clientAttestation) {
					throw new SpaceError(
						"AppNotAuthorized",
						"This space requires a client attestation",
					);
				}
				clientId = await verifyClientAttestation(body.clientAttestation, {
					expectedAud: spaceHostAud(ref.authority),
					checkReplay: replayChecker(stub),
					fetch: host.outboundFetch,
				});
				if (!config.appAccess.allowed.includes(clientId)) {
					throw new SpaceError(
						"AppNotAuthorized",
						"App is not authorized for this space",
					);
				}
			}

			const authorized = await authorizeUser(
				config,
				ref,
				delegation.userDid,
				clientId,
				stub,
			);
			if (!authorized) {
				throw new SpaceError(
					"UserNotAuthorized",
					"User is not authorized for this space",
				);
			}

			const keypair = await host.getKeypair();
			const credential = await createSpaceToken(
				"credential",
				{
					iss: host.operatorDid,
					sub: ref.uri,
					dpopJkt: delegation.dpopJkt,
				},
				keypair,
			);
			return c.json({ credential });
		} catch (err) {
			return errorResponse(c, err);
		}
	});

	app.get("/xrpc/com.atproto.space.listRepos", async (c) => {
		try {
			const ref = requireSpaceUri(c.req.query("space"));
			assertSpaceHost(ref);
			const authHeader = c.req.header("Authorization");
			if (!isSpaceCredentialAuth(authHeader)) {
				throw new SpaceError(
					"InvalidCredential",
					"listRepos requires a space credential",
				);
			}
			const stub = host.getSpaceDO(ref.uri);
			await verifySpaceCredentialAuth(
				authHeader!.slice(5),
				ref,
				verifyOpts(c, stub),
			);
			const limit = clampLimit(c.req.query("limit"), 100, 1000);
			const page = await stub.rpcListWriters({
				limit,
				afterDid: c.req.query("cursor"),
			});
			const last = page.repos[page.repos.length - 1];
			return c.json({
				repos: page.repos.map((repo) => ({
					did: repo.did,
					rev: repo.rev,
					hash: bytesToJson(new Uint8Array(repo.hash)),
				})),
				...(page.hasMore && last ? { cursor: last.did } : {}),
			});
		} catch (err) {
			return errorResponse(c, err);
		}
	});

	app.post("/xrpc/com.atproto.space.registerNotify", async (c) => {
		try {
			const body = await c.req.json<{ space?: string; service?: string }>();
			const ref = requireSpaceUri(body.space);
			assertSpaceHost(ref);
			requireString(body.service, "service");
			const authHeader = c.req.header("Authorization");
			if (!isSpaceCredentialAuth(authHeader)) {
				throw new SpaceError(
					"InvalidCredential",
					"registerNotify requires a space credential",
				);
			}
			const stub = host.getSpaceDO(ref.uri);
			await verifySpaceCredentialAuth(
				authHeader!.slice(5),
				ref,
				verifyOpts(c, stub),
			);
			// Resolve now and store both, so fan-out never resolves DIDs.
			const endpoint = await host.resolveServiceEndpoint(body.service!);
			if (!endpoint) {
				throw new SpaceError(
					"ServiceNotResolvable",
					`Could not resolve service: ${body.service}`,
				);
			}
			const result = await stub.rpcRegisterNotify(body.service!, endpoint);
			return c.json({ expiresAt: result.expiresAt });
		} catch (err) {
			return errorResponse(c, err);
		}
	});

	app.post("/xrpc/com.atproto.space.unregisterNotify", async (c) => {
		try {
			const body = await c.req.json<{ space?: string; service?: string }>();
			const ref = requireSpaceUri(body.space);
			assertSpaceHost(ref);
			requireString(body.service, "service");
			const authHeader = c.req.header("Authorization");
			if (!isSpaceCredentialAuth(authHeader)) {
				throw new SpaceError(
					"InvalidCredential",
					"unregisterNotify requires a space credential",
				);
			}
			const stub = host.getSpaceDO(ref.uri);
			await verifySpaceCredentialAuth(
				authHeader!.slice(5),
				ref,
				verifyOpts(c, stub),
			);
			// No endpoint resolution: a subscriber whose DID doc changed must
			// still be able to withdraw. Idempotent.
			await stub.rpcUnregisterNotify(body.service!);
			return c.json({});
		} catch (err) {
			return errorResponse(c, err);
		}
	});

	app.post("/xrpc/com.atproto.space.notifyWrite", async (c) => {
		try {
			const body = await c.req.json<{
				space?: string;
				repo?: string;
				rev?: string;
				hash?: { $bytes?: string };
			}>();
			const ref = requireSpaceUri(body.space);
			assertSpaceHost(ref);
			requireString(body.repo, "repo");
			requireString(body.rev, "rev");
			if (typeof body.hash?.$bytes !== "string") {
				throw new SpaceError("InvalidRequest", "Missing hash bytes");
			}

			const authHeader = c.req.header("Authorization");
			if (!authHeader?.startsWith("Bearer ")) {
				return c.json(
					{
						error: "AuthenticationRequired",
						message: "Service auth required",
					},
					401,
				);
			}
			const serviceAuth = await host.verifyServiceJwt(
				authHeader.slice(7),
				NOTIFY_WRITE_LXM,
			);
			if (serviceAuth.iss !== body.repo) {
				return c.json(
					{
						error: "Forbidden",
						message: "notifyWrite iss does not match claimed writer",
					},
					403,
				);
			}
			// The reference checks the bare DID as audience, not the
			// #atproto_space_host fragment, and we match it.
			if (serviceAuth.aud !== host.operatorDid) {
				return c.json(
					{
						error: "Forbidden",
						message: "notifyWrite aud does not match the space authority",
					},
					403,
				);
			}

			const stub = host.getSpaceDO(ref.uri);
			const { meta, config } = await stub.rpcGetAuthorityState();
			if (!meta || meta.deletedAt || !config) {
				// Silently ignore notifications for spaces this host does not
				// (or no longer) governs.
				return c.json({});
			}
			const authorized = await authorizeUser(
				config,
				ref,
				body.repo!,
				undefined,
				stub,
			);
			if (!authorized) {
				return c.json(
					{
						error: "Forbidden",
						message: "notifyWrite writer is not authorized",
					},
					403,
				);
			}

			const hash = fromBase64(body.hash.$bytes);
			await stub.rpcRecordWriter(body.repo!, body.rev!, hash);

			// Fan out to every registration except the sender.
			const registrations = await stub.rpcGetActiveRegistrations();
			const senderDid = body.repo!;
			const targets = registrations.filter(
				(registration) => registration.service.split("#")[0] !== senderDid,
			);
			if (targets.length > 0) {
				const notifyBody = {
					space: ref.uri,
					repo: body.repo!,
					rev: body.rev!,
					hash: body.hash,
				};
				await stub.rpcEnqueueNotify(
					targets.map((registration) => ({
						service: registration.service,
						endpoint: registration.endpoint,
						lxm: NOTIFY_WRITE_LXM,
						body: notifyBody,
					})),
				);
			}
			return c.json({});
		} catch (err) {
			return errorResponse(c, err);
		}
	});

	app.post("/xrpc/com.atproto.space.notifySpaceDeleted", async (c) => {
		try {
			const body = await c.req.json<{ space?: string }>();
			const ref = requireSpaceUri(body.space);

			const authHeader = c.req.header("Authorization");
			if (!authHeader?.startsWith("Bearer ")) {
				return c.json(
					{
						error: "AuthenticationRequired",
						message: "Service auth required",
					},
					401,
				);
			}
			const serviceAuth = await host.verifyServiceJwt(
				authHeader.slice(7),
				SPACE_DELETED_LXM,
			);
			// Only the space's authority may tell us to drop our copy.
			if (serviceAuth.iss !== ref.authority) {
				return c.json(
					{
						error: "Forbidden",
						message: "notifySpaceDeleted iss is not the space authority",
					},
					403,
				);
			}
			if (ref.authority === host.operatorDid) {
				// We are the authority; nothing to drop from elsewhere.
				return c.json({});
			}

			const stub = host.getSpaceDO(ref.uri);
			const meta = await stub.rpcGetMeta();
			if (meta && !meta.deletedAt) {
				await stub.rpcDeleteSpace();
				await host.getIndexDO().rpcMarkDeleted(ref.uri);
				if (host.blobs) {
					waitUntil(
						c,
						deleteR2Prefix(
							host.blobs,
							spaceBlobPrefix(host.operatorDid, await spaceId(ref.uri)),
						),
					);
				}
			}
			return c.json({});
		} catch (err) {
			return errorResponse(c, err);
		}
	});

	// ---------------------------------------------------------------
	// simplespace management (authority role, session auth)
	// ---------------------------------------------------------------

	app.post("/xrpc/com.atproto.simplespace.createSpace", async (c) => {
		try {
			const body = await c.req.json<{
				type?: string;
				skey?: string;
				policy?: unknown;
				appAccess?: unknown;
			}>();
			requireString(body.type, "type");
			const skey = body.skey ?? tidNow();
			const session = await sessionAuth(c);
			if (session instanceof Response) return session;
			const scopeError = assertScope(c, session, {
				type: body.type!,
				authority: host.operatorDid,
				skey,
				manage: "create",
			});
			if (scopeError) return scopeError;

			const config: SpaceConfig = {
				policy: parsePolicy(body.policy),
				appAccess: parseAppAccess(body.appAccess),
			};
			const uri = `at://${host.operatorDid}/space/${body.type}/${skey}`;
			const ref = requireSpaceUri(uri);

			// Two-step creation: index entry `pending`, then the DO, then
			// `active`. Reads never depend on the index, so a crash between
			// steps leaves only a pending entry for the alarm to reap.
			const index = host.getIndexDO();
			await index.rpcRegister({
				uri: ref.uri,
				authority: ref.authority,
				type: ref.type,
				skey: ref.skey,
				isAuthority: true,
			});
			const stub = host.getSpaceDO(ref.uri);
			await stub.rpcInit({
				uri: ref.uri,
				authority: ref.authority,
				type: ref.type,
				skey: ref.skey,
				isAuthority: true,
				config,
			});
			await index.rpcActivate(ref.uri);
			return c.json({ uri: ref.uri });
		} catch (err) {
			return errorResponse(c, err);
		}
	});

	app.post("/xrpc/com.atproto.simplespace.updateSpace", async (c) => {
		try {
			const body = await c.req.json<{
				space?: string;
				policy?: unknown;
				appAccess?: unknown;
			}>();
			const ref = requireSpaceUri(body.space);
			const session = await sessionAuth(c);
			if (session instanceof Response) return session;
			assertOwner(ref, session);
			const scopeError = assertScope(c, session, {
				type: ref.type,
				authority: ref.authority,
				skey: ref.skey,
				manage: "update",
			});
			if (scopeError) return scopeError;
			const stub = host.getSpaceDO(ref.uri);
			await stub.rpcUpdateConfig({
				...(body.policy !== undefined
					? { policy: parsePolicy(body.policy) }
					: {}),
				...(body.appAccess !== undefined
					? { appAccess: parseAppAccess(body.appAccess) }
					: {}),
			});
			return c.json({});
		} catch (err) {
			return errorResponse(c, err);
		}
	});

	app.post("/xrpc/com.atproto.simplespace.deleteSpace", async (c) => {
		try {
			const body = await c.req.json<{ space?: string }>();
			const ref = requireSpaceUri(body.space);
			const session = await sessionAuth(c);
			if (session instanceof Response) return session;
			assertOwner(ref, session);
			const scopeError = assertScope(c, session, {
				type: ref.type,
				authority: ref.authority,
				skey: ref.skey,
				manage: "delete",
			});
			if (scopeError) return scopeError;

			const stub = host.getSpaceDO(ref.uri);
			const { registrations } = await stub.rpcDeleteSpace();
			await host.getIndexDO().rpcMarkDeleted(ref.uri);
			// Stop credential issuance happened with the tombstone; tell every
			// registered syncer to drop its copy, then reap the blob prefix.
			if (registrations.length > 0) {
				await stub.rpcEnqueueNotify(
					registrations.map((registration) => ({
						service: registration.service,
						endpoint: registration.endpoint,
						lxm: SPACE_DELETED_LXM,
						body: { space: ref.uri },
					})),
				);
			}
			if (host.blobs) {
				waitUntil(
					c,
					deleteR2Prefix(
						host.blobs,
						spaceBlobPrefix(host.operatorDid, await spaceId(ref.uri)),
					),
				);
			}
			return c.json({});
		} catch (err) {
			// deleteSpace is idempotent: a second delete of a tombstoned space
			// (or a never-created one) reports SpaceNotFound per the lexicon.
			return errorResponse(c, err);
		}
	});

	app.post("/xrpc/com.atproto.simplespace.addMember", async (c) => {
		return memberChange(c, "add");
	});

	app.post("/xrpc/com.atproto.simplespace.removeMember", async (c) => {
		return memberChange(c, "remove");
	});

	async function memberChange(
		c: Context,
		op: "add" | "remove",
	): Promise<Response> {
		try {
			const body = await c.req.json<{ space?: string; did?: string }>();
			const ref = requireSpaceUri(body.space);
			requireString(body.did, "did");
			const session = await sessionAuth(c);
			if (session instanceof Response) return session;
			assertOwner(ref, session);
			const scopeError = assertScope(c, session, {
				type: ref.type,
				authority: ref.authority,
				skey: ref.skey,
				manage: "update",
			});
			if (scopeError) return scopeError;
			const stub = host.getSpaceDO(ref.uri);
			await requireConfigured(stub, ref);
			if (op === "add") {
				await stub.rpcAddMember(body.did!);
			} else {
				await stub.rpcRemoveMember(body.did!);
			}
			return c.json({});
		} catch (err) {
			return errorResponse(c, err);
		}
	}

	app.get("/xrpc/com.atproto.simplespace.getSpace", async (c) => {
		try {
			const ref = requireSpaceUri(c.req.query("space"));
			assertSpaceHost(ref);
			const stub = host.getSpaceDO(ref.uri);

			const authHeader = c.req.header("Authorization");
			if (isSpaceCredentialAuth(authHeader)) {
				await verifySpaceCredentialAuth(
					authHeader!.slice(5),
					ref,
					verifyOpts(c, stub),
				);
			} else {
				const session = await sessionAuth(c);
				if (session instanceof Response) return session;
				const scopeError = assertScope(c, session, {
					type: ref.type,
					authority: ref.authority,
					skey: ref.skey,
					action: "read_self",
				});
				if (scopeError) return scopeError;
			}

			const config = await requireConfigured(stub, ref);
			return c.json({
				uri: ref.uri,
				policy: policyToJson(config.policy),
				appAccess: appAccessToJson(config.appAccess),
			});
		} catch (err) {
			return errorResponse(c, err);
		}
	});

	app.get("/xrpc/com.atproto.simplespace.listMembers", async (c) => {
		try {
			const ref = requireSpaceUri(c.req.query("space"));
			const session = await sessionAuth(c);
			if (session instanceof Response) return session;
			assertOwner(ref, session);
			const scopeError = assertScope(c, session, {
				type: ref.type,
				authority: ref.authority,
				skey: ref.skey,
				action: "read_self",
			});
			if (scopeError) return scopeError;
			const stub = host.getSpaceDO(ref.uri);
			await requireConfigured(stub, ref);
			const limit = clampLimit(c.req.query("limit"), 100, 1000);
			const page = await stub.rpcListMembers({
				limit,
				afterDid: c.req.query("cursor"),
			});
			const last = page.dids[page.dids.length - 1];
			return c.json({
				members: page.dids.map((did) => ({ did })),
				...(page.hasMore && last ? { cursor: last } : {}),
			});
		} catch (err) {
			return errorResponse(c, err);
		}
	});

	function assertOwner(ref: SpaceRef, session: SpaceSessionAuth): void {
		assertSpaceHost(ref);
		if (session.did !== ref.authority) {
			throw new SpaceError(
				"NotSpaceOwner",
				"Only the space owner may manage the space",
			);
		}
	}

	async function requireConfigured(
		stub: SpaceStub,
		ref: SpaceRef,
	): Promise<SpaceConfig> {
		const { meta, config } = await stub.rpcGetAuthorityState();
		if (!meta || meta.deletedAt || !config) {
			throw new SpaceError("SpaceNotFound", `Space not found: ${ref.uri}`);
		}
		return config;
	}

	/**
	 * A repo exists in a space once the operator has written into it (or
	 * the space was created here). RepoNotFound deliberately covers both
	 * "no such repo" and "space unknown to this host".
	 */
	async function requireRepoExists(
		stub: SpaceStub,
		ref: SpaceRef,
	): Promise<void> {
		const meta = await stub.rpcGetMeta();
		if (meta?.deletedAt) {
			// After deletion, reads against the space fail with SpaceNotFound.
			throw new SpaceError("SpaceNotFound", `Space not found: ${ref.uri}`);
		}
		if (!meta) {
			throw new SpaceError(
				"RepoNotFound",
				`Could not find repo for space: ${ref.uri}`,
			);
		}
	}

	return app;
}

// ---------------------------------------------------------------------
// Small parsing helpers
// ---------------------------------------------------------------------

function requireString(
	value: unknown,
	name: string,
): asserts value is string {
	if (typeof value !== "string" || value.length === 0) {
		throw new SpaceError("InvalidRequest", `Missing required parameter: ${name}`);
	}
}

function clampLimit(
	raw: string | undefined,
	fallback: number,
	max: number,
): number {
	const parsed = raw ? Number.parseInt(raw, 10) : fallback;
	if (Number.isNaN(parsed) || parsed < 1) return fallback;
	return Math.min(parsed, max);
}

function parseRecordCursor(
	cursor: string | undefined,
): { collection: string; rkey: string } | undefined {
	if (!cursor) return undefined;
	const slash = cursor.lastIndexOf("/");
	if (slash <= 0 || slash === cursor.length - 1) {
		throw new SpaceError("MalformedCursor", `Malformed cursor: ${cursor}`);
	}
	return {
		collection: cursor.slice(0, slash),
		rkey: cursor.slice(slash + 1),
	};
}

function parseOpsCursor(
	cursor: string | undefined,
): { rev: string; idx: number } | undefined {
	if (!cursor) return undefined;
	const slash = cursor.indexOf("/");
	const idx = slash === -1 ? NaN : Number.parseInt(cursor.slice(slash + 1), 10);
	if (slash <= 0 || Number.isNaN(idx)) {
		throw new SpaceError("MalformedCursor", `Malformed cursor: ${cursor}`);
	}
	return { rev: cursor.slice(0, slash), idx };
}

const POLICY_PREFIX = "com.atproto.simplespace.defs#";

function parsePolicy(input: unknown): SpacePolicy {
	const type = (input as { $type?: string } | undefined)?.$type;
	switch (type) {
		case `${POLICY_PREFIX}publicPolicy`:
			return { kind: "public" };
		case `${POLICY_PREFIX}memberListPolicy`:
			return { kind: "member-list" };
		case `${POLICY_PREFIX}managingAppPolicy`: {
			const managingApp = (input as { managingApp?: unknown }).managingApp;
			if (typeof managingApp !== "string" || !managingApp.startsWith("did:")) {
				throw new SpaceError(
					"UnsupportedPolicy",
					"managingApp must be a DID service identifier",
				);
			}
			return { kind: "managing-app", managingApp };
		}
		default:
			throw new SpaceError(
				"UnsupportedPolicy",
				`Unsupported policy: ${String(type)}`,
			);
	}
}

function policyToJson(policy: SpacePolicy): Record<string, unknown> {
	switch (policy.kind) {
		case "public":
			return { $type: `${POLICY_PREFIX}publicPolicy` };
		case "member-list":
			return { $type: `${POLICY_PREFIX}memberListPolicy` };
		case "managing-app":
			return {
				$type: `${POLICY_PREFIX}managingAppPolicy`,
				managingApp: policy.managingApp,
			};
	}
}

function appAccessToJson(appAccess: SpaceAppAccess): Record<string, unknown> {
	switch (appAccess.kind) {
		case "open":
			return { $type: `${POLICY_PREFIX}open` };
		case "allowList":
			return {
				$type: `${POLICY_PREFIX}allowList`,
				allowed: appAccess.allowed,
			};
	}
}

function parseAppAccess(input: unknown): SpaceAppAccess {
	const type = (input as { $type?: string } | undefined)?.$type;
	switch (type) {
		case `${POLICY_PREFIX}open`:
			return { kind: "open" };
		case `${POLICY_PREFIX}allowList`: {
			const allowed = (input as { allowed?: unknown }).allowed;
			if (
				!Array.isArray(allowed) ||
				allowed.some((entry) => typeof entry !== "string")
			) {
				throw new SpaceError(
					"UnsupportedAppAccess",
					"allowList requires an array of client IDs",
				);
			}
			return { kind: "allowList", allowed: allowed as string[] };
		}
		default:
			throw new SpaceError(
				"UnsupportedAppAccess",
				`Unsupported appAccess: ${String(type)}`,
			);
	}
}

async function deleteR2Prefix(bucket: R2Bucket, prefix: string): Promise<void> {
	let cursor: string | undefined;
	do {
		const listed = await bucket.list({ prefix, cursor, limit: 500 });
		if (listed.objects.length > 0) {
			await bucket.delete(listed.objects.map((object) => object.key));
		}
		cursor = listed.truncated ? listed.cursor : undefined;
	} while (cursor);
}
