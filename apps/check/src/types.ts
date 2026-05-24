export type CheckStatus =
	| "pending"
	| "running"
	| "pass"
	| "fail"
	| "warn"
	| "skip"
	| "error";

export type CheckCategory =
	| "identity"
	| "server"
	| "repo-read"
	| "sync"
	| "blobs"
	| "firehose"
	| "oauth"
	| "account"
	| "repo-write";

export type CheckRequirement = "did" | "pds" | "session";

export interface CheckEvidence {
	expected?: unknown;
	actual?: unknown;
	request?: { method: string; url: string };
	response?: { status?: number; body?: unknown };
	error?: string;
}

export interface CheckOutcome {
	status: "pass" | "fail" | "warn" | "skip";
	message?: string;
	evidence?: CheckEvidence;
	context?: Partial<CheckContext>;
}

export interface CheckContext {
	target: string;
	handle?: string;
	did?: string;
	didDoc?: import("@atcute/identity").DidDocument;
	pds?: string;
	signedIn: boolean;
	agent?: import("@atcute/oauth-browser-client").OAuthUserAgent;
	/**
	 * When true, opt-in for the full repository CAR download check.
	 * Off by default because repos can be hundreds of MB.
	 */
	downloadCar?: boolean;
}

export interface Check {
	id: string;
	category: CheckCategory;
	label: string;
	description?: string;
	requires?: CheckRequirement[];
	run: (ctx: CheckContext) => Promise<CheckOutcome>;
}

export interface CheckResult {
	check: Check;
	status: CheckStatus;
	outcome?: CheckOutcome;
	startedAt?: number;
	endedAt?: number;
}

export interface Run {
	target: string;
	startedAt: number;
	endedAt?: number;
	results: readonly CheckResult[];
	cancel: () => void;
}

export const CATEGORY_LABELS: Record<CheckCategory, string> = {
	identity: "Identity",
	server: "Server",
	"repo-read": "Repo Read",
	sync: "Sync",
	blobs: "Blobs",
	firehose: "Firehose",
	oauth: "OAuth",
	account: "Account",
	"repo-write": "Repo Write",
};

export const CATEGORY_ORDER: CheckCategory[] = [
	"identity",
	"server",
	"repo-read",
	"sync",
	"blobs",
	"firehose",
	"oauth",
	"account",
	"repo-write",
];
