/**
 * The space-host role: the writer set (listWriters, removeWriter) and,
 * when the harness serves a syncer inbox, the notifications the host sends
 * through `authorizeSpaceSync`'s `notify` registration —
 * confirmRegistration, then notifySpaceUpdate for writes, removals and
 * deletion. Browser-safe; the inbox checks need a harness the target can
 * reach.
 */

import { defineCheck } from "../registry.js";
import { asOperator, xrpcGet, xrpcPost } from "../http.js";
import {
	fail,
	pass,
	type Check,
	type CheckContext,
	type InboxDelivery,
	type SyncerInbox,
} from "../model.js";
import { bytesEqual, decodeJwt, isTid, lexBytes } from "../encoding.js";
import {
	createProbeSpace,
	managedspace,
	credentialCall,
	deleteProbeSpace,
	describe,
	mustCreateRecord,
	obtainPublicCredential,
	publicRead,
	requestCredential,
	type Credential,
} from "./probe.js";
import { fakeDid } from "./space.js";

const L = (ref: string) => ({ source: "lexicon" as const, ref });
const P = (ref: string) => ({ source: "proposal" as const, ref });

const REPO_WRITE = "com.atproto.space.defs#repoWrite";
const REPO_REMOVED = "com.atproto.space.defs#repoRemoved";
const SPACE_DELETED = "com.atproto.space.notifySpaceUpdate#spaceDeleted";

interface WriterEntry {
	$type?: string;
	repo?: string;
	repoRev?: unknown;
	data?: unknown;
	spaceRev?: unknown;
}

export async function listWriters(
	ctx: CheckContext,
	credential: Credential,
	params: Record<string, string> = {},
) {
	const res = await credentialCall(
		ctx,
		credential,
		"com.atproto.space.listWriters",
		{
			params: { space: credential.space, ...params },
			audience: ctx.target.did,
		},
	);
	const body = res.json as
		| { repos?: WriterEntry[]; cursor?: string }
		| undefined;
	return { res, repos: body?.repos ?? [], cursor: body?.cursor };
}

/** The latest entry for `repo` in the whole writer set. */
async function writerEntry(
	ctx: CheckContext,
	credential: Credential,
	repo: string,
) {
	const { repos } = await listWriters(ctx, credential, { limit: "1000" });
	return repos.filter((r) => r.repo === repo).at(-1);
}

const hostRequiresCredential = defineCheck({
	id: "host.listwriters-requires-credential",
	title: "listWriters refuses an unauthenticated caller",
	tier: "must",
	citations: [L("com.atproto.space.listWriters")],
	needs: ["operator"],
	destructive: true,
	async run(ctx) {
		const space = await createProbeSpace(ctx, publicRead());
		try {
			const res = await xrpcGet(ctx, "com.atproto.space.listWriters", {
				space: space.uri,
			});
			return res.status === 401 || res.status === 403
				? pass(`refused with ${res.status}`)
				: fail(
						`unauthenticated listWriters returned ${describe(res)}`,
						res.json,
					);
		} finally {
			await deleteProbeSpace(ctx, space.uri);
		}
	},
});

const listWritersShape = defineCheck({
	id: "sync.listwriters-shape",
	title:
		"listWriters lists typed repoWrite entries by ascending spaceRev, resumable by cursor",
	tier: "must",
	citations: [
		L("com.atproto.space.listWriters"),
		L("com.atproto.space.defs#repoWrite"),
		P("0016#the-sync-boundary-writer-set"),
	],
	needs: ["operator"],
	destructive: true,
	async run(ctx) {
		const space = await createProbeSpace(ctx, publicRead());
		try {
			await mustCreateRecord(ctx, space.uri, "a");
			await mustCreateRecord(ctx, space.uri, "b");
			const credential = await obtainPublicCredential(ctx, space.uri);
			const page = await listWriters(ctx, credential);
			if (page.res.status !== 200)
				return fail(`listWriters ${describe(page.res)}`, page.res.json);
			const problems: string[] = [];
			for (const entry of page.repos) {
				if (entry.$type !== REPO_WRITE && entry.$type !== REPO_REMOVED)
					problems.push(`entry $type ${String(entry.$type)}`);
				if (!isTid(entry.spaceRev))
					problems.push(`${entry.repo} spaceRev ${String(entry.spaceRev)}`);
				if (entry.$type === REPO_WRITE) {
					if (!isTid(entry.repoRev))
						problems.push(`${entry.repo} repoRev ${String(entry.repoRev)}`);
					if (lexBytes(entry.data)?.length !== 32)
						problems.push(`${entry.repo} data is not 32 bytes`);
				}
				if ("prevSpaceRev" in entry)
					problems.push("listWriters entries carry prevSpaceRev");
			}
			const revs = page.repos.map((r) => String(r.spaceRev));
			if (revs.some((rev, i) => i > 0 && rev <= revs[i - 1]!))
				problems.push(`not ascending: ${revs.join(",")}`);
			if (
				!page.repos.some(
					(r) => r.repo === ctx.target.did && r.$type === REPO_WRITE,
				)
			) {
				problems.push("the authority's own repo is not listed as a repoWrite");
			}
			if (!page.cursor) problems.push("a non-empty page carried no cursor");
			if (problems.length) return fail(problems.join("; "), page.res.json);
			// Resuming from the cursor reaches only later updates — here, none.
			const next = await listWriters(ctx, credential, { cursor: page.cursor! });
			if (next.res.status !== 200)
				return fail(`listWriters(cursor) ${describe(next.res)}`, next.res.json);
			return next.repos.length === 0
				? pass(
						`${page.repos.length} writer(s), typed and ascending; the cursor resumes after them`,
					)
				: fail(
						`after the last cursor: ${next.repos.length} repo(s) again`,
						next.res.json,
					);
		} finally {
			await deleteProbeSpace(ctx, space.uri);
		}
	},
});

const listWritersReflects = defineCheck({
	id: "sync.listwriters-reflects-writes",
	title: "The authority's listWriters entry matches its latest commit",
	tier: "should",
	citations: [
		{
			source: "reference",
			ref: "authority repo notifies its own space host synchronously",
		},
		L("com.atproto.space.listWriters"),
	],
	needs: ["operator"],
	destructive: true,
	async run(ctx) {
		// The proposal lets the entry lag ("current as far as the authority's
		// notifications have kept it"), so this is calibrated on the reference.
		const space = await createProbeSpace(ctx, publicRead());
		try {
			await mustCreateRecord(ctx, space.uri, "a");
			const credential = await obtainPublicCredential(ctx, space.uri);
			const mine = await writerEntry(ctx, credential, ctx.target.did);
			const latest = await xrpcGet(
				asOperator(ctx),
				"com.atproto.space.getLatestCommit",
				{
					space: space.uri,
					repo: ctx.target.did,
				},
			);
			const commit = (
				latest.json as { commit?: { rev?: string; data?: unknown } } | undefined
			)?.commit;
			const a = lexBytes(mine?.data);
			const b = lexBytes(commit?.data);
			return mine &&
				commit &&
				mine.repoRev === commit.rev &&
				a &&
				b &&
				bytesEqual(a, b)
				? pass("repoRev and data match getLatestCommit")
				: fail("listWriters entry differs from the latest commit", {
						listed: mine,
						commit,
					});
		} finally {
			await deleteProbeSpace(ctx, space.uri);
		}
	},
});

const removeWriter = defineCheck({
	id: "host.removewriter",
	title: "removeWriter lists the repo as repoRemoved until it writes again",
	tier: "must",
	citations: [
		L("com.atproto.space.removeWriter"),
		L("com.atproto.space.listWriters"),
		L("com.atproto.space.defs#repoRemoved"),
		P("0016#the-sync-boundary-writer-set"),
	],
	needs: ["operator"],
	destructive: true,
	async run(ctx) {
		const space = await createProbeSpace(ctx, publicRead());
		const remove = (repo: string) =>
			xrpcPost(asOperator(ctx), "com.atproto.space.removeWriter", {
				space: space.uri,
				repo,
			});
		try {
			await mustCreateRecord(ctx, space.uri, "a");
			const credential = await obtainPublicCredential(ctx, space.uri);
			const before = await writerEntry(ctx, credential, ctx.target.did);
			if (before?.$type !== REPO_WRITE)
				return fail(
					"the authority's repo was not in the writer set to begin with",
				);
			const removed = await remove(ctx.target.did);
			if (removed.status !== 200)
				return fail(`removeWriter ${describe(removed)}`, removed.json);
			const gone = await writerEntry(ctx, credential, ctx.target.did);
			if (gone?.$type !== REPO_REMOVED)
				return fail(`after removeWriter the entry is ${JSON.stringify(gone)}`);
			if (!(String(gone.spaceRev) > String(before.spaceRev)))
				return fail("the removal was not sequenced after the write");
			// "Does nothing if the account is not in the writer set."
			const absent = await remove(fakeDid());
			if (absent.status !== 200)
				return fail(
					`removeWriter of a non-writer returned ${describe(absent)}`,
					absent.json,
				);
			await mustCreateRecord(ctx, space.uri, "b");
			const back = await writerEntry(ctx, credential, ctx.target.did);
			return back?.$type === REPO_WRITE
				? pass(
						"listed as repoRemoved at a later spaceRev; no-op for a non-writer; a new write re-added it",
					)
				: fail(`after a new write the entry is ${JSON.stringify(back)}`);
		} finally {
			await deleteProbeSpace(ctx, space.uri);
		}
	},
});

const hostAfterDelete = defineCheck({
	id: "host.deleted-space-not-found",
	title: "listWriters on a deleted space answers SpaceNotFound",
	tier: "must",
	citations: [L("com.atproto.space.listWriters@error:SpaceNotFound")],
	needs: ["operator"],
	destructive: true,
	async run(ctx) {
		// A credential issued before deletion is still well-formed and
		// unexpired; what has gone is the space.
		const space = await createProbeSpace(ctx, publicRead());
		const credential = await obtainPublicCredential(ctx, space.uri);
		await deleteProbeSpace(ctx, space.uri);
		const { res } = await listWriters(ctx, credential);
		return res.error === "SpaceNotFound"
			? pass("answered SpaceNotFound")
			: fail(`answered ${describe(res)}, expected SpaceNotFound`, res.json);
	},
});

// --- notifications to a harness syncer ------------------------------------

const NOTIFY_TIMEOUT_MS = 10_000;

/** Authorise with a fresh notify registration at the inbox. */
async function register(ctx: CheckContext, inbox: SyncerInbox, space: string) {
	const token = inbox.issueToken(space);
	const since = Date.now();
	const res = await requestCredential(ctx, space, {
		notify: { endpoint: inbox.endpoint, token },
	});
	return { token, since, ...res };
}

const updatesFor =
	(space: string, token: string, type: string, since: number) =>
	(d: InboxDelivery) => {
		const body = d.body as
			| { space?: string; token?: string; update?: { $type?: string } }
			| undefined;
		return (
			d.lxm === "com.atproto.space.notifySpaceUpdate" &&
			d.receivedAt >= since &&
			body?.space === space &&
			body.token === token &&
			body.update?.$type === type
		);
	};

const notifyConfirmed = defineCheck({
	id: "notify.registration-confirmed",
	title:
		"A notify registration is confirmed with a challenge before the credential is issued",
	tier: "must",
	citations: [
		L("com.atproto.space.confirmRegistration"),
		L("com.atproto.space.authorizeSpaceSync#notify"),
		P("0016#registering-for-notifications"),
	],
	needs: ["operator", "syncer-inbox"],
	destructive: true,
	async run(ctx) {
		const inbox = ctx.syncerInbox!;
		const space = await createProbeSpace(ctx, publicRead());
		try {
			const reg = await register(ctx, inbox, space.uri);
			if (!reg.credential)
				return fail(
					`authorizeSpaceSync with notify ${describe(reg.result)}`,
					reg.result.json,
				);
			const confirm = await inbox.waitFor(
				(d) =>
					d.lxm === "com.atproto.space.confirmRegistration" &&
					d.receivedAt >= reg.since &&
					(d.body as { token?: string } | undefined)?.token === reg.token,
				1_000,
			);
			if (!confirm)
				return fail(
					"the credential was issued without calling confirmRegistration",
				);
			const body = confirm.body as { space?: string; challenge?: unknown };
			if (body.space !== space.uri)
				return fail(`confirmRegistration named space ${body.space}`);
			if (typeof body.challenge !== "string" || body.challenge.length < 8)
				return fail("confirmRegistration carried no real challenge", body);
			return pass(
				"confirmRegistration (space, token, challenge) preceded the credential",
			);
		} finally {
			await deleteProbeSpace(ctx, space.uri);
		}
	},
});

const notifyRenewal = defineCheck({
	id: "notify.renewal-not-reconfirmed",
	title:
		"Reauthorizing with the same notify pair renews without confirming again",
	tier: "should",
	citations: [
		{
			source: "reference",
			ref: "pds authorizeSpaceSync confirms only unregistered pairs",
		},
		P("0016#registering-for-notifications"),
	],
	needs: ["operator", "syncer-inbox"],
	destructive: true,
	async run(ctx) {
		const inbox = ctx.syncerInbox!;
		const space = await createProbeSpace(ctx, publicRead());
		try {
			const first = await register(ctx, inbox, space.uri);
			if (!first.credential)
				return fail(`authorizeSpaceSync ${describe(first.result)}`);
			const since = Date.now();
			const again = await requestCredential(ctx, space.uri, {
				notify: { endpoint: inbox.endpoint, token: first.token },
			});
			if (!again.credential)
				return fail(`reauthorizing ${describe(again.result)}`);
			const reconfirmed = await inbox.waitFor(
				(d) =>
					d.lxm === "com.atproto.space.confirmRegistration" &&
					d.receivedAt >= since &&
					(d.body as { token?: string })?.token === first.token,
				500,
			);
			return reconfirmed
				? fail("the renewal was confirmed again")
				: pass("renewed without a second confirmation");
		} finally {
			await deleteProbeSpace(ctx, space.uri);
		}
	},
});

const notifyRepoWrite = defineCheck({
	id: "notify.repo-write-delivered",
	title: "A registered syncer receives sequenced repoWrite updates",
	tier: "must",
	citations: [
		L("com.atproto.space.notifySpaceUpdate"),
		L("com.atproto.space.defs#repoWrite"),
		P("0016#write-notifications"),
	],
	needs: ["operator", "syncer-inbox"],
	destructive: true,
	async run(ctx) {
		const inbox = ctx.syncerInbox!;
		const space = await createProbeSpace(ctx, publicRead());
		try {
			await mustCreateRecord(ctx, space.uri, "before");
			const reg = await register(ctx, inbox, space.uri);
			if (!reg.credential)
				return fail(
					`authorizeSpaceSync with notify ${describe(reg.result)}`,
					reg.result.json,
				);
			const since = Date.now();
			await mustCreateRecord(ctx, space.uri, "one");
			const first = await inbox.waitFor(
				updatesFor(space.uri, reg.token, REPO_WRITE, since),
				NOTIFY_TIMEOUT_MS,
			);
			if (!first) return fail("no repoWrite reached the syncer after a write");
			const a = (first.body as { update: Record<string, unknown> }).update;
			await mustCreateRecord(ctx, space.uri, "two");
			const second = await inbox.waitFor(
				(d) =>
					updatesFor(space.uri, reg.token, REPO_WRITE, first.receivedAt)(d) &&
					(d.body as { update: { spaceRev?: unknown } }).update.spaceRev !==
						a.spaceRev,
				NOTIFY_TIMEOUT_MS,
			);
			if (!second)
				return fail("no repoWrite reached the syncer after a second write");
			const b = (second.body as { update: Record<string, unknown> }).update;
			const problems: string[] = [];
			for (const [label, u] of [
				["first", a],
				["second", b],
			] as const) {
				if (u.repo !== ctx.target.did)
					problems.push(`${label} repo ${String(u.repo)}`);
				if (!isTid(u.repoRev))
					problems.push(`${label} repoRev ${String(u.repoRev)}`);
				if (!isTid(u.spaceRev)) problems.push(`${label} has no spaceRev`);
				if (lexBytes(u.data)?.length !== 32)
					problems.push(`${label} data is not 32 bytes`);
			}
			// The first write in the space preceded registration, so both carry one.
			if (a.prevSpaceRev === undefined)
				problems.push("first update has no prevSpaceRev");
			if (b.prevSpaceRev !== a.spaceRev)
				problems.push(
					`second prevSpaceRev ${String(b.prevSpaceRev)} ≠ first spaceRev ${String(a.spaceRev)}`,
				);
			return problems.length
				? fail(problems.join("; "), { first: a, second: b })
				: pass("two repoWrite updates carrying the token; prevSpaceRev chains");
		} finally {
			await deleteProbeSpace(ctx, space.uri);
		}
	},
});

const notifyRepoRemoved = defineCheck({
	id: "notify.repo-removed-delivered",
	title: "removeWriter is announced to registered syncers as repoRemoved",
	tier: "must",
	citations: [
		L("com.atproto.space.removeWriter"),
		L("com.atproto.space.defs#repoRemoved"),
		L("com.atproto.space.notifySpaceUpdate"),
		P("0016#the-sync-boundary-writer-set"),
	],
	needs: ["operator", "syncer-inbox"],
	destructive: true,
	async run(ctx) {
		const inbox = ctx.syncerInbox!;
		const space = await createProbeSpace(ctx, publicRead());
		try {
			await mustCreateRecord(ctx, space.uri, "a");
			const reg = await register(ctx, inbox, space.uri);
			if (!reg.credential)
				return fail(
					`authorizeSpaceSync with notify ${describe(reg.result)}`,
					reg.result.json,
				);
			const since = Date.now();
			const removed = await xrpcPost(
				asOperator(ctx),
				"com.atproto.space.removeWriter",
				{ space: space.uri, repo: ctx.target.did },
			);
			if (removed.status !== 200)
				return fail(`removeWriter ${describe(removed)}`, removed.json);
			const got = await inbox.waitFor(
				updatesFor(space.uri, reg.token, REPO_REMOVED, since),
				NOTIFY_TIMEOUT_MS,
			);
			if (!got) return fail("no repoRemoved reached the syncer");
			const u = (got.body as { update: Record<string, unknown> }).update;
			return u.repo === ctx.target.did &&
				isTid(u.spaceRev) &&
				isTid(u.prevSpaceRev)
				? pass("repoRemoved delivered with spaceRev and prevSpaceRev")
				: fail("repoRemoved fields wrong", u);
		} finally {
			await deleteProbeSpace(ctx, space.uri);
		}
	},
});

const notifySpaceDeleted = defineCheck({
	id: "notify.space-deleted-delivered",
	title: "A registered syncer is sent spaceDeleted when the space is deleted",
	tier: "must",
	citations: [
		L("com.atproto.space.notifySpaceUpdate#spaceDeleted"),
		P("0016#space-deletion"),
	],
	needs: ["operator", "syncer-inbox"],
	destructive: true,
	async run(ctx) {
		const inbox = ctx.syncerInbox!;
		const space = await createProbeSpace(ctx, publicRead());
		let deleted = false;
		try {
			const reg = await register(ctx, inbox, space.uri);
			if (!reg.credential)
				return fail(
					`authorizeSpaceSync with notify ${describe(reg.result)}`,
					reg.result.json,
				);
			const since = Date.now();
			await deleteProbeSpace(ctx, space.uri);
			deleted = true;
			const got = await inbox.waitFor(
				updatesFor(space.uri, reg.token, SPACE_DELETED, since),
				NOTIFY_TIMEOUT_MS,
			);
			return got
				? pass("spaceDeleted delivered")
				: fail(`no spaceDeleted within ${NOTIFY_TIMEOUT_MS / 1000}s`);
		} finally {
			if (!deleted) await deleteProbeSpace(ctx, space.uri);
		}
	},
});

const notifyExpired = defineCheck({
	id: "notify.registration-expired",
	title:
		"Once its credential expires, a registration is sent registrationExpired in place of the next update",
	tier: "must",
	citations: [
		L("com.atproto.space.notifySpaceUpdate#registrationExpired"),
		P("0016#registering-for-notifications"),
	],
	needs: ["operator", "syncer-inbox"],
	destructive: true,
	// Waits out a real credential lifetime (10 minutes by default).
	slow: true,
	timeoutMs: 65 * 60_000,
	async run(ctx) {
		const inbox = ctx.syncerInbox!;
		const space = await createProbeSpace(ctx, publicRead());
		try {
			const reg = await register(ctx, inbox, space.uri);
			if (!reg.credential)
				return fail(
					`authorizeSpaceSync with notify ${describe(reg.result)}`,
					reg.result.json,
				);
			const exp =
				Number(decodeJwt(reg.credential.credential).payload.exp) * 1000;
			await new Promise((r) =>
				setTimeout(r, Math.max(0, exp - Date.now()) + 5_000),
			);
			const since = Date.now();
			await mustCreateRecord(ctx, space.uri, "late");
			const got = await inbox.waitFor(
				(d) =>
					updatesFor(
						space.uri,
						reg.token,
						"com.atproto.space.notifySpaceUpdate#registrationExpired",
						since,
					)(d),
				NOTIFY_TIMEOUT_MS,
			);
			if (!got)
				return fail("no registrationExpired after the credential lapsed");
			const update = (got.body as { update: { spaceRev?: unknown } }).update;
			const write = await inbox.waitFor(
				updatesFor(space.uri, reg.token, REPO_WRITE, since),
				2_000,
			);
			if (write)
				return fail("a lapsed registration still received the repoWrite");
			return isTid(update.spaceRev)
				? pass("registrationExpired sent in place of the update")
				: fail("registrationExpired has no spaceRev", update);
		} finally {
			await deleteProbeSpace(ctx, space.uri);
		}
	},
});

// --- managedspace ------------------------------------------------------

const CHECK_ACCESS = "com.atproto.managedspace.checkAccess";

const managedTokenless = defineCheck({
	id: "managedspace.check-access-tokenless",
	title:
		"Without a delegation token a managedspace asks its managing app, with no repo",
	tier: "must",
	citations: [
		L("com.atproto.managedspace.checkAccess"),
		L("com.atproto.managedspace.policy"),
		P("0016#managedspace"),
	],
	needs: ["operator", "syncer-inbox"],
	destructive: true,
	async run(ctx) {
		const inbox = ctx.syncerInbox!;
		let answer = { read: false, write: false };
		inbox.respond(CHECK_ACCESS, () => answer);
		const space = await createProbeSpace(ctx, managedspace(inbox.service));
		try {
			const since = Date.now();
			const denied = await requestCredential(ctx, space.uri);
			if (denied.credential)
				return fail("issued a credential the managing app refused");
			const asked = await inbox.waitFor(
				(d) => d.lxm === CHECK_ACCESS && d.receivedAt >= since,
				5_000,
			);
			if (!asked)
				return fail(
					`the managing app was never asked (${describe(denied.result)})`,
				);
			const p = asked.params ?? {};
			if (p.space !== space.uri || "repo" in p || "access" in p)
				return fail("checkAccess params wrong for a tokenless request", p);
			const jwt = asked.authorization?.replace(/^Bearer /, "");
			const claims = jwt ? decodeJwt(jwt).payload : undefined;
			if (
				claims?.lxm !== CHECK_ACCESS ||
				claims.iss !== ctx.target.did ||
				claims.aud !== inbox.service
			) {
				return fail(
					"checkAccess service auth does not name the method, the authority and the managing app",
					claims,
				);
			}
			answer = { read: true, write: false };
			const allowed = await requestCredential(ctx, space.uri);
			return allowed.credential
				? pass(
						`asked with no repo under service auth; refused on read:false (${denied.result.error}), issued on read:true`,
					)
				: fail(
						`the managing app allowed reading but the credential was refused: ${describe(allowed.result)}`,
					);
		} finally {
			inbox.respond(CHECK_ACCESS, undefined);
			await deleteProbeSpace(ctx, space.uri);
		}
	},
});

const managedFailsClosed = defineCheck({
	id: "managedspace.unreachable-app-fails-closed",
	title:
		"A managedspace whose managing app cannot be reached issues no credential",
	tier: "must",
	citations: [
		L("com.atproto.managedspace.policy"),
		P("0016#managedspace"),
		{ source: "changeset", ref: "patient-managers-answer" },
	],
	needs: ["operator"],
	destructive: true,
	async run(ctx) {
		const space = await createProbeSpace(
			ctx,
			managedspace("did:web:app.space-conformance.invalid#managing_app"),
		);
		try {
			const res = await requestCredential(ctx, space.uri);
			if (res.credential)
				return fail(
					"issued a credential without an answer from the managing app",
				);
			return pass(`refused (${describe(res.result)})`);
		} finally {
			await deleteProbeSpace(ctx, space.uri);
		}
	},
});

const managedUpstreamFailure = defineCheck({
	id: "managedspace.unreachable-app-upstream-failure",
	title:
		"An unreachable managing app is reported as UpstreamFailure, not a refusal",
	tier: "should",
	citations: [{ source: "changeset", ref: "patient-managers-answer" }],
	needs: ["operator"],
	destructive: true,
	async run(ctx) {
		// Distinct from a denial: a syncer keeps its registration and a repo
		// host retries, rather than reading the failure as lost access.
		const space = await createProbeSpace(
			ctx,
			managedspace("did:web:app.space-conformance.invalid#managing_app"),
		);
		try {
			const res = await requestCredential(ctx, space.uri);
			return res.result.error === "UpstreamFailure"
				? pass("answered UpstreamFailure")
				: fail(`answered ${describe(res.result)}`);
		} finally {
			await deleteProbeSpace(ctx, space.uri);
		}
	},
});

export const hostChecks: Check[] = [
	hostRequiresCredential,
	listWritersShape,
	listWritersReflects,
	removeWriter,
	hostAfterDelete,
	notifyConfirmed,
	notifyRenewal,
	notifyRepoWrite,
	notifyRepoRemoved,
	notifySpaceDeleted,
	notifyExpired,
	managedTokenless,
	managedFailsClosed,
	managedUpstreamFailure,
];
