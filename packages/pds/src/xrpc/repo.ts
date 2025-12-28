import type { Context } from "hono";
import { AtUri, ensureValidDid } from "@atproto/syntax";
import { AccountDurableObject } from "../account-do";
import { validator } from "../validation";

function invalidRecordError(
	c: Context<{ Bindings: Env }>,
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

export async function describeRepo(
	c: Context<{ Bindings: Env }>,
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
	try {
		ensureValidDid(repo);
	} catch (err) {
		return c.json(
			{
				error: "InvalidRequest",
				message: `Invalid DID format: ${err instanceof Error ? err.message : String(err)}`,
			},
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
	c: Context<{ Bindings: Env }>,
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
	try {
		ensureValidDid(repo);
	} catch (err) {
		return c.json(
			{
				error: "InvalidRequest",
				message: `Invalid DID format: ${err instanceof Error ? err.message : String(err)}`,
			},
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
		uri: AtUri.make(repo, collection, rkey).toString(),
		cid: result.cid,
		value: result.record,
	});
}

export async function listRecords(
	c: Context<{ Bindings: Env }>,
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
	try {
		ensureValidDid(repo);
	} catch (err) {
		return c.json(
			{
				error: "InvalidRequest",
				message: `Invalid DID format: ${err instanceof Error ? err.message : String(err)}`,
			},
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
	c: Context<{ Bindings: Env }>,
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

	const result = await accountDO.rpcCreateRecord(collection, rkey, record);

	return c.json(result);
}

export async function deleteRecord(
	c: Context<{ Bindings: Env }>,
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
}

export async function putRecord(
	c: Context<{ Bindings: Env }>,
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
	c: Context<{ Bindings: Env }>,
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
	c: Context<{ Bindings: Env }>,
	accountDO: DurableObjectStub<AccountDurableObject>,
): Promise<Response> {
	const contentType =
		c.req.header("Content-Type") || "application/octet-stream";
	const bytes = new Uint8Array(await c.req.arrayBuffer());

	// Size limit check (5MB)
	const MAX_BLOB_SIZE = 5 * 1024 * 1024;
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
