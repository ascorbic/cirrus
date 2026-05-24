import {
	ComAtprotoSyncGetBlocks,
	ComAtprotoSyncGetLatestCommit,
	ComAtprotoSyncGetRepoStatus,
	ComAtprotoSyncListReposByCollection,
} from "@atcute/atproto";
import type { Did, Nsid } from "@atcute/lexicons/syntax";
import { publicClient, validateLexicon } from "../lib/xrpc";
import type { Check, CheckOutcome } from "../types";

let getLatestCommitResponse: ComAtprotoSyncGetLatestCommit.$output | undefined;
let getRepoStatusResponse: ComAtprotoSyncGetRepoStatus.$output | undefined;
let getBlocksResponseBytes: Uint8Array | undefined;
let listReposByCollectionResponse:
	| ComAtprotoSyncListReposByCollection.$output
	| undefined;

function reset() {
	getLatestCommitResponse = undefined;
	getRepoStatusResponse = undefined;
	getBlocksResponseBytes = undefined;
	listReposByCollectionResponse = undefined;
}

function xrpcUrl(
	pds: string,
	nsid: string,
	params: Record<string, string>,
): string {
	const qs = new URLSearchParams(params).toString();
	return `${pds}/xrpc/${nsid}${qs ? `?${qs}` : ""}`;
}

const getLatestCommit: Check = {
	id: "sync.get-latest-commit",
	category: "sync",
	label: "getLatestCommit",
	requires: ["pds", "did"],
	run: async (ctx): Promise<CheckOutcome> => {
		reset();
		const pds = ctx.pds!;
		const did = ctx.did!;
		const url = xrpcUrl(pds, "com.atproto.sync.getLatestCommit", { did });
		try {
			const res = await publicClient(pds).get(
				"com.atproto.sync.getLatestCommit",
				{ params: { did: did as Did } },
			);
			if (!res.ok) {
				return {
					status: "fail",
					message:
						`${res.data.error}: ${res.data.message ?? ""}`.trim(),
					evidence: {
						request: { method: "GET", url },
						response: { status: res.status, body: res.data },
					},
				};
			}
			getLatestCommitResponse = res.data;
			return {
				status: "pass",
				message: `rev ${res.data.rev}, cid ${res.data.cid.slice(0, 16)}…`,
				evidence: {
					request: { method: "GET", url },
					response: { status: res.status, body: res.data },
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

const getLatestCommitValidates: Check = {
	id: "sync.get-latest-commit.validates",
	category: "sync",
	label: "getLatestCommit response matches lexicon",
	requires: ["pds", "did"],
	run: async (): Promise<CheckOutcome> => {
		if (!getLatestCommitResponse) {
			return { status: "skip", message: "getLatestCommit did not succeed" };
		}
		return validateLexicon(
			ComAtprotoSyncGetLatestCommit.mainSchema.output.schema,
			getLatestCommitResponse,
		);
	},
};

const getRepoStatus: Check = {
	id: "sync.get-repo-status",
	category: "sync",
	label: "getRepoStatus",
	requires: ["pds", "did"],
	run: async (ctx): Promise<CheckOutcome> => {
		const pds = ctx.pds!;
		const did = ctx.did!;
		const url = xrpcUrl(pds, "com.atproto.sync.getRepoStatus", { did });
		try {
			const res = await publicClient(pds).get(
				"com.atproto.sync.getRepoStatus",
				{ params: { did: did as Did } },
			);
			if (!res.ok) {
				return {
					status: "fail",
					message:
						`${res.data.error}: ${res.data.message ?? ""}`.trim(),
					evidence: {
						request: { method: "GET", url },
						response: { status: res.status, body: res.data },
					},
				};
			}
			getRepoStatusResponse = res.data;
			const statusPart = res.data.status ? `, status ${res.data.status}` : "";
			const revPart = res.data.rev ? `, rev ${res.data.rev}` : "";
			return {
				status: "pass",
				message: `active=${res.data.active}${statusPart}${revPart}`,
				evidence: {
					request: { method: "GET", url },
					response: { status: res.status, body: res.data },
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

const getRepoStatusValidates: Check = {
	id: "sync.get-repo-status.validates",
	category: "sync",
	label: "getRepoStatus response matches lexicon",
	requires: ["pds", "did"],
	run: async (): Promise<CheckOutcome> => {
		if (!getRepoStatusResponse) {
			return { status: "skip", message: "getRepoStatus did not succeed" };
		}
		return validateLexicon(
			ComAtprotoSyncGetRepoStatus.mainSchema.output.schema,
			getRepoStatusResponse,
		);
	},
};

const getBlocks: Check = {
	id: "sync.get-blocks",
	category: "sync",
	label: "getBlocks",
	requires: ["pds", "did"],
	run: async (ctx): Promise<CheckOutcome> => {
		if (!getLatestCommitResponse) {
			return { status: "skip", message: "no commit CID available" };
		}
		const pds = ctx.pds!;
		const did = ctx.did!;
		const cid = getLatestCommitResponse.cid;
		const url = xrpcUrl(pds, "com.atproto.sync.getBlocks", {
			did,
			cids: cid,
		});
		try {
			const res = await publicClient(pds).get("com.atproto.sync.getBlocks", {
				params: { did: did as Did, cids: [cid] },
				as: "bytes",
			});
			if (!res.ok) {
				return {
					status: "fail",
					message:
						`${res.data.error}: ${res.data.message ?? ""}`.trim(),
					evidence: {
						request: { method: "GET", url },
						response: { status: res.status, body: res.data },
					},
				};
			}
			const bytes = res.data;
			if (!bytes || bytes.byteLength === 0) {
				return {
					status: "fail",
					message: "Empty CAR response",
					evidence: {
						request: { method: "GET", url },
						response: { status: res.status, body: { byteLength: 0 } },
					},
				};
			}
			getBlocksResponseBytes = bytes;
			return {
				status: "pass",
				message: `${bytes.byteLength.toLocaleString()} bytes of CAR`,
				evidence: {
					request: { method: "GET", url },
					response: {
						status: res.status,
						body: { byteLength: bytes.byteLength },
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

const getBlocksValidates: Check = {
	id: "sync.get-blocks.validates",
	category: "sync",
	label: "getBlocks response matches lexicon",
	requires: ["pds", "did"],
	run: async (): Promise<CheckOutcome> => {
		if (!getBlocksResponseBytes) {
			return { status: "skip", message: "getBlocks did not succeed" };
		}
		return { status: "skip", message: "binary response — CAR file" };
	},
};

const listReposByCollection: Check = {
	id: "sync.list-repos-by-collection",
	category: "sync",
	label: "listReposByCollection",
	requires: ["pds", "did"],
	run: async (ctx): Promise<CheckOutcome> => {
		const pds = ctx.pds!;
		const collection = "app.bsky.actor.profile";
		const url = xrpcUrl(pds, "com.atproto.sync.listReposByCollection", {
			collection,
			limit: "5",
		});
		try {
			const res = await publicClient(pds).get(
				"com.atproto.sync.listReposByCollection",
				{ params: { collection: collection as Nsid, limit: 5 } },
			);
			if (!res.ok) {
				return {
					status: "fail",
					message:
						`${res.data.error}: ${res.data.message ?? ""}`.trim(),
					evidence: {
						request: { method: "GET", url },
						response: { status: res.status, body: res.data },
					},
				};
			}
			listReposByCollectionResponse = res.data;
			return {
				status: "pass",
				message: `${res.data.repos.length} repos for ${collection}`,
				evidence: {
					request: { method: "GET", url },
					response: { status: res.status, body: res.data },
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

const listReposByCollectionValidates: Check = {
	id: "sync.list-repos-by-collection.validates",
	category: "sync",
	label: "listReposByCollection response matches lexicon",
	requires: ["pds", "did"],
	run: async (): Promise<CheckOutcome> => {
		if (!listReposByCollectionResponse) {
			return {
				status: "skip",
				message: "listReposByCollection did not succeed",
			};
		}
		return validateLexicon(
			ComAtprotoSyncListReposByCollection.mainSchema.output.schema,
			listReposByCollectionResponse,
		);
	},
};

export const syncChecks: Check[] = [
	getLatestCommit,
	getLatestCommitValidates,
	getRepoStatus,
	getRepoStatusValidates,
	getBlocks,
	getBlocksValidates,
	listReposByCollection,
	listReposByCollectionValidates,
];
