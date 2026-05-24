import "@atcute/atproto";
import {
	ComAtprotoIdentityGetRecommendedDidCredentials,
	ComAtprotoServerCheckAccountStatus,
	ComAtprotoServerGetAccountInviteCodes,
	ComAtprotoServerGetServiceAuth,
	ComAtprotoServerGetSession,
	ComAtprotoServerListAppPasswords,
} from "@atcute/atproto";
import type { Did, Nsid } from "@atcute/lexicons/syntax";
import { authedClient, validateLexicon } from "../lib/xrpc";
import type { Check, CheckContext, CheckOutcome } from "../types";

let getSessionResponse: ComAtprotoServerGetSession.$output | undefined;
let checkAccountStatusResponse:
	| ComAtprotoServerCheckAccountStatus.$output
	| undefined;
let listAppPasswordsResponse:
	| ComAtprotoServerListAppPasswords.$output
	| undefined;
let getAccountInviteCodesResponse:
	| ComAtprotoServerGetAccountInviteCodes.$output
	| undefined;
let getServiceAuthResponse: ComAtprotoServerGetServiceAuth.$output | undefined;
let getRecommendedDidCredentialsResponse:
	| ComAtprotoIdentityGetRecommendedDidCredentials.$output
	| undefined;

function reset() {
	getSessionResponse = undefined;
	checkAccountStatusResponse = undefined;
	listAppPasswordsResponse = undefined;
	getAccountInviteCodesResponse = undefined;
	getServiceAuthResponse = undefined;
	getRecommendedDidCredentialsResponse = undefined;
}

function sessionMismatch(ctx: CheckContext): CheckOutcome | null {
	if (!ctx.agent) return { status: "skip", message: "No active session" };
	if (ctx.agent.sub !== ctx.did) {
		return {
			status: "skip",
			message: `Session is for ${ctx.agent.sub}, target is ${ctx.did}`,
		};
	}
	return null;
}

const getSession: Check = {
	id: "account.get-session",
	category: "account",
	label: "getSession",
	requires: ["pds", "session"],
	run: async (ctx): Promise<CheckOutcome> => {
		reset();
		const guard = sessionMismatch(ctx);
		if (guard) return guard;
		const client = authedClient(ctx.agent!);
		const res = await client.get("com.atproto.server.getSession", {});
		if (!res.ok) {
			return {
				status: "fail",
				message: `${res.data.error}: ${res.data.message ?? ""}`.trim(),
				evidence: { response: { status: res.status, body: res.data } },
			};
		}
		getSessionResponse = res.data;
		return {
			status: "pass",
			message: `did ${res.data.did}, handle ${res.data.handle}`,
			evidence: { response: { status: res.status, body: res.data } },
		};
	},
};

const getSessionValidates: Check = {
	id: "account.get-session.validates",
	category: "account",
	label: "getSession response matches lexicon",
	requires: ["pds", "session"],
	run: async (ctx): Promise<CheckOutcome> => {
		const guard = sessionMismatch(ctx);
		if (guard) return guard;
		if (!getSessionResponse) {
			return { status: "skip", message: "no response to validate" };
		}
		return validateLexicon(
			ComAtprotoServerGetSession.mainSchema.output.schema,
			getSessionResponse,
		);
	},
};

const checkAccountStatus: Check = {
	id: "account.check-account-status",
	category: "account",
	label: "checkAccountStatus",
	requires: ["pds", "session"],
	run: async (ctx): Promise<CheckOutcome> => {
		const guard = sessionMismatch(ctx);
		if (guard) return guard;
		const client = authedClient(ctx.agent!);
		const res = await client.get("com.atproto.server.checkAccountStatus", {});
		if (!res.ok) {
			return {
				status: "fail",
				message: `${res.data.error}: ${res.data.message ?? ""}`.trim(),
				evidence: { response: { status: res.status, body: res.data } },
			};
		}
		checkAccountStatusResponse = res.data;
		return {
			status: "pass",
			message: `activated=${res.data.activated}, valid=${res.data.validDid}`,
			evidence: { response: { status: res.status, body: res.data } },
		};
	},
};

const checkAccountStatusValidates: Check = {
	id: "account.check-account-status.validates",
	category: "account",
	label: "checkAccountStatus response matches lexicon",
	requires: ["pds", "session"],
	run: async (ctx): Promise<CheckOutcome> => {
		const guard = sessionMismatch(ctx);
		if (guard) return guard;
		if (!checkAccountStatusResponse) {
			return { status: "skip", message: "no response to validate" };
		}
		return validateLexicon(
			ComAtprotoServerCheckAccountStatus.mainSchema.output.schema,
			checkAccountStatusResponse,
		);
	},
};

const listAppPasswords: Check = {
	id: "account.list-app-passwords",
	category: "account",
	label: "listAppPasswords",
	requires: ["pds", "session"],
	run: async (ctx): Promise<CheckOutcome> => {
		const guard = sessionMismatch(ctx);
		if (guard) return guard;
		const client = authedClient(ctx.agent!);
		const res = await client.get("com.atproto.server.listAppPasswords", {});
		if (!res.ok) {
			return {
				status: "fail",
				message: `${res.data.error}: ${res.data.message ?? ""}`.trim(),
				evidence: { response: { status: res.status, body: res.data } },
			};
		}
		listAppPasswordsResponse = res.data;
		return {
			status: "pass",
			message: `${res.data.passwords.length} app password(s)`,
			evidence: { response: { status: res.status, body: res.data } },
		};
	},
};

const listAppPasswordsValidates: Check = {
	id: "account.list-app-passwords.validates",
	category: "account",
	label: "listAppPasswords response matches lexicon",
	requires: ["pds", "session"],
	run: async (ctx): Promise<CheckOutcome> => {
		const guard = sessionMismatch(ctx);
		if (guard) return guard;
		if (!listAppPasswordsResponse) {
			return { status: "skip", message: "no response to validate" };
		}
		return validateLexicon(
			ComAtprotoServerListAppPasswords.mainSchema.output.schema,
			listAppPasswordsResponse,
		);
	},
};

const getAccountInviteCodes: Check = {
	id: "account.get-account-invite-codes",
	category: "account",
	label: "getAccountInviteCodes",
	requires: ["pds", "session"],
	run: async (ctx): Promise<CheckOutcome> => {
		const guard = sessionMismatch(ctx);
		if (guard) return guard;
		const client = authedClient(ctx.agent!);
		const res = await client.get(
			"com.atproto.server.getAccountInviteCodes",
			{ params: {} },
		);
		if (!res.ok) {
			return {
				status: "fail",
				message: `${res.data.error}: ${res.data.message ?? ""}`.trim(),
				evidence: { response: { status: res.status, body: res.data } },
			};
		}
		getAccountInviteCodesResponse = res.data;
		return {
			status: "pass",
			message: `${res.data.codes.length} invite code(s)`,
			evidence: { response: { status: res.status, body: res.data } },
		};
	},
};

const getAccountInviteCodesValidates: Check = {
	id: "account.get-account-invite-codes.validates",
	category: "account",
	label: "getAccountInviteCodes response matches lexicon",
	requires: ["pds", "session"],
	run: async (ctx): Promise<CheckOutcome> => {
		const guard = sessionMismatch(ctx);
		if (guard) return guard;
		if (!getAccountInviteCodesResponse) {
			return { status: "skip", message: "no response to validate" };
		}
		return validateLexicon(
			ComAtprotoServerGetAccountInviteCodes.mainSchema.output.schema,
			getAccountInviteCodesResponse,
		);
	},
};

const getServiceAuth: Check = {
	id: "account.get-service-auth",
	category: "account",
	label: "getServiceAuth",
	requires: ["pds", "session"],
	run: async (ctx): Promise<CheckOutcome> => {
		const guard = sessionMismatch(ctx);
		if (guard) return guard;
		const client = authedClient(ctx.agent!);
		const res = await client.get("com.atproto.server.getServiceAuth", {
			params: {
				aud: "did:web:api.bsky.app" as Did,
				lxm: "app.bsky.actor.getProfile" as Nsid,
			},
		});
		if (!res.ok) {
			return {
				status: "fail",
				message: `${res.data.error}: ${res.data.message ?? ""}`.trim(),
				evidence: { response: { status: res.status, body: res.data } },
			};
		}
		getServiceAuthResponse = res.data;
		return {
			status: "pass",
			message: `token issued (${res.data.token.length} chars)`,
			evidence: { response: { status: res.status, body: res.data } },
		};
	},
};

const getServiceAuthValidates: Check = {
	id: "account.get-service-auth.validates",
	category: "account",
	label: "getServiceAuth response matches lexicon",
	requires: ["pds", "session"],
	run: async (ctx): Promise<CheckOutcome> => {
		const guard = sessionMismatch(ctx);
		if (guard) return guard;
		if (!getServiceAuthResponse) {
			return { status: "skip", message: "no response to validate" };
		}
		return validateLexicon(
			ComAtprotoServerGetServiceAuth.mainSchema.output.schema,
			getServiceAuthResponse,
		);
	},
};

const getRecommendedDidCredentials: Check = {
	id: "account.get-recommended-did-credentials",
	category: "account",
	label: "getRecommendedDidCredentials",
	requires: ["pds", "session"],
	run: async (ctx): Promise<CheckOutcome> => {
		const guard = sessionMismatch(ctx);
		if (guard) return guard;
		const client = authedClient(ctx.agent!);
		const res = await client.get(
			"com.atproto.identity.getRecommendedDidCredentials",
			{},
		);
		if (!res.ok) {
			return {
				status: "fail",
				message: `${res.data.error}: ${res.data.message ?? ""}`.trim(),
				evidence: { response: { status: res.status, body: res.data } },
			};
		}
		getRecommendedDidCredentialsResponse = res.data;
		const aka = res.data.alsoKnownAs?.length ?? 0;
		const rks = res.data.rotationKeys?.length ?? 0;
		return {
			status: "pass",
			message: `${aka} alsoKnownAs, ${rks} rotation key(s)`,
			evidence: { response: { status: res.status, body: res.data } },
		};
	},
};

const getRecommendedDidCredentialsValidates: Check = {
	id: "account.get-recommended-did-credentials.validates",
	category: "account",
	label: "getRecommendedDidCredentials response matches lexicon",
	requires: ["pds", "session"],
	run: async (ctx): Promise<CheckOutcome> => {
		const guard = sessionMismatch(ctx);
		if (guard) return guard;
		if (!getRecommendedDidCredentialsResponse) {
			return { status: "skip", message: "no response to validate" };
		}
		return validateLexicon(
			ComAtprotoIdentityGetRecommendedDidCredentials.mainSchema.output.schema,
			getRecommendedDidCredentialsResponse,
		);
	},
};

export const accountChecks: Check[] = [
	getSession,
	getSessionValidates,
	checkAccountStatus,
	checkAccountStatusValidates,
	listAppPasswords,
	listAppPasswordsValidates,
	getAccountInviteCodes,
	getAccountInviteCodesValidates,
	getServiceAuth,
	getServiceAuthValidates,
	getRecommendedDidCredentials,
	getRecommendedDidCredentialsValidates,
];
