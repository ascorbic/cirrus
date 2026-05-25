import {
	ComAtprotoRepoDescribeRepo,
	ComAtprotoRepoGetRecord,
	ComAtprotoRepoListRecords,
} from "@atcute/atproto";
import { Client, simpleFetchHandler } from "@atcute/client";
import type { Did, Nsid } from "@atcute/lexicons/syntax";
import { CarReader } from "@ipld/car";
import { validateLexicon } from "../lib/xrpc";
import type { Check, CheckOutcome } from "../types";

let cachedClient: { pds: string; client: Client } | undefined;

function getClient(pds: string): Client {
	if (cachedClient && cachedClient.pds === pds) return cachedClient.client;
	const client = new Client({ handler: simpleFetchHandler({ service: pds }) });
	cachedClient = { pds, client };
	return client;
}

interface SampledRecord {
	collection: string;
	uri: string;
	cid: string;
	rkey: string;
}

let collections: string[] | undefined;
let sampleRecord: SampledRecord | undefined;
let listRecordsEmpty = false;
let describeRepoBody: ComAtprotoRepoDescribeRepo.$output | undefined;
let listRecordsBody: ComAtprotoRepoListRecords.$output | undefined;
let getRecordBody: ComAtprotoRepoGetRecord.$output | undefined;
let repoCarBytes: Uint8Array | undefined;

function xrpcUrl(pds: string, nsid: string, params: Record<string, string>): string {
	const qs = new URLSearchParams(params).toString();
	return `${pds}/xrpc/${nsid}${qs ? `?${qs}` : ""}`;
}

function rkeyFromUri(uri: string): string {
	const parts = uri.split("/");
	return parts[parts.length - 1] ?? "";
}

const describeRepo: Check = {
	id: "repo-read.describe-repo",
	category: "repo-read",
	label: "Describe repo",
	requires: ["pds", "did"],
	run: async (ctx): Promise<CheckOutcome> => {
		collections = undefined;
		sampleRecord = undefined;
		listRecordsEmpty = false;
		describeRepoBody = undefined;
		listRecordsBody = undefined;
		getRecordBody = undefined;
		repoCarBytes = undefined;

		const pds = ctx.pds!;
		const did = ctx.did!;
		const url = xrpcUrl(pds, "com.atproto.repo.describeRepo", { repo: did });
		try {
			const res = await getClient(pds).get("com.atproto.repo.describeRepo", {
				params: { repo: did as Did },
			});
			if (!res.ok) {
				return {
					status: "fail",
					message: `${res.status} ${res.data.error}: ${res.data.message ?? ""}`.trim(),
					evidence: {
						request: { method: "GET", url },
						response: { status: res.status, body: res.data },
					},
				};
			}
			const body = res.data;
			if (body.did !== did) {
				return {
					status: "fail",
					message: `DID mismatch: expected ${did}, got ${body.did}`,
					evidence: {
						request: { method: "GET", url },
						response: { status: res.status, body },
						expected: did,
						actual: body.did,
					},
				};
			}
			if (!Array.isArray(body.collections) || typeof body.handle !== "string") {
				return {
					status: "fail",
					message: "Response missing handle or collections",
					evidence: {
						request: { method: "GET", url },
						response: { status: res.status, body },
					},
				};
			}
			collections = body.collections;
			describeRepoBody = body;
			return {
				status: "pass",
				message: `handle ${body.handle}, ${body.collections.length} collections`,
				evidence: {
					request: { method: "GET", url },
					response: { status: res.status, body },
				},
			};
		} catch (error) {
			return {
				status: "fail",
				message: error instanceof Error ? error.message : String(error),
				evidence: {
					request: { method: "GET", url },
					error: String(error),
				},
			};
		}
	},
};

const listCollections: Check = {
	id: "repo-read.list-collections",
	category: "repo-read",
	label: "List collections",
	requires: ["pds", "did"],
	run: async (): Promise<CheckOutcome> => {
		if (collections === undefined) {
			return { status: "skip", message: "describeRepo did not succeed" };
		}
		if (collections.length === 0) {
			return {
				status: "warn",
				message: "No collections (empty or new repo)",
				evidence: { actual: collections },
			};
		}
		return {
			status: "pass",
			message: `${collections.length}: ${collections.slice(0, 4).join(", ")}${collections.length > 4 ? "…" : ""}`,
			evidence: { actual: collections },
		};
	},
};

const listRecords: Check = {
	id: "repo-read.list-records",
	category: "repo-read",
	label: "List records",
	requires: ["pds", "did"],
	run: async (ctx): Promise<CheckOutcome> => {
		const pds = ctx.pds!;
		const did = ctx.did!;
		const collection =
			collections && collections.length > 0 ? collections[0]! : "app.bsky.feed.post";
		const url = xrpcUrl(pds, "com.atproto.repo.listRecords", {
			repo: did,
			collection,
			limit: "5",
		});
		try {
			const res = await getClient(pds).get("com.atproto.repo.listRecords", {
				params: { repo: did as Did, collection: collection as Nsid, limit: 5 },
			});
			if (!res.ok) {
				return {
					status: "fail",
					message: `${res.status} ${res.data.error}: ${res.data.message ?? ""}`.trim(),
					evidence: {
						request: { method: "GET", url },
						response: { status: res.status, body: res.data },
					},
				};
			}
			const records = res.data.records;
			if (!Array.isArray(records)) {
				return {
					status: "fail",
					message: "Response missing records array",
					evidence: {
						request: { method: "GET", url },
						response: { status: res.status, body: res.data },
					},
				};
			}
			if (records.length === 0) {
				listRecordsEmpty = true;
				return {
					status: "warn",
					message: `No records in ${collection}`,
					evidence: {
						request: { method: "GET", url },
						response: { status: res.status, body: res.data },
					},
				};
			}
			const first = records[0]!;
			sampleRecord = {
				collection,
				uri: first.uri,
				cid: first.cid,
				rkey: rkeyFromUri(first.uri),
			};
			listRecordsBody = res.data;
			return {
				status: "pass",
				message: `${records.length} from ${collection}`,
				evidence: {
					request: { method: "GET", url },
					response: {
						status: res.status,
						body: { cursor: res.data.cursor, sample: sampleRecord },
					},
				},
			};
		} catch (error) {
			return {
				status: "fail",
				message: error instanceof Error ? error.message : String(error),
				evidence: {
					request: { method: "GET", url },
					error: String(error),
				},
			};
		}
	},
};

const getRecord: Check = {
	id: "repo-read.get-record",
	category: "repo-read",
	label: "Get record",
	requires: ["pds", "did"],
	run: async (ctx): Promise<CheckOutcome> => {
		if (listRecordsEmpty) {
			return { status: "skip", message: "No records to fetch" };
		}
		if (!sampleRecord) {
			return { status: "skip", message: "No sample record available" };
		}
		const pds = ctx.pds!;
		const did = ctx.did!;
		const { collection, rkey, cid: expectedCid, uri } = sampleRecord;
		const url = xrpcUrl(pds, "com.atproto.repo.getRecord", {
			repo: did,
			collection,
			rkey,
		});
		try {
			const res = await getClient(pds).get("com.atproto.repo.getRecord", {
				params: { repo: did as Did, collection: collection as Nsid, rkey },
			});
			if (!res.ok) {
				return {
					status: "fail",
					message: `${res.status} ${res.data.error}: ${res.data.message ?? ""}`.trim(),
					evidence: {
						request: { method: "GET", url },
						response: { status: res.status, body: res.data },
					},
				};
			}
			if (res.data.cid !== expectedCid) {
				return {
					status: "fail",
					message: `CID mismatch for ${uri}`,
					evidence: {
						request: { method: "GET", url },
						response: { status: res.status, body: res.data },
						expected: expectedCid,
						actual: res.data.cid,
					},
				};
			}
			getRecordBody = res.data;
			return {
				status: "pass",
				message: `CID matches (${expectedCid.slice(0, 16)}…)`,
				evidence: {
					request: { method: "GET", url },
					response: { status: res.status, body: { uri: res.data.uri, cid: res.data.cid } },
				},
			};
		} catch (error) {
			return {
				status: "fail",
				message: error instanceof Error ? error.message : String(error),
				evidence: {
					request: { method: "GET", url },
					error: String(error),
				},
			};
		}
	},
};

const listRecordsCursor: Check = {
	id: "repo-read.list-records-cursor",
	category: "repo-read",
	label: "Paginate listRecords with cursor",
	requires: ["pds", "did"],
	run: async (ctx): Promise<CheckOutcome> => {
		if (listRecordsEmpty) {
			return { status: "skip", message: "No records to paginate" };
		}
		const pds = ctx.pds!;
		const did = ctx.did!;
		const collection = sampleRecord?.collection ?? collections?.[0];
		if (!collection) {
			return { status: "skip", message: "No collection to paginate" };
		}
		const url1 = xrpcUrl(pds, "com.atproto.repo.listRecords", {
			repo: did,
			collection,
			limit: "1",
		});
		try {
			const client = getClient(pds);
			const first = await client.get("com.atproto.repo.listRecords", {
				params: { repo: did as Did, collection: collection as Nsid, limit: 1 },
			});
			if (!first.ok) {
				return {
					status: "fail",
					message: `First page: ${first.status} ${first.data.error}`,
					evidence: {
						request: { method: "GET", url: url1 },
						response: { status: first.status, body: first.data },
					},
				};
			}
			const firstRecord = first.data.records[0];
			const cursor = first.data.cursor;
			if (!firstRecord) {
				return {
					status: "warn",
					message: "First page empty",
					evidence: {
						request: { method: "GET", url: url1 },
						response: { status: first.status, body: first.data },
					},
				};
			}
			if (!cursor) {
				return {
					status: "pass",
					message: "Only one record; no cursor returned (end of list)",
					evidence: {
						request: { method: "GET", url: url1 },
						response: { status: first.status, body: first.data },
					},
				};
			}
			const url2 = xrpcUrl(pds, "com.atproto.repo.listRecords", {
				repo: did,
				collection,
				limit: "1",
				cursor,
			});
			const second = await client.get("com.atproto.repo.listRecords", {
				params: { repo: did as Did, collection: collection as Nsid, limit: 1, cursor },
			});
			if (!second.ok) {
				return {
					status: "fail",
					message: `Second page: ${second.status} ${second.data.error}`,
					evidence: {
						request: { method: "GET", url: url2 },
						response: { status: second.status, body: second.data },
					},
				};
			}
			const secondRecord = second.data.records[0];
			if (!secondRecord) {
				if (second.data.cursor) {
					return {
						status: "fail",
						message: "Cursor returned but second page had no records",
						evidence: {
							request: { method: "GET", url: url2 },
							response: { status: second.status, body: second.data },
						},
					};
				}
				return {
					status: "pass",
					message: "Cursor exhausted cleanly (empty page, no cursor)",
					evidence: {
						request: { method: "GET", url: url2 },
						response: { status: second.status, body: second.data },
					},
				};
			}
			if (secondRecord.uri === firstRecord.uri) {
				return {
					status: "fail",
					message: "Cursor returned same record as first page",
					evidence: {
						request: { method: "GET", url: url2 },
						response: { status: second.status, body: second.data },
						expected: `uri !== ${firstRecord.uri}`,
						actual: secondRecord.uri,
					},
				};
			}
			return {
				status: "pass",
				message: "Cursor advanced to a new record",
				evidence: {
					request: { method: "GET", url: url2 },
					response: {
						status: second.status,
						body: { first: firstRecord.uri, second: secondRecord.uri },
					},
				},
			};
		} catch (error) {
			return {
				status: "fail",
				message: error instanceof Error ? error.message : String(error),
				evidence: { error: String(error) },
			};
		}
	},
};

const getRepoCar: Check = {
	id: "repo-read.get-repo-car",
	category: "repo-read",
	label: "Download repo CAR",
	description:
		"Fetches the entire repository as a CAR file. Skipped by default because repos can be hundreds of MB; opt-in via the landing-page checkbox.",
	requires: ["pds", "did"],
	run: async (ctx): Promise<CheckOutcome> => {
		if (!ctx.downloadCar) {
			return {
				status: "skip",
				message:
					"opt-in required — repos can be hundreds of MB; enable on the landing page to run this",
			};
		}
		const pds = ctx.pds!;
		const did = ctx.did!;
		const url = xrpcUrl(pds, "com.atproto.sync.getRepo", { did });
		try {
			const res = await fetch(url);
			const contentType = res.headers.get("content-type") ?? "";
			if (!res.ok) {
				let body: unknown;
				try {
					body = await res.json();
				} catch {
					body = await res.text().catch(() => undefined);
				}
				return {
					status: "fail",
					message: `${res.status} ${res.statusText}`,
					evidence: {
						request: { method: "GET", url },
						response: { status: res.status, body },
					},
				};
			}
			const bytes = new Uint8Array(await res.arrayBuffer());
			if (!contentType.includes("application/vnd.ipld.car")) {
				return {
					status: "fail",
					message: `Unexpected content-type: ${contentType || "(none)"}`,
					evidence: {
						request: { method: "GET", url },
						response: {
							status: res.status,
							body: { contentType, byteLength: bytes.byteLength },
						},
						expected: "application/vnd.ipld.car",
						actual: contentType,
					},
				};
			}
			if (bytes.byteLength === 0) {
				return {
					status: "fail",
					message: "CAR response was empty",
					evidence: {
						request: { method: "GET", url },
						response: {
							status: res.status,
							body: { contentType, byteLength: 0 },
						},
					},
				};
			}
			repoCarBytes = bytes;
			return {
				status: "pass",
				message: `${bytes.byteLength.toLocaleString()} bytes of CAR`,
				evidence: {
					request: { method: "GET", url },
					response: {
						status: res.status,
						body: { contentType, byteLength: bytes.byteLength },
					},
				},
			};
		} catch (error) {
			return {
				status: "fail",
				message: error instanceof Error ? error.message : String(error),
				evidence: {
					request: { method: "GET", url },
					error: String(error),
				},
			};
		}
	},
};

const describeRepoValidates: Check = {
	id: "repo-read.describe-repo.validates",
	category: "repo-read",
	label: "describeRepo response matches lexicon",
	requires: ["pds", "did"],
	run: async (): Promise<CheckOutcome> => {
		if (!describeRepoBody) {
			return { status: "skip", message: "no response to validate" };
		}
		return validateLexicon(
			ComAtprotoRepoDescribeRepo.mainSchema.output.schema,
			describeRepoBody,
		);
	},
};

const listRecordsValidates: Check = {
	id: "repo-read.list-records.validates",
	category: "repo-read",
	label: "listRecords response matches lexicon",
	requires: ["pds", "did"],
	run: async (): Promise<CheckOutcome> => {
		if (!listRecordsBody) {
			return { status: "skip", message: "no response to validate" };
		}
		return validateLexicon(
			ComAtprotoRepoListRecords.mainSchema.output.schema,
			listRecordsBody,
		);
	},
};

const getRecordValidates: Check = {
	id: "repo-read.get-record.validates",
	category: "repo-read",
	label: "getRecord response matches lexicon",
	requires: ["pds", "did"],
	run: async (): Promise<CheckOutcome> => {
		if (!getRecordBody) {
			return { status: "skip", message: "no response to validate" };
		}
		return validateLexicon(
			ComAtprotoRepoGetRecord.mainSchema.output.schema,
			getRecordBody,
		);
	},
};

const getRecordMissing: Check = {
	id: "repo-read.get-record-missing",
	category: "repo-read",
	label: "getRecord returns 400 RecordNotFound for missing record",
	description:
		"Matches the reference @atproto PDS, which raises InvalidRequestError (HTTP 400) with error 'RecordNotFound' rather than returning a 404, and includes the phrase 'Could not locate record:' in the message. Clients probe a record before writing it (for example detaching a quote, which checks app.bsky.feed.postgate first), and the Bluesky social-app does a literal substring match on that phrase to decide whether to create vs. update.",
	requires: ["pds", "did"],
	run: async (ctx): Promise<CheckOutcome> => {
		const pds = ctx.pds!;
		const did = ctx.did!;
		const collection = sampleRecord?.collection ?? "app.bsky.feed.post";
		const rkey = `pdscheck-missing-${Date.now().toString(36)}`;
		const url = xrpcUrl(pds, "com.atproto.repo.getRecord", {
			repo: did,
			collection,
			rkey,
		});
		try {
			const res = await fetch(url);
			let body: unknown;
			try {
				body = await res.json();
			} catch {
				body = await res.text().catch(() => undefined);
			}
			if (res.status !== 400) {
				return {
					status: "fail",
					message: `Expected 400, got ${res.status}`,
					evidence: {
						request: { method: "GET", url },
						response: { status: res.status, body },
						expected: 400,
						actual: res.status,
					},
				};
			}
			const error =
				body && typeof body === "object" && "error" in body
					? (body as { error: unknown }).error
					: undefined;
			if (error !== "RecordNotFound") {
				return {
					status: "fail",
					message: `Expected error 'RecordNotFound', got ${JSON.stringify(error)}`,
					evidence: {
						request: { method: "GET", url },
						response: { status: res.status, body },
						expected: "RecordNotFound",
						actual: error,
					},
				};
			}
			const message =
				body && typeof body === "object" && "message" in body
					? (body as { message: unknown }).message
					: undefined;
			if (
				typeof message !== "string" ||
				!message.includes("Could not locate record:")
			) {
				return {
					status: "fail",
					message:
						"Expected message to include 'Could not locate record:' (Bluesky social-app substring-matches this phrase when detaching a quote)",
					evidence: {
						request: { method: "GET", url },
						response: { status: res.status, body },
						expected: "Could not locate record: <at-uri>",
						actual: message,
					},
				};
			}
			return {
				status: "pass",
				message: "400 RecordNotFound with social-app-compatible message",
				evidence: {
					request: { method: "GET", url },
					response: { status: res.status, body },
				},
			};
		} catch (error) {
			return {
				status: "fail",
				message: error instanceof Error ? error.message : String(error),
				evidence: {
					request: { method: "GET", url },
					error: String(error),
				},
			};
		}
	},
};

const getRepoCarValidates: Check = {
	id: "repo-read.get-repo-car.validates",
	category: "repo-read",
	label: "CAR file parses cleanly",
	requires: ["pds", "did"],
	run: async (): Promise<CheckOutcome> => {
		if (!repoCarBytes) {
			return { status: "skip", message: "no CAR bytes to parse" };
		}
		try {
			const reader = await CarReader.fromBytes(repoCarBytes);
			const roots = await reader.getRoots();
			if (roots.length === 0) {
				return {
					status: "fail",
					message: "CAR header declares no roots",
					evidence: { actual: roots },
				};
			}
			let blockCount = 0;
			const cidStrings = new Set<string>();
			for await (const block of reader.blocks()) {
				blockCount++;
				cidStrings.add(block.cid.toString());
			}
			if (blockCount === 0) {
				return {
					status: "fail",
					message: "CAR contains no blocks",
				};
			}
			const missingRoots = roots
				.filter((cid) => !cidStrings.has(cid.toString()))
				.map((cid) => cid.toString());
			if (missingRoots.length > 0) {
				return {
					status: "fail",
					message: `${missingRoots.length} root CID(s) not present in block set`,
					evidence: { expected: missingRoots, actual: [...cidStrings].slice(0, 5) },
				};
			}
			return {
				status: "pass",
				message: `${blockCount} block(s), root ${roots[0]!.toString().slice(0, 24)}…`,
				evidence: {
					response: {
						body: {
							blockCount,
							roots: roots.map((c) => c.toString()),
						},
					},
				},
			};
		} catch (error) {
			return {
				status: "fail",
				message: error instanceof Error ? error.message : String(error),
				evidence: { error: String(error) },
			};
		}
	},
};

export const repoReadChecks: Check[] = [
	describeRepo,
	describeRepoValidates,
	listCollections,
	listRecords,
	listRecordsValidates,
	getRecord,
	getRecordValidates,
	getRecordMissing,
	listRecordsCursor,
	getRepoCar,
	getRepoCarValidates,
];
