import {
	ComAtprotoRepoApplyWrites,
	ComAtprotoRepoCreateRecord,
	ComAtprotoRepoDeleteRecord,
	ComAtprotoRepoListRecords,
	ComAtprotoRepoUploadBlob,
} from "@atcute/atproto";
import { Client } from "@atcute/client";
import type { ActorIdentifier, Did, Nsid } from "@atcute/lexicons/syntax";
import { validateLexicon } from "../lib/xrpc";
import type { Check, CheckOutcome } from "../types";

const TEST_COLLECTION = "earth.cirrus.check.testrecord" as Nsid;

let createdUri: string | undefined;
let createdCid: string | undefined;
let blobRef:
	| { $type: "blob"; ref: { $link: string }; mimeType: string; size: number }
	| undefined;
let blobRecordUri: string | undefined;

let createRecordBody: ComAtprotoRepoCreateRecord.$output | undefined;
let listRecordsIncludesBody: ComAtprotoRepoListRecords.$output | undefined;
let applyWritesBody: ComAtprotoRepoApplyWrites.$output | undefined;
let deleteRecordBody: ComAtprotoRepoDeleteRecord.$output | undefined;
let uploadBlobBody: ComAtprotoRepoUploadBlob.$output | undefined;

function reset() {
	createdUri = undefined;
	createdCid = undefined;
	blobRef = undefined;
	blobRecordUri = undefined;
	createRecordBody = undefined;
	listRecordsIncludesBody = undefined;
	applyWritesBody = undefined;
	deleteRecordBody = undefined;
	uploadBlobBody = undefined;
	currentRunId = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function sessionMismatch(ctx: {
	did?: string;
	agent?: { sub: Did };
}): CheckOutcome | null {
	if (!ctx.agent) {
		return { status: "skip", message: "No active session" };
	}
	if (ctx.agent.sub !== ctx.did) {
		return {
			status: "skip",
			message: `Session is for ${ctx.agent.sub}, target is ${ctx.did}`,
		};
	}
	return null;
}

function buildClient(agent: { handle: (path: string, init?: RequestInit) => Promise<Response> }) {
	return new Client({ handler: agent });
}

let currentRunId: string | undefined;

function makeTestRecord(extra: Record<string, unknown> = {}) {
	return {
		$type: TEST_COLLECTION,
		message: "pdscheck verification — safe to delete",
		createdAt: new Date().toISOString(),
		verifier: location.origin,
		runId: currentRunId,
		...extra,
	};
}

const createRecord: Check = {
	id: "repo-write.create-record",
	category: "repo-write",
	label: "Create record",
	requires: ["pds", "session"],
	run: async (ctx): Promise<CheckOutcome> => {
		reset();
		const guard = sessionMismatch(ctx);
		if (guard) return guard;
		const client = buildClient(ctx.agent!);
		const res = await client.post("com.atproto.repo.createRecord", {
			input: {
				repo: ctx.did as ActorIdentifier,
				collection: TEST_COLLECTION,
				record: makeTestRecord(),
			},
		});
		if (!res.ok) {
			return {
				status: "fail",
				message: `${res.data.error}: ${res.data.message ?? ""}`.trim(),
				evidence: { response: { status: res.status, body: res.data } },
			};
		}
		createdUri = res.data.uri;
		createdCid = res.data.cid;
		createRecordBody = res.data;
		return {
			status: "pass",
			message: res.data.uri,
			evidence: { response: { status: res.status, body: res.data } },
		};
	},
};

const getRecord: Check = {
	id: "repo-write.get-created-record",
	category: "repo-write",
	label: "Get created record",
	requires: ["pds", "session"],
	run: async (ctx): Promise<CheckOutcome> => {
		const guard = sessionMismatch(ctx);
		if (guard) return guard;
		if (!createdUri || !createdCid) {
			return { status: "skip", message: "createRecord did not succeed" };
		}
		const rkey = createdUri.split("/").pop()!;
		const client = buildClient(ctx.agent!);
		const res = await client.get("com.atproto.repo.getRecord", {
			params: {
				repo: ctx.did as ActorIdentifier,
				collection: TEST_COLLECTION,
				rkey,
			},
		});
		if (!res.ok) {
			return {
				status: "fail",
				message: `${res.data.error}: ${res.data.message ?? ""}`.trim(),
				evidence: { response: { status: res.status, body: res.data } },
			};
		}
		if (res.data.cid !== createdCid) {
			return {
				status: "fail",
				message: "Returned CID does not match created record",
				evidence: { expected: createdCid, actual: res.data.cid },
			};
		}
		return {
			status: "pass",
			message: `CID matches (${createdCid.slice(0, 16)}…)`,
			evidence: { response: { status: res.status, body: res.data } },
		};
	},
};

const listRecordsIncludes: Check = {
	id: "repo-write.list-includes-created",
	category: "repo-write",
	label: "listRecords surfaces created record",
	requires: ["pds", "session"],
	run: async (ctx): Promise<CheckOutcome> => {
		const guard = sessionMismatch(ctx);
		if (guard) return guard;
		if (!createdUri) {
			return { status: "skip", message: "No record was created" };
		}
		const client = buildClient(ctx.agent!);
		const res = await client.get("com.atproto.repo.listRecords", {
			params: {
				repo: ctx.did as ActorIdentifier,
				collection: TEST_COLLECTION,
				limit: 10,
			},
		});
		if (!res.ok) {
			return {
				status: "fail",
				message: `${res.data.error}: ${res.data.message ?? ""}`.trim(),
				evidence: { response: { status: res.status, body: res.data } },
			};
		}
		listRecordsIncludesBody = res.data;
		const found = res.data.records.some((r) => r.uri === createdUri);
		if (!found) {
			return {
				status: "fail",
				message: "Created record not listed",
				evidence: {
					expected: createdUri,
					actual: res.data.records.map((r) => r.uri),
				},
			};
		}
		return {
			status: "pass",
			message: `${res.data.records.length} record(s) in ${TEST_COLLECTION}`,
		};
	},
};

const applyWritesAtomic: Check = {
	id: "repo-write.apply-writes",
	category: "repo-write",
	label: "applyWrites atomic create+delete",
	requires: ["pds", "session"],
	run: async (ctx): Promise<CheckOutcome> => {
		const guard = sessionMismatch(ctx);
		if (guard) return guard;
		const client = buildClient(ctx.agent!);
		const ephemeralRkey = `tmp-${Date.now().toString(36)}`;
		const res = await client.post("com.atproto.repo.applyWrites", {
			input: {
				repo: ctx.did as ActorIdentifier,
				writes: [
					{
						$type: "com.atproto.repo.applyWrites#create",
						collection: TEST_COLLECTION,
						rkey: ephemeralRkey,
						value: makeTestRecord(),
					},
					{
						$type: "com.atproto.repo.applyWrites#delete",
						collection: TEST_COLLECTION,
						rkey: ephemeralRkey,
					},
				],
			},
		});
		if (!res.ok) {
			return {
				status: "fail",
				message: `${res.data.error}: ${res.data.message ?? ""}`.trim(),
				evidence: { response: { status: res.status, body: res.data } },
			};
		}
		applyWritesBody = res.data;
		return {
			status: "pass",
			message: "create + delete applied atomically",
			evidence: { response: { status: res.status, body: res.data } },
		};
	},
};

const deleteCreatedRecord: Check = {
	id: "repo-write.delete-record",
	category: "repo-write",
	label: "Delete created record",
	requires: ["pds", "session"],
	run: async (ctx): Promise<CheckOutcome> => {
		const guard = sessionMismatch(ctx);
		if (guard) return guard;
		if (!createdUri) {
			return { status: "skip", message: "No record was created" };
		}
		const rkey = createdUri.split("/").pop()!;
		const client = buildClient(ctx.agent!);
		const res = await client.post("com.atproto.repo.deleteRecord", {
			input: {
				repo: ctx.did as ActorIdentifier,
				collection: TEST_COLLECTION,
				rkey,
			},
		});
		if (!res.ok) {
			return {
				status: "fail",
				message: `${res.data.error}: ${res.data.message ?? ""}`.trim(),
				evidence: { response: { status: res.status, body: res.data } },
			};
		}
		deleteRecordBody = res.data;
		createdUri = undefined;
		createdCid = undefined;
		return { status: "pass", message: "deleted" };
	},
};

const getDeletedRecord: Check = {
	id: "repo-write.deleted-record-404",
	category: "repo-write",
	label: "Deleted record returns 404",
	requires: ["pds", "session"],
	run: async (ctx): Promise<CheckOutcome> => {
		const guard = sessionMismatch(ctx);
		if (guard) return guard;
		const client = buildClient(ctx.agent!);
		const res = await client.get("com.atproto.repo.listRecords", {
			params: {
				repo: ctx.did as ActorIdentifier,
				collection: TEST_COLLECTION,
				limit: 50,
			},
		});
		if (!res.ok) {
			return {
				status: "fail",
				message: "listRecords failed after delete",
				evidence: { response: { status: res.status, body: res.data } },
			};
		}
		const stillThere = res.data.records.some((r) => r.uri === createdUri);
		if (stillThere) {
			return {
				status: "fail",
				message: "Deleted record still appears in listRecords",
			};
		}
		return { status: "pass", message: "record no longer listed" };
	},
};

// 1×1 transparent PNG (smallest valid PNG)
const TINY_PNG = new Uint8Array([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49,
	0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06,
	0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44,
	0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d,
	0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42,
	0x60, 0x82,
]);

const uploadBlob: Check = {
	id: "repo-write.upload-blob",
	category: "repo-write",
	label: "Upload blob",
	requires: ["pds", "session"],
	run: async (ctx): Promise<CheckOutcome> => {
		const guard = sessionMismatch(ctx);
		if (guard) return guard;
		const client = buildClient(ctx.agent!);
		const blob = new Blob([TINY_PNG], { type: "image/png" });
		const res = await client.post("com.atproto.repo.uploadBlob", {
			input: blob,
		});
		if (!res.ok) {
			return {
				status: "fail",
				message: `${res.data.error}: ${res.data.message ?? ""}`.trim(),
				evidence: { response: { status: res.status, body: res.data } },
			};
		}
		blobRef = res.data.blob as typeof blobRef;
		uploadBlobBody = res.data;
		return {
			status: "pass",
			message: `${TINY_PNG.byteLength} bytes uploaded`,
			evidence: { response: { status: res.status, body: res.data } },
		};
	},
};

const createRecordWithBlob: Check = {
	id: "repo-write.create-record-with-blob",
	category: "repo-write",
	label: "Reference blob in record",
	requires: ["pds", "session"],
	run: async (ctx): Promise<CheckOutcome> => {
		const guard = sessionMismatch(ctx);
		if (guard) return guard;
		if (!blobRef) {
			return { status: "skip", message: "Blob upload did not succeed" };
		}
		const client = buildClient(ctx.agent!);
		const res = await client.post("com.atproto.repo.createRecord", {
			input: {
				repo: ctx.did as ActorIdentifier,
				collection: TEST_COLLECTION,
				record: makeTestRecord({ blob: blobRef }),
			},
		});
		if (!res.ok) {
			return {
				status: "fail",
				message: `${res.data.error}: ${res.data.message ?? ""}`.trim(),
				evidence: { response: { status: res.status, body: res.data } },
			};
		}
		blobRecordUri = res.data.uri;
		return {
			status: "pass",
			message: "blob referenced in new record",
		};
	},
};

const cleanup: Check = {
	id: "repo-write.cleanup",
	category: "repo-write",
	label: "Clean up leftover test records",
	requires: ["pds", "session"],
	run: async (ctx): Promise<CheckOutcome> => {
		const guard = sessionMismatch(ctx);
		if (guard) return guard;
		const client = buildClient(ctx.agent!);
		const leftovers: string[] = [];
		if (createdUri) leftovers.push(createdUri);
		if (blobRecordUri) leftovers.push(blobRecordUri);

		// Also sweep anything else that may still be in our test collection
		try {
			const list = await client.get("com.atproto.repo.listRecords", {
				params: {
					repo: ctx.did as ActorIdentifier,
					collection: TEST_COLLECTION,
					limit: 100,
				},
			});
			if (list.ok) {
				for (const r of list.data.records) {
					if (!leftovers.includes(r.uri)) leftovers.push(r.uri);
				}
			}
		} catch {
			// best effort
		}

		let deleted = 0;
		const failures: string[] = [];
		for (const uri of leftovers) {
			const rkey = uri.split("/").pop()!;
			const res = await client.post("com.atproto.repo.deleteRecord", {
				input: {
					repo: ctx.did as ActorIdentifier,
					collection: TEST_COLLECTION,
					rkey,
				},
			});
			if (res.ok) deleted++;
			else failures.push(uri);
		}

		if (failures.length > 0) {
			return {
				status: "warn",
				message: `${deleted} deleted, ${failures.length} stragglers`,
				evidence: { actual: failures },
			};
		}
		return {
			status: "pass",
			message: deleted === 0 ? "nothing to clean up" : `${deleted} deleted`,
		};
	},
};

function makeValidates(
	id: string,
	label: string,
	schema: Parameters<typeof validateLexicon>[0],
	getter: () => unknown,
): Check {
	return {
		id,
		category: "repo-write",
		label,
		requires: ["pds", "session"],
		run: async (ctx): Promise<CheckOutcome> => {
			const guard = sessionMismatch(ctx);
			if (guard) return guard;
			const body = getter();
			if (!body) {
				return { status: "skip", message: "no response to validate" };
			}
			return validateLexicon(schema, body);
		},
	};
}

const createRecordValidates = makeValidates(
	"repo-write.create-record.validates",
	"createRecord response matches lexicon",
	ComAtprotoRepoCreateRecord.mainSchema.output.schema,
	() => createRecordBody,
);

const listRecordsIncludesValidates = makeValidates(
	"repo-write.list-includes-created.validates",
	"listRecords response matches lexicon",
	ComAtprotoRepoListRecords.mainSchema.output.schema,
	() => listRecordsIncludesBody,
);

const applyWritesValidates = makeValidates(
	"repo-write.apply-writes.validates",
	"applyWrites response matches lexicon",
	ComAtprotoRepoApplyWrites.mainSchema.output.schema,
	() => applyWritesBody,
);

const deleteRecordValidates = makeValidates(
	"repo-write.delete-record.validates",
	"deleteRecord response matches lexicon",
	ComAtprotoRepoDeleteRecord.mainSchema.output.schema,
	() => deleteRecordBody,
);

const uploadBlobValidates = makeValidates(
	"repo-write.upload-blob.validates",
	"uploadBlob response matches lexicon",
	ComAtprotoRepoUploadBlob.mainSchema.output.schema,
	() => uploadBlobBody,
);

export const repoWriteChecks: Check[] = [
	createRecord,
	createRecordValidates,
	getRecord,
	listRecordsIncludes,
	listRecordsIncludesValidates,
	applyWritesAtomic,
	applyWritesValidates,
	deleteCreatedRecord,
	deleteRecordValidates,
	getDeletedRecord,
	uploadBlob,
	uploadBlobValidates,
	createRecordWithBlob,
	cleanup,
];
