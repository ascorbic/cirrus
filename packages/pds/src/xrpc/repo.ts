import type { Context } from "hono";
import { isDid } from "@atcute/lexicons/syntax";
import { AccountDurableObject } from "../account-do";
import type { AppEnv, AuthedAppEnv } from "../types";
import { validator } from "../validation";

function invalidRecordError(
	c: Context<AuthedAppEnv>,
	err: unknown,
	prefix?: string,
): Response {
	const message = err instanceof Error ? err.message : String(err);
	return c.json(
		{
			error: "InvalidRecord",
			message: prefix ? `${prefix}: ${message}` : message,
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
	const { repo, collection, rkey, record } = body;

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

	// Validate record against lexicon schema
	try {
		validator.validateRecord(collection, record);
	} catch (err) {
		return invalidRecordError(c, err);
	}

	try {
		const result = await accountDO.rpcCreateRecord(collection, rkey, record);
		return c.json(result);
	} catch (err) {
		const deactivatedError = checkAccountDeactivatedError(c, err);
		if (deactivatedError) return deactivatedError;

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
	const { repo, collection, rkey, record } = body;

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

	// Validate record against lexicon schema
	try {
		validator.validateRecord(collection, record);
	} catch (err) {
		return invalidRecordError(c, err);
	}

	try {
		const result = await accountDO.rpcPutRecord(collection, rkey, record);
		return c.json(result);
	} catch (err) {
		const deactivatedError = checkAccountDeactivatedError(c, err);
		if (deactivatedError) return deactivatedError;

		return c.json(
			{
				error: "InvalidRequest",
				message: err instanceof Error ? err.message : String(err),
			},
			400,
		);
	}
}

export async function applyWrites(
	c: Context<AuthedAppEnv>,
	accountDO: DurableObjectStub<AccountDurableObject>,
): Promise<Response> {
	const body = await c.req.json();
	const { repo, writes } = body;

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

	// Validate all records in create and update operations
	for (let i = 0; i < writes.length; i++) {
		const write = writes[i];
		if (
			write.$type === "com.atproto.repo.applyWrites#create" ||
			write.$type === "com.atproto.repo.applyWrites#update"
		) {
			try {
				validator.validateRecord(write.collection, write.value);
			} catch (err) {
				return invalidRecordError(c, err, `Write ${i}`);
			}
		}
	}

	try {
		const result = await accountDO.rpcApplyWrites(writes);
		return c.json(result);
	} catch (err) {
		const deactivatedError = checkAccountDeactivatedError(c, err);
		if (deactivatedError) return deactivatedError;

		return c.json(
			{
				error: "InvalidRequest",
				message: err instanceof Error ? err.message : String(err),
			},
			400,
		);
	}
}

export async function uploadBlob(
	c: Context<AuthedAppEnv>,
	accountDO: DurableObjectStub<AccountDurableObject>,
): Promise<Response> {
	const contentType =
		c.req.header("Content-Type") || "application/octet-stream";
	const bytes = new Uint8Array(await c.req.arrayBuffer());

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

	try {
		const blobRef = await accountDO.rpcUploadBlob(bytes, contentType);
		return c.json({ blob: blobRef });
	} catch (err) {
		if (
			err instanceof Error &&
			err.message.includes("Blob storage not configured")
		) {
			return c.json(
				{
					error: "ServiceUnavailable",
					message: "Blob storage is not configured",
				},
				503,
			);
		}
		throw err;
	}
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
