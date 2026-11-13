/**
 * Hono route factory for `com.atproto.space.*` and
 * `com.atproto.memberspace.*`.
 *
 * The factory is host-agnostic: everything account-specific — session
 * authentication, DID resolution, record validation, the operator identity
 * and its keys — arrives through {@link SpaceRoutesHost}. The host mounts
 * the returned app behind its feature flag.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import {
	createSpaceCredential,
	isP256DidKey,
	parseSpaceToken,
	readRepoStar,
	readSpaceMetaStar,
	spaceHostAud,
	writeRepoStar,
	writeSpaceMetaStar,
} from "@atproto/space";
import type { P256Keypair } from "@atproto/crypto";
import { encode } from "@atproto/lex-cbor";
import {
	cidForCbor,
	enumBlobRefs,
	fromBase64,
	getBlobCidString,
} from "@atproto/lex-data";
import type { LexValue } from "@atproto/lex-data";
import { now as tidNow } from "@atcute/tid";
import {
	isSpaceCredentialAuth,
	verifyDelegationToken,
	verifySpaceCredentialAuth,
	type GetSigningKey,
} from "./auth.js";
import { verifyClientAttestation } from "./attestation.js";
import {
	COMMIT_MAC_PROFILE,
	MAC_REQUEST_HEADER,
	RECORD_MAC_PROFILE,
	buildCommit,
	bytesToJson,
	commitMacHeaders,
	commitToJson,
	importKemKeypair,
	macExposedHeaders,
	macRequest,
	recordMacHeaders,
	type MacParams,
	type MacProfile,
} from "./mac.js";
import { SpaceError, parseSpaceErrorCode, spaceErrorStatus } from "./errors.js";
import {
	MEMBER_COLLECTION,
	PUBLISHED_COLLECTIONS,
	assertNotPublishedCollection,
	didToRecordKey,
	isAppAuthorized,
	isPublicRead,
	normalizePolicy,
	recordKeyToDid,
} from "./policy.js";
import { prepareRecord, recordBytesToJson } from "./records.js";
import {
	MAX_NOTIFY_TOKEN_LENGTH,
	MAX_REV_CLOCK_SKEW_MS,
	MAX_SPACE_RECORD_BYTES,
	NOTIFY_BACKOFF_BASE_MS,
	NOTIFY_WRITE_RETRY_MS,
} from "./schema.js";
import { createServiceJwt } from "./service-jwt.js";
import {
	promoteStagedBlobToSpace,
	spaceBlobKey,
	spaceBlobPrefix,
} from "./blob-keys.js";
import {
	parseSpaceUri,
	requireSpaceUri,
	spaceId,
	spaceRecordUri,
} from "./space-uri.js";
import type { SpaceRef } from "./space-uri.js";
import { isRetryableStatus } from "./space-do.js";
import type { SpaceDurableObject } from "./space-do.js";
import type { SpaceIndexDurableObject } from "./index-do.js";
import { tidTimestampMs } from "./tid.js";
import {
	MANAGEDSPACE_POLICY,
	MEMBERSPACE_POLICY,
	PERSONALSPACE_POLICY,
	type ImportedRecord,
	type NotifyItem,
	type NotifyRegistration,
	type PreparedSpaceWrite,
	type RepoCommitResult,
	type SpaceMember,
	type SpacePolicy,
	type SpaceSigningKeypair,
} from "./types.js";

const NOTIFY_REPO_UPDATE_LXM = "com.atproto.space.notifyRepoUpdate";
const CREDENTIALS_REVOKED_LXM = "com.atproto.space.notifyCredentialsRevoked";
const CONFIRM_REGISTRATION_LXM = "com.atproto.space.confirmRegistration";
const CHECK_ACCESS_LXM = "com.atproto.managedspace.checkAccess";
/** A managing app or syncer endpoint that doesn't answer in this window fails. */
const UPSTREAM_TIMEOUT_MS = 10_000;
/** The queue key for this repo's pending update notification to a foreign authority. */
const NOTIFY_REPO_UPDATE_COALESCE_KEY = "notifyRepoUpdate:authority";
/** Upper bound on archives accepted by importRepo / importSpaceMeta. */
const MAX_IMPORT_BYTES = 100 * 1024 * 1024;
/** Revocations are held until any credential they name has expired. */
const REVOCATION_TTL_SEC = 3600 + 2 * 5;
/** The media type of STAR archives (repos and space meta). */
const STAR_CONTENT_TYPE = "application/vnd.dasl.star";
/** Batched member changes take at most this many entries. */
const MAX_MEMBER_BATCH = 100;

export type SpaceStub = DurableObjectStub<SpaceDurableObject>;
export type SpaceIndexStub = DurableObjectStub<SpaceIndexDurableObject>;

/** The operation shapes checked against a session's `space:` grants. */
export type SpaceScopeMatch = {
	type: string;
	authority: string;
	skey: string;
} & (
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
	/** R2 bucket for blobs; space blob endpoints 503 without it. */
	blobs?: R2Bucket;
	/** The account's `#atproto` keypair: space tokens and service auth. */
	getKeypair(): Promise<SpaceSigningKeypair>;
	/**
	 * The account's `#atproto_kem` P-256 private key (hex), which MACs space
	 * data for syncers. Null when unconfigured: reads that owe a MAC then
	 * answer KemKeyUnavailable.
	 */
	getKemPrivateKey(): string | null | Promise<string | null>;
	/** DID-doc `#atproto` key resolution for foreign issuers. */
	getSigningKey: GetSigningKey;
	/**
	 * Resolve a service identifier to an HTTPS endpoint: `did#fragment`
	 * names that service entry, a bare DID its `#atproto_pds`. Null when
	 * unresolvable.
	 */
	resolveServiceEndpoint(service: string): Promise<string | null>;
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
	 * Whether the operator's account is active. A deactivated authority
	 * issues no credentials and lists no repos. Treated as active when
	 * absent.
	 */
	isAccountActive?(): Promise<boolean>;
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

/** Request headers as a plain object with lower-cased names. */
function headerRecord(c: Context): Record<string, string | undefined> {
	return Object.fromEntries(c.req.raw.headers);
}

/** Append to a comma-separated response header without clobbering it. */
function appendHeader(c: Context, name: string, value: string): void {
	c.header(name, value, { append: true });
}

interface AuthedRead {
	kind: "credential" | "session";
}

type ScopeResult = Response | null;

export function createSpaceRoutes(host: SpaceRoutesHost): Hono {
	const app = new Hono();
	const doFetch: typeof fetch = host.outboundFetch ?? fetch;

	let kemKeypair: Promise<P256Keypair | null> | null = null;
	function getKemKeypair(): Promise<P256Keypair | null> {
		kemKeypair ??= Promise.resolve(host.getKemPrivateKey()).then((hex) =>
			hex ? importKemKeypair(hex) : null,
		);
		return kemKeypair;
	}

	/** The `repo` param on every repo-host method must be the operator DID. */
	function requireRepoParam(repo: unknown): void {
		if (repo !== host.operatorDid) {
			throw new SpaceError(
				"RepoNotFound",
				`Repository not found: ${String(repo)}`,
			);
		}
	}

	/**
	 * Verify a space credential addressed to this host. Every audience is
	 * the operator DID: Cirrus serves only the operator's repos, and hosts
	 * only spaces under the operator's authority.
	 */
	async function credentialAuth(c: Context, ref: SpaceRef): Promise<void> {
		const stub = host.getSpaceDO(ref.uri);
		await verifySpaceCredentialAuth(ref, {
			headers: headerRecord(c),
			audience: host.operatorDid,
			getSigningKey: host.getSigningKey,
			checkRevoked: (jti) => stub.rpcIsCredentialRevoked(jti),
		});
	}

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
		requireRepoParam(repo);
		if (isSpaceCredentialAuth(c.req.header("Authorization"))) {
			await credentialAuth(c, ref);
			return { kind: "credential" };
		}
		const session = await host.authenticate(c);
		if (session instanceof Response) return session;
		const scopeError = assertScope(c, session, {
			type: ref.type,
			authority: ref.authority,
			skey: ref.skey,
			action: "read_self",
		});
		if (scopeError) return scopeError;
		return { kind: "session" };
	}

	/**
	 * The MAC owed by a read that returns a commit or record, with the
	 * response headers a browser syncer needs to read the MAC.
	 */
	async function readMac(
		c: Context,
		auth: AuthedRead,
		profile: MacProfile,
	): Promise<MacParams | undefined> {
		appendHeader(c, "Vary", "Accept-Signature");
		const mac = await macRequest({
			acceptSignature: c.req.header(MAC_REQUEST_HEADER),
			credential: auth.kind === "credential",
			profile,
			getKemKeypair,
		});
		if (mac) {
			for (const header of macExposedHeaders(profile)) {
				appendHeader(c, "Access-Control-Expose-Headers", header);
			}
		}
		return mac;
	}

	function assertScope(
		c: Context,
		session: SpaceSessionAuth,
		match: SpaceScopeMatch,
	): ScopeResult {
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

	/** As assertSpaceHost, and the authority's account must be active. */
	async function assertActiveSpaceHost(ref: SpaceRef): Promise<void> {
		assertSpaceHost(ref);
		if (host.isAccountActive && !(await host.isAccountActive())) {
			throw new SpaceError(
				"RepoDeactivated",
				`Repo has been deactivated: ${ref.authority}`,
			);
		}
	}

	/**
	 * A space created here is anchored on its creator's DID, so ownership
	 * is a comparison against the space URI, made before anything else.
	 */
	function assertOwner(ref: SpaceRef, session: SpaceSessionAuth): void {
		if (session.did !== ref.authority) {
			throw new SpaceError("NotAuthorized", "Not the space authority");
		}
		assertSpaceHost(ref);
	}

	/** The policy of a live space this host governs. */
	async function requirePolicy(
		stub: SpaceStub,
		ref: SpaceRef,
	): Promise<SpacePolicy> {
		const { meta, policy } = await stub.rpcGetAuthorityState();
		if (!meta || meta.deletedAt || !policy) {
			throw new SpaceError("SpaceNotFound", `Space not found: ${ref.uri}`);
		}
		return policy;
	}

	/**
	 * Whether a policy authorises an account to read or write. `repo` is
	 * absent for a read with no delegation token, which a policy authorises
	 * only if it does not gate on the account. The authority always passes
	 * under every policy: it alone can reconfigure the space, so it must not
	 * be able to lock itself out.
	 *
	 * A managing app that can't be reached throws UpstreamFailure rather
	 * than denying: denying would read as a loss of access, withdrawing a
	 * syncer's registration and making a repo host drop its notification.
	 */
	async function authorizeRepo(params: {
		policy: SpacePolicy;
		ref: SpaceRef;
		repo: string | undefined;
		access: "read" | "write";
		clientId?: string;
		stub: SpaceStub;
	}): Promise<boolean> {
		const { policy, ref, repo, access, clientId, stub } = params;
		if (repo === ref.authority) return true;
		switch (policy.$type) {
			case PERSONALSPACE_POLICY:
				return false;
			case MEMBERSPACE_POLICY: {
				if (access === "read" && policy.publicRead) return true;
				if (!repo) return false;
				const member = await stub.rpcGetMember(repo);
				if (access === "read") return member?.read ?? false;
				// A member without write access stays excluded even under
				// publicWrite.
				if (member) return member.write;
				return policy.publicWrite;
			}
			case MANAGEDSPACE_POLICY:
				return (await checkAccess(policy.managingApp, ref, repo, clientId))[
					access
				];
		}
	}

	/** Ask a managed space's managing app for an account's access. */
	async function checkAccess(
		managingApp: string,
		ref: SpaceRef,
		repo: string | undefined,
		clientId: string | undefined,
	): Promise<{ read: boolean; write: boolean }> {
		try {
			const endpoint = await host.resolveServiceEndpoint(managingApp);
			if (!endpoint) throw new Error("could not resolve the managing app");
			const token = await createServiceJwt(
				{ iss: host.operatorDid, aud: managingApp, lxm: CHECK_ACCESS_LXM },
				await host.getKeypair(),
			);
			const url = new URL(`${endpoint}/xrpc/${CHECK_ACCESS_LXM}`);
			url.searchParams.set("space", ref.uri);
			if (repo) url.searchParams.set("repo", repo);
			if (clientId) url.searchParams.set("clientId", clientId);
			const res = await doFetch(url.toString(), {
				headers: { Authorization: `Bearer ${token}` },
				signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
			});
			if (!res.ok) throw new Error(`checkAccess answered ${res.status}`);
			const body = (await res.json()) as { read?: unknown; write?: unknown };
			if (typeof body.read !== "boolean" || typeof body.write !== "boolean") {
				throw new Error("checkAccess answered without read and write");
			}
			return { read: body.read, write: body.write };
		} catch (err) {
			console.warn(`managing app check for ${ref.uri} failed:`, err);
			throw new SpaceError("UpstreamFailure", "Managing app did not answer");
		}
	}

	/**
	 * Ensure the space DO exists for a write. The first write into a foreign
	 * space registers it `pending` in the index, initialises the DO as repo
	 * host, then activates the entry. The operator's own spaces must already
	 * exist: a write must neither conjure an ungoverned space nor revive a
	 * deleted one.
	 */
	async function ensureSpaceForWrite(
		ref: SpaceRef,
		stub: SpaceStub,
	): Promise<void> {
		const meta = await stub.rpcGetMeta();
		if (meta && !meta.deletedAt) return;
		if (ref.authority === host.operatorDid) {
			throw new SpaceError(
				"SpaceNotFound",
				`Space not found: ${ref.uri}. Create it with com.atproto.space.createSpace.`,
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
	): Promise<string[]> {
		const missing: string[] = [];
		if (!host.blobs || blobCids.length === 0) return missing;
		await Promise.all(
			blobCids.map(async (cid) => {
				const present = await promoteStagedBlobToSpace(
					host.blobs!,
					host.operatorDid,
					ref.uri,
					cid,
				);
				if (!present) missing.push(cid);
			}),
		);
		return missing;
	}

	/**
	 * After a commit: the authority sequences its own update into the writer
	 * set, which queues it for registered syncers; a repo host in a foreign
	 * space delivers its latest state to the authority, immediately,
	 * persisting a retryable failure for the DO's alarm to retry for up to
	 * 24 hours. Retries coalesce, so only the newest revision is pending.
	 */
	async function postWrite(
		ref: SpaceRef,
		stub: SpaceStub,
		commit: RepoCommitResult,
	): Promise<void> {
		if (ref.authority === host.operatorDid) {
			await stub.rpcRecordWriter(host.operatorDid, commit.rev, commit.data);
			return;
		}
		const body = {
			space: ref.uri,
			repo: host.operatorDid,
			repoRev: commit.rev,
			data: bytesToJson(commit.data),
		};
		const aud = spaceHostAud(ref.authority as `did:${string}:${string}`);
		const endpoint = await host.resolveServiceEndpoint(aud).catch(() => null);
		if (!endpoint) {
			console.warn(`notifyRepoUpdate: no endpoint for ${ref.authority}`);
			return;
		}
		const retry: NotifyItem = {
			service: aud,
			endpoint,
			lxm: NOTIFY_REPO_UPDATE_LXM,
			body,
			coalesceKey: NOTIFY_REPO_UPDATE_COALESCE_KEY,
			deadline: Date.now() + NOTIFY_WRITE_RETRY_MS,
			policy: "repo",
			auth: "service",
		};
		try {
			const token = await createServiceJwt(
				{ iss: host.operatorDid, aud, lxm: NOTIFY_REPO_UPDATE_LXM },
				await host.getKeypair(),
			);
			const res = await doFetch(`${endpoint}/xrpc/${NOTIFY_REPO_UPDATE_LXM}`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${token}`,
				},
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
			});
			if (res.ok || !isRetryableStatus(res.status)) {
				if (!res.ok) {
					console.warn(
						`notifyRepoUpdate to ${ref.authority} refused: ${res.status}; not retrying`,
					);
				}
				await stub.rpcClearNotify(NOTIFY_REPO_UPDATE_COALESCE_KEY);
				return;
			}
			console.warn(
				`notifyRepoUpdate to ${ref.authority} failed: ${res.status}`,
			);
		} catch (err) {
			console.warn(`notifyRepoUpdate to ${ref.authority} errored:`, err);
		}
		await stub.rpcEnqueueNotify([retry], { delayMs: NOTIFY_BACKOFF_BASE_MS });
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
			assertNotPublishedCollection(write.collection);

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
			if (preparedRecord.bytes.length > MAX_SPACE_RECORD_BYTES) {
				throw new SpaceError(
					"InvalidRequest",
					`Record exceeds the maximum space record size of ${MAX_SPACE_RECORD_BYTES} bytes`,
				);
			}
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

		waitUntil(c, postWrite(ref, stub, result));

		return {
			rev: result.rev,
			results: result.results.map((r, i) => ({
				...r,
				...(statuses[i] !== undefined ? { validationStatus: statuses[i] } : {}),
			})),
		};
	}

	/** Notify after a configuration change that published to the repo. */
	function afterConfigCommit(
		c: Context,
		ref: SpaceRef,
		stub: SpaceStub,
		commit: RepoCommitResult | null,
	): void {
		if (commit) waitUntil(c, postWrite(ref, stub, commit));
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
			const session = await host.authenticate(c);
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
			const session = await host.authenticate(c);
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
			const session = await host.authenticate(c);
			if (session instanceof Response) return session;
			const result = await runWrites(
				c,
				ref,
				session,
				[{ action: "delete", collection: body.collection!, rkey: body.rkey }],
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
			const session = await host.authenticate(c);
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

	app.post("/xrpc/com.atproto.space.clearRecords", async (c) => {
		try {
			const body = await c.req.json<{ space?: string; repo?: string }>();
			const ref = requireSpaceUri(body.space);
			requireString(body.repo, "repo");
			const session = await host.authenticate(c);
			if (session instanceof Response) return session;
			if (body.repo !== session.did) {
				throw new SpaceError("Forbidden", "repo must match authenticated user");
			}
			requireRepoParam(body.repo);
			const stub = host.getSpaceDO(ref.uri);
			const meta = await stub.rpcGetMeta();
			if (!meta || meta.deletedAt) return c.json({});

			// In the authority's own repo the published policy and member
			// records are the host's copy of the space's configuration, not
			// the account's records, so they stay, and keeping them takes no
			// grant.
			const keep =
				ref.authority === host.operatorDid ? [...PUBLISHED_COLLECTIONS] : [];
			for (const collection of await stub.rpcListCollections()) {
				if (keep.includes(collection)) continue;
				const scopeError = assertScope(c, session, {
					type: ref.type,
					authority: ref.authority,
					skey: ref.skey,
					action: "delete",
					collection,
				});
				if (scopeError) return scopeError;
			}
			const commit = await stub.rpcClearRecords(keep);
			if (commit) waitUntil(c, postWrite(ref, stub, commit));
			return c.json({});
		} catch (err) {
			return errorResponse(c, err);
		}
	});

	app.post("/xrpc/com.atproto.space.importRepo", async (c) => {
		try {
			const session = await host.authenticate(c);
			if (session instanceof Response) return session;
			const bytes = await readBody(c);

			let records: ImportedRecord[];
			let space: string;
			let repo: string;
			try {
				const archive = await readRepoStar([bytes]);
				try {
					space = archive.commit.space;
					repo = archive.commit.repo;
					records = [];
					for await (const record of archive.records) {
						// Stored re-encoded, as any other write is. A record that
						// wasn't canonical DRISL in the archive would no longer match
						// its cid, nor the commit data.
						const encoded = encode(record.record as LexValue);
						const cid = await cidForCbor(encoded);
						if (!cid.equals(record.cid)) {
							throw new SpaceError(
								"InvalidRequest",
								`Invalid STAR: record is not canonical DRISL at ${record.collection}/${record.rkey}`,
							);
						}
						const blobCids: string[] = [];
						for (const ref of enumBlobRefs(record.record as LexValue, {
							strict: false,
						})) {
							blobCids.push(getBlobCidString(ref));
						}
						records.push({
							collection: record.collection,
							rkey: record.rkey,
							cid: cid.toString(),
							bytes: encoded,
							blobCids,
						});
					}
				} finally {
					await archive[Symbol.asyncDispose]();
				}
			} catch (err) {
				throw invalidArchive(err, "InvalidRepoFile");
			}

			if (repo !== host.operatorDid || repo !== session.did) {
				throw new SpaceError(
					"RepoMismatch",
					"Repo does not match the authenticated account",
				);
			}
			const ref = requireSpaceUri(space);
			for (const collection of new Set(records.map((r) => r.collection))) {
				const scopeError = assertScope(c, session, {
					type: ref.type,
					authority: ref.authority,
					skey: ref.skey,
					action: "create",
					collection,
				});
				if (scopeError) return scopeError;
			}

			const stub = host.getSpaceDO(ref.uri);
			if (ref.authority === host.operatorDid) {
				// The authority's space must arrive first, via importSpaceMeta.
				await requirePolicy(stub, ref);
			} else {
				await ensureSpaceForWrite(ref, stub);
			}
			await stub.rpcImportRepo(records);

			// Blobs are uploaded separately. Those already staged are promoted
			// now; the rest are claimed by uploadBlob when they arrive.
			const missing = await promoteSpaceBlobs(
				ref,
				Array.from(new Set(records.flatMap((r) => r.blobCids))),
			);
			if (missing.length > 0) {
				await host.getIndexDO().rpcAddPendingBlobs(ref.uri, missing);
			}
			return c.json({});
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
			const mac = await readMac(c, auth, RECORD_MAC_PROFILE);

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
			return c.json(
				{ uri, cid: record.cid, value: recordBytesToJson(record.bytes) },
				200,
				recordMacHeaders(mac, uri, record.cid),
			);
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
			const excludeValues = c.req.query("excludeValues") === "true";
			const after = parseRecordCursor(c.req.query("cursor"));

			const stub = host.getSpaceDO(ref.uri);
			await requireRepoExists(stub, ref);
			const page = await stub.rpcListRecords({
				collection,
				limit,
				after,
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
			const mac = await readMac(c, auth, COMMIT_MAC_PROFILE);
			const stub = host.getSpaceDO(ref.uri);
			await requireRepoExists(stub, ref);
			const state = await stub.rpcGetRepoState();
			if (!state) {
				throw new SpaceError(
					"RepoNotFound",
					`Could not find repo for space: ${ref.uri}`,
				);
			}
			const commit = buildCommit({
				spaceUri: ref.uri,
				repo: host.operatorDid,
				state: { setHash: new Uint8Array(state.setHash), rev: state.rev },
			});
			return c.json(
				{ commit: commitToJson(commit) },
				200,
				commitMacHeaders(mac, commit),
			);
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
			const mac = await readMac(c, auth, COMMIT_MAC_PROFILE);

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
			// Never written: no commit to answer with.
			if (!page.head) {
				throw new SpaceError(
					"RepoNotFound",
					`Could not find repo for space: ${ref.uri}`,
				);
			}
			// The commit, with its MAC, is on every page. A full page carries a
			// cursor, so the last page may be empty.
			const last = page.ops[page.ops.length - 1];
			const cursor =
				last && page.ops.length === limit
					? `${last.rev}/${last.idx}`
					: undefined;
			const commit = buildCommit({
				spaceUri: ref.uri,
				repo: host.operatorDid,
				state: {
					setHash: new Uint8Array(page.head.setHash),
					rev: page.head.rev,
				},
			});
			return c.json(
				{ ops, commit: commitToJson(commit), ...(cursor ? { cursor } : {}) },
				200,
				commitMacHeaders(mac, commit),
			);
		} catch (err) {
			return errorResponse(c, err);
		}
	});

	app.get("/xrpc/com.atproto.space.getRepo", async (c) => {
		try {
			const ref = requireSpaceUri(c.req.query("space"));
			const auth = await readAuth(c, ref, c.req.query("repo"));
			if (auth instanceof Response) return auth;
			const mac = await readMac(c, auth, COMMIT_MAC_PROFILE);

			const stub = host.getSpaceDO(ref.uri);
			await requireRepoExists(stub, ref);

			// The archive streams page by page. Each page reports the repo
			// state it was read at; a page from a later state means a write
			// landed mid-export, and the stream errors rather than serve
			// records that don't match the commit. The syncer's verification
			// would refuse such an archive anyway; failing loudly lets it
			// retry at once.
			const PAGE = 500;
			const first = await stub.rpcListRecordsByPath({ limit: PAGE });
			const state = first.state;
			if (!state) {
				throw new SpaceError(
					"RepoNotFound",
					`Could not find repo for space: ${ref.uri}`,
				);
			}
			const commit = buildCommit({
				spaceUri: ref.uri,
				repo: host.operatorDid,
				state: { setHash: new Uint8Array(state.setHash), rev: state.rev },
			});
			async function* records() {
				let page = first;
				for (;;) {
					for (const record of page.records) {
						yield {
							collection: record.collection as never,
							rkey: record.rkey as never,
							bytes: new Uint8Array(record.bytes),
						};
					}
					const last = page.records[page.records.length - 1];
					if (!page.hasMore || !last) return;
					page = await stub.rpcListRecordsByPath({
						afterPath: `${last.collection}/${last.rkey}`,
						limit: PAGE,
					});
					if (page.state?.rev !== state!.rev) {
						throw new Error("The repo changed during export; retry getRepo");
					}
				}
			}
			const star = writeRepoStar(
				commit as Parameters<typeof writeRepoStar>[0],
				records(),
			);
			return c.body(asyncIterableToStream(star), 200, {
				"Content-Type": STAR_CONTENT_TYPE,
				...commitMacHeaders(mac, commit),
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
			const afterCid = c.req.query("cursor");

			const stub = host.getSpaceDO(ref.uri);
			await requireRepoExists(stub, ref);
			const page = await stub.rpcListBlobs({ limit, afterCid });
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

			const stub = host.getSpaceDO(ref.uri);
			await requireRepoExists(stub, ref);
			// Refuse before touching the blobstore: do not reveal whether an
			// unreferenced blob exists.
			if (!(await stub.rpcHasSpaceBlob(cid!))) {
				throw new SpaceError("BlobNotFound", `Blob not found: ${cid}`);
			}
			if (!host.blobs) {
				return c.json(
					{
						error: "ServiceUnavailable",
						message: "Blob storage is not configured",
					},
					503,
				);
			}
			const key = spaceBlobKey(host.operatorDid, await spaceId(ref.uri), cid!);
			let blob = await host.blobs.get(key);
			if (!blob) {
				// Referenced but never promoted (an imported record whose blob
				// arrived through another path): promote on first read.
				if (
					await promoteStagedBlobToSpace(
						host.blobs,
						host.operatorDid,
						ref.uri,
						cid!,
					)
				) {
					blob = await host.blobs.get(key);
				}
			}
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
					Vary: "Authorization",
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

	app.post("/xrpc/com.atproto.space.authorizeSpaceSync", async (c) => {
		try {
			const body = await c.req.json<{
				space?: string;
				credentialKey?: string;
				delegationToken?: string;
				clientAttestation?: string;
				notify?: unknown;
			}>();
			const ref = requireSpaceUri(body.space);
			requireString(body.credentialKey, "credentialKey");
			if (!isP256DidKey(body.credentialKey!)) {
				throw new SpaceError(
					"InvalidRequest",
					"credentialKey must be a P-256 did:key",
				);
			}
			const notify =
				body.notify === undefined ? undefined : parseNotify(body.notify);

			// Before anything touches the space DO: a space this host doesn't
			// govern must not get one created for it by a well-formed request.
			await assertActiveSpaceHost(ref);
			const stub = host.getSpaceDO(ref.uri);
			const { meta, policy } = await stub.rpcGetAuthorityState();
			// The durable signal that a space is gone: a syncer that missed
			// its deletion notice learns it here, the next time it
			// reauthorises, whatever the request's authorisation.
			if (meta?.deletedAt) {
				throw new SpaceError("SpaceDeleted", `Space deleted: ${ref.uri}`);
			}

			// Absent when the request carries no delegation token, which only
			// a space that does not gate on the account accepts.
			let repo: string | undefined;
			if (body.delegationToken) {
				({ userDid: repo } = await verifyDelegationToken(
					body.delegationToken,
					ref,
					{
						getSigningKey: host.getSigningKey,
						checkReplay: (kind, key, exp) =>
							stub.rpcCheckReplay(kind, key, exp),
					},
				));
			}

			let clientId: string | undefined;
			if (body.clientAttestation) {
				clientId = await verifyClientAttestation(body.clientAttestation, {
					expectedAud: spaceHostAud(ref.authority as `did:${string}:${string}`),
					// Checked pre-verification inside, so a client the space could
					// never authorise never triggers network I/O.
					allowedClientIds:
						policy?.$type === MEMBERSPACE_POLICY
							? policy.allowedApps
							: undefined,
					checkReplay: (kind, key, exp) => stub.rpcCheckReplay(kind, key, exp),
					fetch: host.outboundFetch,
				});
			}

			if (!meta || !policy) {
				throw new SpaceError("SpaceNotFound", `Space not found: ${ref.uri}`);
			}

			try {
				// The account goes first, and one the policy refuses is answered
				// as though the space does not exist, so that a refusal
				// discloses nothing to someone without access to it.
				const authorized = await authorizeRepo({
					policy,
					ref,
					repo,
					access: "read",
					clientId,
					stub,
				});
				if (!authorized) {
					throw new SpaceError("SpaceNotFound", `Space not found: ${ref.uri}`);
				}
				if (!isAppAuthorized(policy, clientId)) {
					throw new SpaceError(
						"AppNotAuthorized",
						"Application not authorized for this space",
					);
				}
			} catch (err) {
				// A refusal withdraws the registration the request carries, so a
				// syncer that has lost access stops being notified. A failure to
				// decide, such as an unreachable managing app, is not a refusal.
				if (notify && parseSpaceErrorCode(err)?.code !== "UpstreamFailure") {
					await stub.rpcRemoveNotifyRegistration(notify);
				}
				throw err;
			}

			if (notify && !(await stub.rpcGetNotifyRegistration(notify))) {
				await confirmRegistration(ref, notify);
			}

			const credential = await createSpaceCredential({
				iss: host.operatorDid as `did:${string}:${string}`,
				sub: ref.uri as never,
				keyId: body.credentialKey as `did:${string}:${string}`,
				keypair: (await host.getKeypair()) as never,
			});

			if (notify) {
				// Renewed by each authorisation, to the credential's expiry, so a
				// syncer that keeps reauthorising stays registered.
				const { exp } = parseSpaceToken("credential", credential).payload;
				await stub.rpcPutNotifyRegistration(notify, exp * 1000);
			}
			// Read after registering, so any update past this revision is
			// notified.
			const spaceRev = await stub.rpcGetSpaceRev();
			return c.json({ credential, ...(spaceRev ? { spaceRev } : {}) });
		} catch (err) {
			return errorResponse(c, err);
		}
	});

	app.get("/xrpc/com.atproto.space.listWriters", async (c) => {
		try {
			const ref = requireSpaceUri(c.req.query("space"));
			await credentialAuth(c, ref);
			await assertActiveSpaceHost(ref);
			const stub = host.getSpaceDO(ref.uri);
			await requirePolicy(stub, ref);
			const limit = clampLimit(c.req.query("limit"), 500, 1000);
			const writers = await stub.rpcListWriters({
				limit,
				cursor: c.req.query("cursor") || undefined,
			});
			const last = writers[writers.length - 1];
			return c.json({
				repos: writers.map((writer) =>
					writer.removed
						? {
								$type: "com.atproto.space.defs#repoRemoved",
								repo: writer.did,
								spaceRev: writer.spaceRev,
							}
						: {
								$type: "com.atproto.space.defs#repoWrite",
								repo: writer.did,
								repoRev: writer.repoRev,
								data: bytesToJson(new Uint8Array(writer.data)),
								spaceRev: writer.spaceRev,
							},
				),
				// Nonempty pages carry a cursor and empty pages omit it.
				...(last ? { cursor: last.spaceRev } : {}),
			});
		} catch (err) {
			return errorResponse(c, err);
		}
	});

	app.post("/xrpc/com.atproto.space.notifyRepoUpdate", async (c) => {
		try {
			const body = await c.req.json<{
				space?: string;
				repo?: string;
				repoRev?: string;
				data?: { $bytes?: string };
			}>();
			const ref = requireSpaceUri(body.space);
			requireString(body.repo, "repo");
			requireString(body.repoRev, "repoRev");
			if (typeof body.data?.$bytes !== "string") {
				throw new SpaceError("InvalidRequest", "Missing data bytes");
			}

			const serviceAuth = await requireServiceAuth(c, NOTIFY_REPO_UPDATE_LXM);
			if (serviceAuth instanceof Response) return serviceAuth;
			// iss is the signer, so requiring it to match keeps a PDS from
			// notifying on another account's behalf.
			if (serviceAuth.iss !== body.repo) {
				throw new SpaceError(
					"Forbidden",
					"notifyRepoUpdate iss does not match the repo",
				);
			}
			if (
				serviceAuth.aud !== ref.authority &&
				serviceAuth.aud !==
					spaceHostAud(ref.authority as `did:${string}:${string}`)
			) {
				throw new SpaceError(
					"Forbidden",
					"notifyRepoUpdate aud does not match the space authority",
				);
			}

			assertSpaceHost(ref);
			let revMs: number;
			try {
				revMs = tidTimestampMs(body.repoRev!);
			} catch {
				throw new SpaceError("InvalidRequest", "repoRev must be a TID");
			}
			if (revMs > Date.now() + MAX_REV_CLOCK_SKEW_MS) {
				throw new SpaceError("FutureRev", "Repo revision is in the future");
			}

			const stub = host.getSpaceDO(ref.uri);
			const policy = await requirePolicy(stub, ref);
			// The same account perimeter used when minting credentials. The
			// notification comes from a PDS rather than an app, so there is no
			// attestation. An unreachable managing app is an UpstreamFailure,
			// which the repo host retries.
			const authorized = await authorizeRepo({
				policy,
				ref,
				repo: body.repo!,
				access: "write",
				stub,
			});
			if (!authorized) {
				throw new SpaceError(
					"Forbidden",
					"Repo is not authorized to write to the space",
				);
			}
			// Sequenced, and queued for registered syncers, in one transaction.
			// A delayed or replayed notification with an older rev changes
			// nothing.
			await stub.rpcRecordWriter(
				body.repo!,
				body.repoRev!,
				fromBase64(body.data.$bytes),
			);
			return c.json({});
		} catch (err) {
			return errorResponse(c, err);
		}
	});

	app.post("/xrpc/com.atproto.space.notifyCredentialsRevoked", async (c) => {
		try {
			const body = await c.req.json<{
				space?: string;
				credentials?: unknown;
			}>();
			const ref = requireSpaceUri(body.space);
			const credentials = body.credentials;
			if (
				!Array.isArray(credentials) ||
				credentials.length < 1 ||
				credentials.length > 100 ||
				credentials.some((jti) => typeof jti !== "string" || jti.length === 0)
			) {
				throw new SpaceError(
					"InvalidRequest",
					"credentials must be 1 to 100 credential jti strings",
				);
			}
			const serviceAuth = await requireServiceAuth(c, CREDENTIALS_REVOKED_LXM);
			if (serviceAuth instanceof Response) return serviceAuth;
			if (serviceAuth.iss !== ref.authority) {
				throw new SpaceError(
					"Forbidden",
					"Revocation issuer is not the space authority",
				);
			}
			// Addressed to the repo DID, which here is always the operator.
			if (serviceAuth.aud !== host.operatorDid) {
				throw new SpaceError(
					"Forbidden",
					"Revocation audience does not match a repo hosted here",
				);
			}
			await host
				.getSpaceDO(ref.uri)
				.rpcRevokeCredentials(
					credentials as string[],
					Math.floor(Date.now() / 1000) + REVOCATION_TTL_SEC,
				);
			return c.json({});
		} catch (err) {
			return errorResponse(c, err);
		}
	});

	// ---------------------------------------------------------------
	// Space management (authority role, session auth)
	// ---------------------------------------------------------------

	app.post("/xrpc/com.atproto.space.createSpace", async (c) => {
		try {
			const body = await c.req.json<{
				spaceType?: string;
				skey?: string;
				policy?: unknown;
			}>();
			requireString(body.spaceType, "spaceType");
			const skey = body.skey ?? tidNow();
			const ref = requireSpaceUri(
				`at://${host.operatorDid}/space/${body.spaceType}/${skey}`,
			);
			const session = await host.authenticate(c);
			if (session instanceof Response) return session;
			const scopeError = assertScope(c, session, {
				type: ref.type,
				authority: host.operatorDid,
				skey: ref.skey,
				manage: "create",
			});
			if (scopeError) return scopeError;
			await assertActiveSpaceHost(ref);
			const policy = normalizePolicy(body.policy);

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
			const commit = await stub.rpcInit({
				uri: ref.uri,
				authority: ref.authority,
				type: ref.type,
				skey: ref.skey,
				isAuthority: true,
				policy,
			});
			await index.rpcActivate(ref.uri);
			afterConfigCommit(c, ref, stub, commit);
			return c.json({ space: ref.uri });
		} catch (err) {
			return errorResponse(c, err);
		}
	});

	app.post("/xrpc/com.atproto.space.updateSpace", async (c) => {
		try {
			const body = await c.req.json<{ space?: string; policy?: unknown }>();
			const ref = requireSpaceUri(body.space);
			const session = await host.authenticate(c);
			if (session instanceof Response) return session;
			const scopeError = assertScope(c, session, {
				type: ref.type,
				authority: ref.authority,
				skey: ref.skey,
				manage: "update",
			});
			if (scopeError) return scopeError;
			assertOwner(ref, session);
			await assertActiveSpaceHost(ref);
			const policy = normalizePolicy(body.policy);
			const stub = host.getSpaceDO(ref.uri);
			const commit = await stub.rpcUpdatePolicy(policy);
			afterConfigCommit(c, ref, stub, commit);
			return c.json({});
		} catch (err) {
			return errorResponse(c, err);
		}
	});

	app.post("/xrpc/com.atproto.space.deleteSpace", async (c) => {
		try {
			const body = await c.req.json<{ space?: string }>();
			const ref = requireSpaceUri(body.space);
			const session = await host.authenticate(c);
			if (session instanceof Response) return session;
			const scopeError = assertScope(c, session, {
				type: ref.type,
				authority: ref.authority,
				skey: ref.skey,
				manage: "delete",
			});
			if (scopeError) return scopeError;
			assertOwner(ref, session);
			await assertActiveSpaceHost(ref);

			const stub = host.getSpaceDO(ref.uri);
			// Credential issuance stops with the tombstone, and every registered
			// syncer, lapsed or not, is queued a deletion notice delivered
			// reliably for 72 hours. Then reap the blob prefix.
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
			return c.json({});
		} catch (err) {
			return errorResponse(c, err);
		}
	});

	app.get("/xrpc/com.atproto.space.getSpace", async (c) => {
		try {
			const ref = requireSpaceUri(c.req.query("space"));
			const session = await host.authenticate(c);
			if (session instanceof Response) return session;
			const scopeError = assertScope(c, session, {
				type: ref.type,
				authority: ref.authority,
				skey: ref.skey,
				action: "read_self",
			});
			if (scopeError) return scopeError;
			assertOwner(ref, session);
			const policy = await requirePolicy(host.getSpaceDO(ref.uri), ref);
			return c.json({ space: ref.uri, policy });
		} catch (err) {
			return errorResponse(c, err);
		}
	});

	app.post("/xrpc/com.atproto.space.removeWriter", async (c) => {
		try {
			const body = await c.req.json<{ space?: string; repo?: string }>();
			const ref = requireSpaceUri(body.space);
			requireDid(body.repo, "repo");
			const session = await host.authenticate(c);
			if (session instanceof Response) return session;
			const scopeError = assertScope(c, session, {
				type: ref.type,
				authority: ref.authority,
				skey: ref.skey,
				manage: "update",
			});
			if (scopeError) return scopeError;
			assertOwner(ref, session);
			await assertActiveSpaceHost(ref);
			// Sequenced and announced to syncers as a repoRemoved.
			await host.getSpaceDO(ref.uri).rpcRemoveWriter(body.repo!);
			return c.json({});
		} catch (err) {
			return errorResponse(c, err);
		}
	});

	app.get("/xrpc/com.atproto.space.exportSpaceMeta", async (c) => {
		try {
			const ref = requireSpaceUri(c.req.query("space"));
			const session = await host.authenticate(c);
			if (session instanceof Response) return session;
			const scopeError = assertScope(c, session, {
				type: ref.type,
				authority: ref.authority,
				skey: ref.skey,
				action: "read_self",
			});
			if (scopeError) return scopeError;
			assertOwner(ref, session);
			const exported = await host.getSpaceDO(ref.uri).rpcExportMeta();
			const star = writeSpaceMetaStar({
				space: ref.uri as never,
				policy: exported.policy as never,
				policyState: exported.members.map((member) => ({
					key: `${MEMBER_COLLECTION}/${didToRecordKey(member.did)}`,
					value: {
						$type: MEMBER_COLLECTION,
						read: member.read,
						write: member.write,
					},
				})),
				writers: exported.writers.map((writer) => ({
					did: writer.did as never,
					repoRev: writer.repoRev,
					data: new Uint8Array(writer.data),
					spaceRev: writer.spaceRev,
				})),
			});
			return c.body(asyncIterableToStream(star), 200, {
				"Content-Type": STAR_CONTENT_TYPE,
			});
		} catch (err) {
			return errorResponse(c, err);
		}
	});

	app.post("/xrpc/com.atproto.space.importSpaceMeta", async (c) => {
		try {
			const session = await host.authenticate(c);
			if (session instanceof Response) return session;
			const bytes = await readBody(c);
			let archive;
			try {
				archive = await readSpaceMetaStar([bytes]);
			} catch (err) {
				throw invalidArchive(err, "InvalidSpaceMeta");
			}
			const ref = requireSpaceUri(archive.space);
			// Importing both creates the space here and sets its configuration.
			for (const manage of ["create", "update"] as const) {
				const scopeError = assertScope(c, session, {
					type: ref.type,
					authority: ref.authority,
					skey: ref.skey,
					manage,
				});
				if (scopeError) return scopeError;
			}
			if (ref.authority !== session.did || ref.authority !== host.operatorDid) {
				throw new SpaceError("NotAuthorized", "Not the space authority");
			}
			const policy = normalizePolicy(archive.policy);
			const members = parsePolicyState(policy, archive.policyState);

			const index = host.getIndexDO();
			await index.rpcRegister({
				uri: ref.uri,
				authority: ref.authority,
				type: ref.type,
				skey: ref.skey,
				isAuthority: true,
			});
			await host.getSpaceDO(ref.uri).rpcImportMeta({
				uri: ref.uri,
				authority: ref.authority,
				type: ref.type,
				skey: ref.skey,
				policy,
				members,
				writers: archive.writers.map((writer) => ({
					did: writer.did,
					repoRev: writer.repoRev,
					data: writer.data,
					spaceRev: writer.spaceRev,
					removed: false,
				})),
			});
			await index.rpcActivate(ref.uri);
			return c.json({});
		} catch (err) {
			return errorResponse(c, err);
		}
	});

	app.get("/xrpc/com.atproto.space.listSpaces", async (c) => {
		try {
			const session = await host.authenticate(c);
			if (session instanceof Response) return session;
			const type = c.req.query("spaceType") || undefined;
			const authority = c.req.query("spaceDid") || undefined;
			// No one space to check against, so the filters are the target:
			// an unfiltered listing needs a wildcard grant. It lists only the
			// caller's own spaces, so read_self is the grant that fits.
			const scopeError = assertScope(c, session, {
				type: type ?? "*",
				authority: authority ?? "*",
				skey: "*",
				action: "read_self",
			});
			if (scopeError) return scopeError;
			const limit = clampLimit(c.req.query("limit"), 50, 100);
			const cursor = c.req.query("cursor") || undefined;
			if (cursor && !parseSpaceUri(cursor)) {
				throw new SpaceError("InvalidCursor", `Malformed cursor: ${cursor}`);
			}
			const page = await host.getIndexDO().rpcList({
				type,
				authority,
				state: "active",
				limit,
				afterUri: cursor,
			});
			// The caller's repo state in each space, and the space's revision
			// where the caller is its authority.
			const spaces = await Promise.all(
				page.spaces.map(async (space) => {
					const view = await host.getSpaceDO(space.uri).rpcGetSpaceView();
					return {
						space: space.uri,
						...(view?.repoRev ? { repoRev: view.repoRev } : {}),
						...(view?.data
							? { data: bytesToJson(new Uint8Array(view.data)) }
							: {}),
						...(view?.spaceRev ? { spaceRev: view.spaceRev } : {}),
					};
				}),
			);
			const last = page.spaces[page.spaces.length - 1];
			return c.json({
				spaces,
				...(page.hasMore && last ? { cursor: last.uri } : {}),
			});
		} catch (err) {
			return errorResponse(c, err);
		}
	});

	// ---------------------------------------------------------------
	// memberspace (authority role, session auth)
	// ---------------------------------------------------------------

	app.post("/xrpc/com.atproto.memberspace.putMembers", async (c) => {
		try {
			const body = await c.req.json<{ space?: string; members?: unknown }>();
			const ref = requireSpaceUri(body.space);
			const members = parseMemberBatch(body.members);
			const session = await host.authenticate(c);
			if (session instanceof Response) return session;
			const scopeError = assertScope(c, session, {
				type: ref.type,
				authority: ref.authority,
				skey: ref.skey,
				manage: "update",
			});
			if (scopeError) return scopeError;
			assertOwner(ref, session);
			await assertActiveSpaceHost(ref);
			const stub = host.getSpaceDO(ref.uri);
			const commit = await stub.rpcPutMembers(members);
			afterConfigCommit(c, ref, stub, commit);
			return c.json({});
		} catch (err) {
			return errorResponse(c, err);
		}
	});

	app.post("/xrpc/com.atproto.memberspace.removeMembers", async (c) => {
		try {
			const body = await c.req.json<{ space?: string; dids?: unknown }>();
			const ref = requireSpaceUri(body.space);
			const dids = body.dids;
			if (
				!Array.isArray(dids) ||
				dids.length > MAX_MEMBER_BATCH ||
				dids.some((did) => typeof did !== "string" || !did.startsWith("did:"))
			) {
				throw new SpaceError(
					"InvalidRequest",
					`dids must be an array of at most ${MAX_MEMBER_BATCH} DIDs`,
				);
			}
			const session = await host.authenticate(c);
			if (session instanceof Response) return session;
			const scopeError = assertScope(c, session, {
				type: ref.type,
				authority: ref.authority,
				skey: ref.skey,
				manage: "update",
			});
			if (scopeError) return scopeError;
			assertOwner(ref, session);
			await assertActiveSpaceHost(ref);
			const stub = host.getSpaceDO(ref.uri);
			const commit = await stub.rpcRemoveMembers(dids as string[]);
			afterConfigCommit(c, ref, stub, commit);
			return c.json({});
		} catch (err) {
			return errorResponse(c, err);
		}
	});

	app.get("/xrpc/com.atproto.memberspace.listMembers", async (c) => {
		try {
			const ref = requireSpaceUri(c.req.query("space"));
			const session = await host.authenticate(c);
			if (session instanceof Response) return session;
			const scopeError = assertScope(c, session, {
				type: ref.type,
				authority: ref.authority,
				skey: ref.skey,
				action: "read_self",
			});
			if (scopeError) return scopeError;
			assertOwner(ref, session);
			const limit = clampLimit(c.req.query("limit"), 100, 1000);
			const page = await host.getSpaceDO(ref.uri).rpcListMembers({
				limit,
				afterDid: c.req.query("cursor"),
			});
			const last = page.members[page.members.length - 1];
			return c.json({
				members: page.members.map((member) => ({
					did: member.did,
					read: member.read,
					write: member.write,
				})),
				...(page.hasMore && last ? { cursor: last.did } : {}),
			});
		} catch (err) {
			return errorResponse(c, err);
		}
	});

	// ---------------------------------------------------------------
	// Helpers that need the host
	// ---------------------------------------------------------------

	/**
	 * Before registering a webhook, check it asked to be: the endpoint must
	 * recognise the token as one it issued for this space and echo back a
	 * random challenge. The endpoint is the requester's choice, so it is
	 * fetched as untrusted: https only, no redirects, bounded in time.
	 */
	async function confirmRegistration(
		ref: SpaceRef,
		notify: NotifyRegistration,
	): Promise<void> {
		const challenge = crypto.randomUUID();
		try {
			const res = await doFetch(
				`${notify.endpoint.replace(/\/$/, "")}/xrpc/${CONFIRM_REGISTRATION_LXM}`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						space: ref.uri,
						token: notify.token,
						challenge,
					}),
					redirect: "manual",
					signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
				},
			);
			if (res.ok) {
				const body = (await res.json()) as { challenge?: unknown };
				if (body.challenge === challenge) return;
			}
		} catch (err) {
			console.warn(`registration for ${ref.uri} not confirmed:`, err);
		}
		throw new SpaceError(
			"RegistrationNotConfirmed",
			"Notify endpoint did not confirm the registration",
		);
	}

	/** Service auth for inbound notifications; a Response on failure. */
	async function requireServiceAuth(
		c: Context,
		lxm: string,
	): Promise<{ iss: string; aud: string } | Response> {
		const authHeader = c.req.header("Authorization");
		if (!authHeader?.startsWith("Bearer ")) {
			return c.json(
				{ error: "AuthenticationRequired", message: "Service auth required" },
				401,
			);
		}
		try {
			return await host.verifyServiceJwt(authHeader.slice(7), lxm);
		} catch (err) {
			return c.json(
				{
					error: "AuthenticationRequired",
					message: err instanceof Error ? err.message : "Invalid service auth",
				},
				401,
			);
		}
	}

	function isOwnAudience(aud: string): boolean {
		return aud === host.operatorDid || aud.startsWith(`${host.operatorDid}#`);
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

function requireString(value: unknown, name: string): asserts value is string {
	if (typeof value !== "string" || value.length === 0) {
		throw new SpaceError(
			"InvalidRequest",
			`Missing required parameter: ${name}`,
		);
	}
}

/**
 * An authorizeSpaceSync `notify`: an https base URL the space host calls
 * XRPC methods against, and the opaque token that authenticates them.
 */
function parseNotify(input: unknown): NotifyRegistration {
	const notify = input as { endpoint?: unknown; token?: unknown } | null;
	const endpoint = notify?.endpoint;
	const token = notify?.token;
	if (typeof endpoint !== "string" || typeof token !== "string") {
		throw new SpaceError(
			"InvalidRequest",
			"notify requires an endpoint and a token",
		);
	}
	let url: URL;
	try {
		url = new URL(endpoint);
	} catch {
		throw new SpaceError("InvalidRequest", "notify endpoint must be a URL");
	}
	if (url.protocol !== "https:" || url.username || url.password) {
		throw new SpaceError(
			"InvalidRequest",
			"notify endpoint must be a plain https URL",
		);
	}
	if (token.length === 0 || token.length > MAX_NOTIFY_TOKEN_LENGTH) {
		throw new SpaceError(
			"InvalidRequest",
			`notify token must be 1 to ${MAX_NOTIFY_TOKEN_LENGTH} characters`,
		);
	}
	return { endpoint, token };
}

function requireDid(value: unknown, name: string): asserts value is string {
	requireString(value, name);
	if (!value.startsWith("did:")) {
		throw new SpaceError("InvalidRequest", `${name} must be a DID`);
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
		throw new SpaceError("InvalidCursor", `Malformed cursor: ${cursor}`);
	}
	return { collection: cursor.slice(0, slash), rkey: cursor.slice(slash + 1) };
}

function parseOpsCursor(
	cursor: string | undefined,
): { rev: string; idx: number } | undefined {
	if (!cursor) return undefined;
	const slash = cursor.indexOf("/");
	const idx = slash === -1 ? NaN : Number.parseInt(cursor.slice(slash + 1), 10);
	if (slash <= 0 || Number.isNaN(idx)) {
		throw new SpaceError("InvalidCursor", `Malformed cursor: ${cursor}`);
	}
	return { rev: cursor.slice(0, slash), idx };
}

/**
 * Read the members out of a space meta archive's policy state. A key the
 * policy doesn't define is refused rather than dropped, since dropping it
 * would quietly change who has access to the space.
 */
function parsePolicyState(
	policy: SpacePolicy,
	entries: Array<{ key: string; value: Record<string, unknown> }>,
): SpaceMember[] {
	const prefix = `${MEMBER_COLLECTION}/`;
	return entries.map(({ key, value }) => {
		const did = key.startsWith(prefix)
			? recordKeyToDid(key.slice(prefix.length))
			: undefined;
		if (policy.$type !== MEMBERSPACE_POLICY || !did?.startsWith("did:")) {
			throw new SpaceError(
				"InvalidRequest",
				`Unrecognized policy state: ${key}`,
			);
		}
		if (typeof value.read !== "boolean" || typeof value.write !== "boolean") {
			throw new SpaceError("InvalidRequest", `Invalid member at ${key}`);
		}
		return { did, read: value.read, write: value.write };
	});
}

/**
 * A malformed archive in a request body is the caller's error, reported
 * under the error name the method declares for it.
 */
function invalidArchive(
	err: unknown,
	code: "InvalidRepoFile" | "InvalidSpaceMeta",
): unknown {
	if (parseSpaceErrorCode(err)) return err;
	return new SpaceError(
		code,
		`Invalid archive: ${err instanceof Error ? err.message : String(err)}`,
	);
}

/** A putMembers batch: at most 100 `{did, read, write}` entries. */
function parseMemberBatch(input: unknown): SpaceMember[] {
	if (!Array.isArray(input) || input.length > MAX_MEMBER_BATCH) {
		throw new SpaceError(
			"InvalidRequest",
			`members must be an array of at most ${MAX_MEMBER_BATCH} entries`,
		);
	}
	return input.map((entry, i) => {
		const member = entry as { did?: unknown; read?: unknown; write?: unknown };
		if (
			typeof member?.did !== "string" ||
			!member.did.startsWith("did:") ||
			typeof member.read !== "boolean" ||
			typeof member.write !== "boolean"
		) {
			throw new SpaceError(
				"InvalidRequest",
				`members[${i}] must be {did, read, write}`,
			);
		}
		return { did: member.did, read: member.read, write: member.write };
	});
}

async function readBody(c: Context): Promise<Uint8Array> {
	const contentType = c.req.header("Content-Type")?.split(";")[0]?.trim();
	if (contentType !== STAR_CONTENT_TYPE) {
		throw new SpaceError(
			"InvalidRequest",
			`Content-Type must be ${STAR_CONTENT_TYPE}`,
		);
	}
	const declared = Number.parseInt(c.req.header("Content-Length") ?? "", 10);
	if (declared > MAX_IMPORT_BYTES) {
		throw new SpaceError("InvalidRequest", "Archive is too large");
	}
	const bytes = new Uint8Array(await c.req.arrayBuffer());
	if (bytes.length === 0) {
		throw new SpaceError("InvalidRequest", "Empty archive");
	}
	if (bytes.length > MAX_IMPORT_BYTES) {
		throw new SpaceError("InvalidRequest", "Archive is too large");
	}
	return bytes;
}

/** A pull-based stream over an async iterable, cancelling it on abort. */
function asyncIterableToStream(
	iterable: AsyncIterable<Uint8Array>,
): ReadableStream<Uint8Array> {
	const iterator = iterable[Symbol.asyncIterator]();
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const { value, done } = await iterator.next();
				if (done) controller.close();
				else controller.enqueue(value);
			} catch (err) {
				controller.error(err);
			}
		},
		async cancel() {
			await iterator.return?.();
		},
	});
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
