import { ComAtprotoSyncListBlobs } from "@atcute/atproto";
import type { Did } from "@atcute/lexicons/syntax";
import { publicClient, validateLexicon } from "../lib/xrpc";
import type { Check, CheckOutcome } from "../types";

let listBlobsResponse: ComAtprotoSyncListBlobs.$output | undefined;
let firstBlobCid: string | undefined;
let getBlobResponse: { contentType: string | null; byteLength: number } | undefined;

function reset() {
	listBlobsResponse = undefined;
	firstBlobCid = undefined;
	getBlobResponse = undefined;
}

function xrpcUrl(pds: string, nsid: string, params: Record<string, string>): string {
	const qs = new URLSearchParams(params).toString();
	return `${pds}/xrpc/${nsid}${qs ? `?${qs}` : ""}`;
}

const listBlobs: Check = {
	id: "blobs.list-blobs",
	category: "blobs",
	label: "listBlobs",
	requires: ["pds", "did"],
	run: async (ctx): Promise<CheckOutcome> => {
		reset();
		const pds = ctx.pds!;
		const did = ctx.did!;
		const url = xrpcUrl(pds, "com.atproto.sync.listBlobs", { did, limit: "5" });
		try {
			const res = await publicClient(pds).get("com.atproto.sync.listBlobs", {
				params: { did: did as Did, limit: 5 },
			});
			if (!res.ok) {
				return {
					status: "fail",
					message: `${res.data.error}: ${res.data.message ?? ""}`.trim(),
					evidence: {
						request: { method: "GET", url },
						response: { status: res.status, body: res.data },
					},
				};
			}
			listBlobsResponse = res.data;
			firstBlobCid = res.data.cids[0];
			return {
				status: "pass",
				message: `${res.data.cids.length} blob CIDs`,
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

const listBlobsValidates: Check = {
	id: "blobs.list-blobs.validates",
	category: "blobs",
	label: "listBlobs response matches lexicon",
	requires: ["pds", "did"],
	run: async (): Promise<CheckOutcome> => {
		if (!listBlobsResponse) {
			return { status: "skip", message: "no response to validate" };
		}
		return validateLexicon(
			ComAtprotoSyncListBlobs.mainSchema.output.schema,
			listBlobsResponse,
		);
	},
};

const getBlob: Check = {
	id: "blobs.get-blob",
	category: "blobs",
	label: "getBlob",
	requires: ["pds", "did"],
	run: async (ctx): Promise<CheckOutcome> => {
		if (listBlobsResponse && listBlobsResponse.cids.length === 0) {
			return { status: "skip", message: "no blobs in repo" };
		}
		if (!firstBlobCid) {
			return { status: "skip", message: "listBlobs did not succeed" };
		}
		const pds = ctx.pds!;
		const did = ctx.did!;
		const cid = firstBlobCid;
		const url = xrpcUrl(pds, "com.atproto.sync.getBlob", { did, cid });
		try {
			const res = await publicClient(pds).get("com.atproto.sync.getBlob", {
				params: { did: did as Did, cid },
				as: "bytes",
			});
			if (!res.ok) {
				return {
					status: "fail",
					message: `${res.data.error}: ${res.data.message ?? ""}`.trim(),
					evidence: {
						request: { method: "GET", url },
						response: { status: res.status, body: res.data },
					},
				};
			}
			const bytes = res.data;
			const contentType = res.headers.get("content-type");
			getBlobResponse = { contentType, byteLength: bytes.byteLength };
			if (bytes.byteLength === 0) {
				return {
					status: "fail",
					message: "blob response was empty",
					evidence: {
						request: { method: "GET", url },
						response: { status: res.status, body: getBlobResponse },
					},
				};
			}
			if (contentType && /^text\/html\b/i.test(contentType)) {
				return {
					status: "fail",
					message: `unexpected content-type: ${contentType}`,
					evidence: {
						request: { method: "GET", url },
						response: { status: res.status, body: getBlobResponse },
						actual: contentType,
					},
				};
			}
			return {
				status: "pass",
				message: `${bytes.byteLength.toLocaleString()} bytes${contentType ? `, ${contentType}` : ""}`,
				evidence: {
					request: { method: "GET", url },
					response: { status: res.status, body: getBlobResponse },
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

const getBlobValidates: Check = {
	id: "blobs.get-blob.validates",
	category: "blobs",
	label: "getBlob response matches lexicon",
	requires: ["pds", "did"],
	run: async (): Promise<CheckOutcome> => {
		return {
			status: "skip",
			message: "binary response — content not lexicon-validated",
		};
	},
};

export const blobsChecks: Check[] = [
	listBlobs,
	listBlobsValidates,
	getBlob,
	getBlobValidates,
];
