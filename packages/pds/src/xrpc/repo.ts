import type { Context } from "hono";
import { isDid } from "@atcute/lexicons/syntax";
import { now as tidNow } from "@atcute/tid";
import { AccountDurableObject } from "../account-do.js";
import type { AppEnv, AuthedAppEnv } from "../types.js";
import {
	InvalidRecordError,
	isRecordAlreadyExistsError,
	validator,
	type ValidationStatus,
} from "../validation.js";
import { detectContentType } from "../format.js";
import { BlobStore } from "../blobs.js";
import { buildScopeChecker, requireScope } from "../middleware/auth.js";

function invalidRecordError(
	c: Context<AuthedAppEnv>,
	err: InvalidRecordError,
	prefix?: string,
): Response {
	return c.json(
		{
			error: "InvalidRecord",
			message: prefix ? `${prefix}: ${err.message}` : err.message,
		},
		400,
	);
}

/**
 * Validate the optional `validate` field from a write request body.
 * Lexicon defines it as `boolean?`; reject anything else so clients can't
 * silently fall through to optimistic mode by sending `"true"` or `1`.
 */
function checkValidateFlag(
	c: Context<AuthedAppEnv>,
	value: unknown,
): boolean | undefined | Response {
	if (value === undefined || typeof value === "boolean") {
		return value;
	}
	return c.json(
		{
			error: "InvalidRequest",
			message: "Parameter 'validate' must be a boolean if provided",
		},
		400,
	);
}

/**
 * Check if an error is an AccountDeactivated error and return appropriate HTTP 403 response.
 * @param c - Hono context for creating the response
 * @param err - The error to check (expected format: "AccountDeactivated: <message>")
 * @returns HTTP 403 Response with AccountDeactivated error type, or null if not a deactivation error
 */
function checkAccountDeactivatedError(
	c: Context<AuthedAppEnv>,
	err: unknown,
): Response | null {
	const message = err instanceof Error ? err.message : String(err);
	if (message.startsWith("AccountDeactivated:")) {
		return c.json(
			{
				error: "AccountDeactivated",
				message:
					"Account is deactivated. Call activateAccount to enable writes.",
			},
			403,
		);
	}
	return null;
}

function checkRecordAlreadyExistsError(
	c: Context<AuthedAppEnv>,
	err: unknown,
): Response | null {
	if (!isRecordAlreadyExistsError(err)) return null;
	// Strip the "RecordAlreadyExistsError: " prefix that Cloudflare DO RPC
	// folds into the wrapper Error's `.message` so the client only sees the
	// rkey identifier, not the internal class name.
	const prefix = "RecordAlreadyExistsError:";
	const message = err.message.startsWith(prefix)
		? err.message.slice(prefix.length).trimStart()
		: err.message;
	return c.json(
		{
			error: "RecordAlreadyExists",
			message,
		},
		409,
	);
}

export async function describeRepo(
	c: Context<AppEnv>,
	accountDO: DurableObjectStub<AccountDurableObject>,
): Promise<Response> {
	const repo = c.req.query("repo");

	if (!repo) {
		return c.json(
			{
				error: "InvalidRequest",
				message: "Missing required parameter: repo",
			},
			400,
		);
	}

	// Validate DID format
	if (!isDid(repo)) {
		return c.json(
			{ error: "InvalidRequest", message: "Invalid DID format" },
			400,
		);
	}

	if (repo !== c.env.DID) {
		return c.json(
			{
				error: "RepoNotFound",
				message: `Repository not found: ${repo}`,
			},
			404,
		);
	}

	const data = await accountDO.rpcDescribeRepo();

	return c.json({
		did: c.env.DID,
		handle: c.env.HANDLE,
		didDoc: {
			"@context": ["https://www.w3.org/ns/did/v1"],
			id: c.env.DID,
			alsoKnownAs: [`at://${c.env.HANDLE}`],
			verificationMethod: [
				{
					id: `${c.env.DID}#atproto`,
					type: "Multikey",
					controller: c.env.DID,
					publicKeyMultibase: c.env.SIGNING_KEY_PUBLIC,
				},
			],
		},
		collections: data.collections,
		handleIsCorrect: true,
	});
}

export async function getRecord(
	c: Context<AppEnv>,
	accountDO: DurableObjectStub<AccountDurableObject>,
): Promise<Response> {
	const repo = c.req.query("repo");
	const collection = c.req.query("collection");
	const rkey = c.req.query("rkey");

	if (!repo || !collection || !rkey) {
		return c.json(
			{
				error: "InvalidRequest",
				message: "Missing required parameters: repo, collection, rkey",
			},
			400,
		);
	}

	// Validate DID format
	if (!isDid(repo)) {
		return c.json(
			{ error: "InvalidRequest", message: "Invalid DID format" },
			400,
		);
	}

	if (repo !== c.env.DID) {
		return c.json(
			{
				error: "RepoNotFound",
				message: `Repository not found: ${repo}`,
			},
			404,
		);
	}

	const result = await accountDO.rpcGetRecord(collection, rkey);

	if (!result) {
		return c.json(
			{
				error: "RecordNotFound",
				message: `Record not found: ${collection}/${rkey}`,
			},
			404,
		);
	}

	return c.json({
		uri: `at://${repo}/${collection}/${rkey}`,
		cid: result.cid,
		value: result.record,
	});
}

export async function listRecords(
	c: Context<AppEnv>,
	accountDO: DurableObjectStub<AccountDurableObject>,
): Promise<Response> {
	const repo = c.req.query("repo");
	const collection = c.req.query("collection");
	const limitStr = c.req.query("limit");
	const cursor = c.req.query("cursor");
	const reverseStr = c.req.query("reverse");

	if (!repo || !collection) {
		return c.json(
			{
				error: "InvalidRequest",
				message: "Missing required parameters: repo, collection",
			},
			400,
		);
	}

	// Validate DID format
	if (!isDid(repo)) {
		return c.json(
			{ error: "InvalidRequest", message: "Invalid DID format" },
			400,
		);
	}

	if (repo !== c.env.DID) {
		return c.json(
			{
				error: "RepoNotFound",
				message: `Repository not found: ${repo}`,
			},
			404,
		);
	}

	const limit = Math.min(limitStr ? Number.parseInt(limitStr, 10) : 50, 100);
	const reverse = reverseStr === "true";

	const result = await accountDO.rpcListRecords(collection, {
		limit,
		cursor,
		reverse,
	});

	return c.json(result);
}

export async function createRecord(
	c: Context<AuthedAppEnv>,
	accountDO: DurableObjectStub<AccountDurableObject>,
): Promise<Response> {
	const body = await c.req.json();
	const { repo, collection, rkey, record, validate } = body;

	if (!repo || !collection || !record) {
		return c.json(
			{
				error: "InvalidRequest",
				message: "Missing required parameters: repo, collection, record",
			},
			400,
		);
	}

	if (repo !== c.env.DID) {
		return c.json(
			{
				error: "InvalidRepo",
				message: `Invalid repository: ${repo}`,
			},
			400,
		);
	}

	const scopeError = requireScope(c, (perms) =>
		perms.assertRepo({ collection, action: "create" }),
	);
	if (scopeError) return scopeError;

	const validateChecked = checkValidateFlag(c, validate);
	if (validateChecked instanceof Response) return validateChecked;

	// Lexicon types rkey as `string?` (omitted = auto-generate). Reject
	// anything else, including `null`, so the contract matches across all
	// three write handlers.
	if (rkey !== undefined && typeof rkey !== "string") {
		return c.json(
			{ error: "InvalidRequest", message: "rkey must be a string" },
			400,
		);
	}

	// Validate against a candidate TID so schemas with restrictive keySchemas
	// (e.g. literal('self')) still reject unrkeyed requests. The DO picks the
	// final rkey when the client didn't supply one, against authoritative MST
	// state, to avoid worker-isolate clockid collisions.
	const candidateRkey = rkey ?? tidNow();

	let validated;
	try {
		validated = validator.validate({
			collection,
			record,
			rkey: candidateRkey,
			validate: validateChecked,
		});
	} catch (err) {
		if (err instanceof InvalidRecordError) return invalidRecordError(c, err);
		throw err;
	}

	try {
		const result = await accountDO.rpcCreateRecord(
			collection,
			rkey,
			validated.record,
			validated.status,
		);
		return c.json(result);
	} catch (err) {
		const deactivatedError = checkAccountDeactivatedError(c, err);
		if (deactivatedError) return deactivatedError;
		const conflictError = checkRecordAlreadyExistsError(c, err);
		if (conflictError) return conflictError;

		throw err;
	}
}

export async function deleteRecord(
	c: Context<AuthedAppEnv>,
	accountDO: DurableObjectStub<AccountDurableObject>,
): Promise<Response> {
	const body = await c.req.json();
	const { repo, collection, rkey } = body;

	if (!repo || !collection || !rkey) {
		return c.json(
			{
				error: "InvalidRequest",
				message: "Missing required parameters: repo, collection, rkey",
			},
			400,
		);
	}

	if (repo !== c.env.DID) {
		return c.json(
			{
				error: "InvalidRepo",
				message: `Invalid repository: ${repo}`,
			},
			400,
		);
	}

	const scopeError = requireScope(c, (perms) =>
		perms.assertRepo({ collection, action: "delete" }),
	);
	if (scopeError) return scopeError;

	try {
		const result = await accountDO.rpcDeleteRecord(collection, rkey);

		if (!result) {
			return c.json(
				{
					error: "RecordNotFound",
					message: `Record not found: ${collection}/${rkey}`,
				},
				404,
			);
		}

		return c.json(result);
	} catch (err) {
		const deactivatedError = checkAccountDeactivatedError(c, err);
		if (deactivatedError) return deactivatedError;

		throw err;
	}
}

export async function putRecord(
	c: Context<AuthedAppEnv>,
	accountDO: DurableObjectStub<AccountDurableObject>,
): Promise<Response> {
	const body = await c.req.json();
	const { repo, collection, rkey, record, validate } = body;

	if (!repo || !collection || !rkey || !record) {
		return c.json(
			{
				error: "InvalidRequest",
				message: "Missing required parameters: repo, collection, rkey, record",
			},
			400,
		);
	}

	if (repo !== c.env.DID) {
		return c.json(
			{
				error: "InvalidRepo",
				message: `Invalid repository: ${repo}`,
			},
			400,
		);
	}

	// putRecord is upsert in atproto — match the upstream PDS convention of
	// requiring just the `update` action; tokens scoped to update can putRecord
	// regardless of whether the rkey already exists.
	const scopeError = requireScope(c, (perms) =>
		perms.assertRepo({ collection, action: "update" }),
	);
	if (scopeError) return scopeError;

	const validateChecked = checkValidateFlag(c, validate);
	if (validateChecked instanceof Response) return validateChecked;

	let validated;
	try {
		validated = validator.validate({
			collection,
			record,
			rkey,
			validate: validateChecked,
		});
	} catch (err) {
		if (err instanceof InvalidRecordError) return invalidRecordError(c, err);
		throw err;
	}

	try {
		const result = await accountDO.rpcPutRecord(
			collection,
			rkey,
			validated.record,
			validated.status,
		);
		return c.json(result);
	} catch (err) {
		const deactivatedError = checkAccountDeactivatedError(c, err);
		if (deactivatedError) return deactivatedError;
		const conflictError = checkRecordAlreadyExistsError(c, err);
		if (conflictError) return conflictError;
		throw err;
	}
}

export async function applyWrites(
	c: Context<AuthedAppEnv>,
	accountDO: DurableObjectStub<AccountDurableObject>,
): Promise<Response> {
	const body = await c.req.json();
	const { repo, writes, validate } = body;

	if (!repo || !writes || !Array.isArray(writes)) {
		return c.json(
			{
				error: "InvalidRequest",
				message: "Missing required parameters: repo, writes",
			},
			400,
		);
	}

	if (repo !== c.env.DID) {
		return c.json(
			{
				error: "InvalidRepo",
				message: `Invalid repository: ${repo}`,
			},
			400,
		);
	}

	if (writes.length > 200) {
		return c.json(
			{
				error: "InvalidRequest",
				message: "Too many writes. Max: 200",
			},
			400,
		);
	}

	const validateChecked = checkValidateFlag(c, validate);
	if (validateChecked instanceof Response) return validateChecked;

	// Build the scope checker once outside the loop — for a 200-write batch
	// this avoids re-parsing the token's scope string on every iteration.
	const checkScope = buildScopeChecker(c);

	// Validate every write up-front so the DO either applies the whole batch
	// or none of it. The reconciled record (with $type filled in) replaces
	// the client-supplied value before being sent to the DO.
	const preparedWrites: Array<{
		$type: string;
		collection: string;
		rkey?: string;
		value?: unknown;
		validationStatus?: ValidationStatus;
	}> = [];

	for (let i = 0; i < writes.length; i++) {
		const write = writes[i];
		const action: "create" | "update" | "delete" | null =
			write.$type === "com.atproto.repo.applyWrites#create"
				? "create"
				: write.$type === "com.atproto.repo.applyWrites#update"
					? "update"
					: write.$type === "com.atproto.repo.applyWrites#delete"
						? "delete"
						: null;
		if (!action || !write.collection) {
			return c.json(
				{
					error: "InvalidRequest",
					message: `Write ${i}: unknown $type or missing collection`,
				},
				400,
			);
		}

		if (checkScope) {
			const scopeError = checkScope((perms) =>
				perms.assertRepo({ collection: write.collection, action }),
			);
			if (scopeError) return scopeError;
		}

		if (action === "delete" || action === "update") {
			if (typeof write.rkey !== "string" || write.rkey.length === 0) {
				return c.json(
					{
						error: "InvalidRequest",
						message: `Write ${i}: ${action} requires rkey`,
					},
					400,
				);
			}
		} else if (write.rkey !== undefined) {
			if (typeof write.rkey !== "string" || write.rkey.length === 0) {
				return c.json(
					{
						error: "InvalidRequest",
						message: `Write ${i}: rkey must be a non-empty string`,
					},
					400,
				);
			}
		}

		if (action === "delete") {
			preparedWrites.push({
				$type: write.$type,
				collection: write.collection,
				rkey: write.rkey,
			});
			continue;
		}

		// Worker validates against a candidate TID so restrictive keySchemas
		// reject unrkeyed creates here. DO picks the final rkey when none
		// was supplied (see rpcApplyWrites collision-retry logic).
		const candidateRkey = write.rkey ?? tidNow();

		try {
			const validated = validator.validate({
				collection: write.collection,
				record: write.value,
				rkey: candidateRkey,
				validate: validateChecked,
			});
			preparedWrites.push({
				$type: write.$type,
				collection: write.collection,
				rkey: write.rkey,
				value: validated.record,
				validationStatus: validated.status,
			});
		} catch (err) {
			if (err instanceof InvalidRecordError) {
				return invalidRecordError(c, err, `Write ${i}`);
			}
			throw err;
		}
	}

	try {
		const result = await accountDO.rpcApplyWrites(preparedWrites);
		return c.json(result);
	} catch (err) {
		const deactivatedError = checkAccountDeactivatedError(c, err);
		if (deactivatedError) return deactivatedError;
		const conflictError = checkRecordAlreadyExistsError(c, err);
		if (conflictError) return conflictError;
		throw err;
	}
}

export async function uploadBlob(
	c: Context<AuthedAppEnv>,
	accountDO: DurableObjectStub<AccountDurableObject>,
): Promise<Response> {
	let contentType = c.req.header("Content-Type");
	// Normalise MIME for scope matching: strip parameters (e.g.
	// `image/png; charset=utf-8`) and lowercase. `@atproto/oauth-scopes`
	// validates parameterised values and matches case-sensitively, but MIME
	// types are case-insensitive per RFC 9110 §8.3.1.
	const mimeOf = (ct: string) => ct.split(";")[0]!.trim().toLowerCase();

	// Optimistic pre-buffer gate: if the caller declared a Content-Type,
	// reject obviously-mismatched scopes before reading the (up to 60 MB)
	// body. This is bandwidth-saving only — a lying client can still trick
	// it by declaring a permitted type, so the authoritative scope check
	// runs post-buffer against the detected MIME below.
	if (contentType && contentType !== "*/*") {
		const declared = mimeOf(contentType);
		const preCheck = requireScope(c, (perms) =>
			perms.assertBlob({ mime: declared }),
		);
		if (preCheck) return preCheck;
	}

	const bytes = new Uint8Array(await c.req.arrayBuffer());
	const detected = detectContentType(bytes);
	// Authoritative scope check uses the sniffed MIME when available so a
	// client can't bypass `blob:image/*` by labelling JS bytes as image/png.
	// If detection fails, fall back to the declared header (or octet-stream).
	const effective =
		detected ??
		(contentType && contentType !== "*/*"
			? mimeOf(contentType)
			: "application/octet-stream");
	const postCheck = requireScope(c, (perms) =>
		perms.assertBlob({ mime: effective }),
	);
	if (postCheck) return postCheck;
	contentType = effective;

	// Size limit check (60MB)
	const MAX_BLOB_SIZE = 60 * 1024 * 1024;
	if (bytes.length > MAX_BLOB_SIZE) {
		return c.json(
			{
				error: "BlobTooLarge",
				message: `Blob size ${bytes.length} exceeds maximum of ${MAX_BLOB_SIZE} bytes`,
			},
			400,
		);
	}

	if (!c.env.BLOBS) {
		return c.json(
			{
				error: "ServiceUnavailable",
				message: "Blob storage is not configured",
			},
			503,
		);
	}

	// Store the blob from the stateless Worker, not the DO. The DO is
	// single-threaded and holds the relay's firehose WebSocket; awaiting an
	// R2 put inside it (R2 latency is independent of object size) pins the
	// input gate, and Cloudflare resets the object when a storage op times
	// out, dropping the firehose and desyncing the relay. The DO only
	// records the tracking metadata. This mirrors sync.getBlob.
	const blobStore = new BlobStore(c.env.BLOBS, c.env.DID);
	const blobRef = await blobStore.putBlob(bytes, contentType);
	await accountDO.rpcTrackBlob(
		blobRef.ref.$link,
		blobRef.size,
		blobRef.mimeType,
	);
	return c.json({ blob: blobRef });
}

export async function importRepo(
	c: Context<AuthedAppEnv>,
	accountDO: DurableObjectStub<AccountDurableObject>,
): Promise<Response> {
	const contentType = c.req.header("Content-Type");

	// Verify content type
	if (contentType !== "application/vnd.ipld.car") {
		return c.json(
			{
				error: "InvalidRequest",
				message:
					"Content-Type must be application/vnd.ipld.car for repository import",
			},
			400,
		);
	}

	// Get CAR file bytes
	const carBytes = new Uint8Array(await c.req.arrayBuffer());

	if (carBytes.length === 0) {
		return c.json(
			{
				error: "InvalidRequest",
				message: "Empty CAR file",
			},
			400,
		);
	}

	// Size limit check (100MB for repo imports)
	const MAX_CAR_SIZE = 100 * 1024 * 1024;
	if (carBytes.length > MAX_CAR_SIZE) {
		return c.json(
			{
				error: "RepoTooLarge",
				message: `Repository size ${carBytes.length} exceeds maximum of ${MAX_CAR_SIZE} bytes`,
			},
			400,
		);
	}

	try {
		const result = await accountDO.rpcImportRepo(carBytes);
		return c.json(result);
	} catch (err) {
		if (err instanceof Error) {
			if (err.message.includes("already exists")) {
				return c.json(
					{
						error: "RepoAlreadyExists",
						message:
							"Repository already exists. Cannot import over existing data.",
					},
					409,
				);
			}
			if (err.message.includes("DID mismatch")) {
				return c.json(
					{
						error: "InvalidRepo",
						message: err.message,
					},
					400,
				);
			}
			if (
				err.message.includes("no roots") ||
				err.message.includes("no blocks") ||
				err.message.includes("Invalid root")
			) {
				return c.json(
					{
						error: "InvalidRepo",
						message: `Invalid CAR file: ${err.message}`,
					},
					400,
				);
			}
		}
		throw err;
	}
}

/**
 * List blobs that are referenced in records but not yet imported.
 * Used during migration to track which blobs still need to be uploaded.
 */
export async function listMissingBlobs(
	c: Context<AuthedAppEnv>,
	accountDO: DurableObjectStub<AccountDurableObject>,
): Promise<Response> {
	const limitStr = c.req.query("limit");
	const cursor = c.req.query("cursor");

	const limit = limitStr ? Math.min(Number.parseInt(limitStr, 10), 500) : 500;

	const result = await accountDO.rpcListMissingBlobs(
		limit,
		cursor || undefined,
	);

	return c.json(result);
}
