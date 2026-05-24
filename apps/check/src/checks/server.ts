import {
	ComAtprotoServerDescribeServer,
	ComAtprotoSyncListRepos,
} from "@atcute/atproto";
import { publicClient, validateLexicon } from "../lib/xrpc";
import type { Check, CheckOutcome } from "../types";

let describeServerResponse: ComAtprotoServerDescribeServer.$output | undefined;
let listReposResponse: ComAtprotoSyncListRepos.$output | undefined;

function reset() {
	describeServerResponse = undefined;
	listReposResponse = undefined;
}

function xrpcUrl(
	pds: string,
	nsid: string,
	params: Record<string, string>,
): string {
	const qs = new URLSearchParams(params).toString();
	return `${pds}/xrpc/${nsid}${qs ? `?${qs}` : ""}`;
}

const describeServer: Check = {
	id: "server.describe-server",
	category: "server",
	label: "describeServer",
	requires: ["pds"],
	run: async (ctx): Promise<CheckOutcome> => {
		reset();
		const pds = ctx.pds!;
		const url = xrpcUrl(pds, "com.atproto.server.describeServer", {});
		try {
			const res = await publicClient(pds).get(
				"com.atproto.server.describeServer",
				{},
			);
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
			describeServerResponse = res.data;
			return {
				status: "pass",
				message: `did ${res.data.did}`,
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

const describeServerValidates: Check = {
	id: "server.describe-server.validates",
	category: "server",
	label: "describeServer response matches lexicon",
	requires: ["pds"],
	run: async (): Promise<CheckOutcome> => {
		if (!describeServerResponse) {
			return { status: "skip", message: "no response to validate" };
		}
		return validateLexicon(
			ComAtprotoServerDescribeServer.mainSchema.output.schema,
			describeServerResponse,
		);
	},
};

const listRepos: Check = {
	id: "server.list-repos",
	category: "server",
	label: "listRepos",
	requires: ["pds"],
	run: async (ctx): Promise<CheckOutcome> => {
		const pds = ctx.pds!;
		const url = xrpcUrl(pds, "com.atproto.sync.listRepos", { limit: "10" });
		try {
			const res = await publicClient(pds).get("com.atproto.sync.listRepos", {
				params: { limit: 10 },
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
			listReposResponse = res.data;
			return {
				status: "pass",
				message: `${res.data.repos.length} repos`,
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

const listReposValidates: Check = {
	id: "server.list-repos.validates",
	category: "server",
	label: "listRepos response matches lexicon",
	requires: ["pds"],
	run: async (): Promise<CheckOutcome> => {
		if (!listReposResponse) {
			return { status: "skip", message: "no response to validate" };
		}
		return validateLexicon(
			ComAtprotoSyncListRepos.mainSchema.output.schema,
			listReposResponse,
		);
	},
};

// PDS health endpoint — a de-facto convention used by @atproto/pds and most
// implementations (cirrus included). Returns { status, version }. Not in the
// formal spec but useful for surfacing the PDS's implementation name/version.
const healthCheck: Check = {
	id: "server.health",
	category: "server",
	label: "PDS health",
	requires: ["pds"],
	run: async (ctx): Promise<CheckOutcome> => {
		const pds = ctx.pds!;
		const url = `${pds}/xrpc/_health`;
		try {
			const res = await fetch(url, {
				headers: { accept: "application/json" },
			});
			if (!res.ok) {
				return {
					status: "warn",
					message: `HTTP ${res.status} — endpoint not implemented`,
					evidence: {
						request: { method: "GET", url },
						response: { status: res.status },
					},
				};
			}
			const body = (await res.json().catch(() => ({}))) as {
				status?: string;
				version?: string;
			};
			const version = body.version;
			const status = body.status;
			// Explicit non-"ok" status is a real warn (PDS reporting unhealthy).
			if (typeof status === "string" && status !== "ok") {
				return {
					status: "warn",
					message:
						version !== undefined
							? `version: ${version} — status: ${status}`
							: `status: ${status} (no version reported)`,
					evidence: {
						request: { method: "GET", url },
						response: { status: res.status, body },
						error: `PDS reports status="${status}" (expected "ok")`,
					},
				};
			}
			// Empty body — endpoint responded but with nothing useful.
			if (version === undefined && status === undefined) {
				return {
					status: "warn",
					message: "responded but body had neither version nor status",
					evidence: {
						request: { method: "GET", url },
						response: { status: res.status, body },
						error:
							"_health convention is { status, version } — both missing",
					},
				};
			}
			// Pass: either status === "ok", or status missing but we got a version.
			return {
				status: "pass",
				message:
					version !== undefined
						? status === "ok"
							? `version: ${version} — status: ok`
							: `version: ${version}`
						: "status: ok",
				evidence: {
					request: { method: "GET", url },
					response: { status: res.status, body },
				},
			};
		} catch (error) {
			return {
				status: "warn",
				message: error instanceof Error ? error.message : String(error),
				evidence: { error: String(error) },
			};
		}
	},
};

export const serverChecks: Check[] = [
	healthCheck,
	describeServer,
	describeServerValidates,
	listRepos,
	listReposValidates,
];
