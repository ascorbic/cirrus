/**
 * The space-host role: the writer set (listRepos, removeWriter) and
 * notification registration (registerNotify / unregisterNotify), plus —
 * when the harness runs a syncer inbox — the notifications the host sends.
 * Browser-safe; the inbox checks need a harness that can receive them.
 */

import { defineCheck } from "../registry.js";
import { asOperator, xrpcGet, xrpcPost } from "../http.js";
import { fail, pass, type Check, type CheckContext, type InboxDelivery } from "../model.js";
import { bytesEqual, isTid, lexBytes } from "../encoding.js";
import {
	FOREIGN_DID,
	createProbeSpace,
	credentialCall,
	deleteProbeSpace,
	describe,
	mustCreateRecord,
	obtainPublicCredential,
	publicRead,
	type Credential,
} from "./probe.js";
import { fakeDid } from "./space.js";

const L = (ref: string) => ({ source: "lexicon" as const, ref });

interface WriterEntry {
	did: string;
	repoRev: unknown;
	data: unknown;
	spaceRev: unknown;
}

async function listRepos(
	ctx: CheckContext,
	credential: Credential,
	params: Record<string, string> = {},
) {
	const res = await credentialCall(ctx, credential, "com.atproto.space.listRepos", {
		params: { space: credential.space, ...params },
		audience: ctx.target.did,
	});
	const body = res.json as { repos?: WriterEntry[]; cursor?: string } | undefined;
	return { res, repos: body?.repos ?? [], cursor: body?.cursor };
}

const hostRequiresCredential = defineCheck({
	id: "host.listrepos-requires-credential",
	title: "listRepos, registerNotify and unregisterNotify refuse an unauthenticated caller",
	tier: "must",
	citations: [
		L("com.atproto.space.listRepos"),
		L("com.atproto.space.registerNotify"),
		L("com.atproto.space.unregisterNotify"),
	],
	needs: ["operator"],
	destructive: true,
	async run(ctx) {
		const space = await createProbeSpace(ctx, publicRead());
		try {
			const probes = [
				["listRepos", await xrpcGet(ctx, "com.atproto.space.listRepos", { space: space.uri })],
				["registerNotify", await xrpcPost(ctx, "com.atproto.space.registerNotify", { space: space.uri, service: ctx.target.did })],
				["unregisterNotify", await xrpcPost(ctx, "com.atproto.space.unregisterNotify", { space: space.uri, service: ctx.target.did })],
			] as const;
			const served = probes.filter(([, r]) => r.status !== 401 && r.status !== 403);
			return served.length
				? fail(`not refused with 401/403: ${served.map(([n, r]) => `${n} → ${describe(r)}`).join("; ")}`)
				: pass("all three refused an unauthenticated caller");
		} finally {
			await deleteProbeSpace(ctx, space.uri);
		}
	},
});

const listReposShape = defineCheck({
	id: "sync.listrepos-shape",
	title: "listRepos lists writers by ascending spaceRev with a spaceRev cursor",
	tier: "must",
	citations: [L("com.atproto.space.listRepos")],
	needs: ["operator"],
	destructive: true,
	async run(ctx) {
		const space = await createProbeSpace(ctx, publicRead());
		try {
			await mustCreateRecord(ctx, space.uri, "a");
			await mustCreateRecord(ctx, space.uri, "b");
			const credential = await obtainPublicCredential(ctx, space.uri);
			const page = await listRepos(ctx, credential);
			if (page.res.status !== 200) return fail(`listRepos ${describe(page.res)}`, page.res.json);
			const problems: string[] = [];
			for (const repo of page.repos) {
				const data = lexBytes(repo.data);
				if (!isTid(repo.repoRev)) problems.push(`${repo.did} repoRev ${String(repo.repoRev)}`);
				if (!isTid(repo.spaceRev)) problems.push(`${repo.did} spaceRev ${String(repo.spaceRev)}`);
				if (!data || data.length !== 32) problems.push(`${repo.did} data is not 32 bytes`);
			}
			const revs = page.repos.map((r) => String(r.spaceRev));
			if (revs.some((rev, i) => i > 0 && rev <= revs[i - 1]!)) problems.push(`not ascending: ${revs.join(",")}`);
			if (!page.repos.some((r) => r.did === ctx.target.did)) problems.push("the authority's own repo is not listed");
			if (page.repos.length && page.cursor !== revs.at(-1)) {
				problems.push(`cursor ${page.cursor} is not the last spaceRev ${revs.at(-1)}`);
			}
			if (problems.length) return fail(problems.join("; "), page.res.json);
			// Resuming from the cursor reaches an empty page, which carries no cursor.
			const next = await listRepos(ctx, credential, { cursor: page.cursor! });
			if (next.res.status !== 200) return fail(`listRepos(cursor) ${describe(next.res)}`, next.res.json);
			return next.repos.length === 0 && next.cursor === undefined
				? pass(`${page.repos.length} writer(s), ascending, cursor resumes to an empty page`)
				: fail(`after the last cursor: ${next.repos.length} repo(s), cursor ${next.cursor}`, next.res.json);
		} finally {
			await deleteProbeSpace(ctx, space.uri);
		}
	},
});

const listReposReflects = defineCheck({
	id: "sync.listrepos-reflects-writes",
	title: "The authority's listRepos entry matches its latest commit",
	tier: "should",
	citations: [
		{ source: "reference", ref: "authority repo notifies its own space host synchronously" },
		L("com.atproto.space.listRepos"),
	],
	needs: ["operator"],
	destructive: true,
	async run(ctx) {
		// The lexicon allows the entry to lag ("as last reported"), so this is
		// calibrated against the reference, which notifies its own host on
		// commit.
		const space = await createProbeSpace(ctx, publicRead());
		try {
			await mustCreateRecord(ctx, space.uri, "a");
			const credential = await obtainPublicCredential(ctx, space.uri);
			const { repos } = await listRepos(ctx, credential);
			const mine = repos.find((r) => r.did === ctx.target.did);
			const latest = await xrpcGet(asOperator(ctx), "com.atproto.space.getLatestCommit", {
				space: space.uri,
				repo: ctx.target.did,
			});
			const commit = (latest.json as { commit?: { rev?: string; data?: unknown } } | undefined)?.commit;
			const a = lexBytes(mine?.data);
			const b = lexBytes(commit?.data);
			return mine && commit && mine.repoRev === commit.rev && a && b && bytesEqual(a, b)
				? pass("repoRev and data match getLatestCommit")
				: fail("listRepos entry differs from the latest commit", { listed: mine, commit });
		} finally {
			await deleteProbeSpace(ctx, space.uri);
		}
	},
});

const removeWriter = defineCheck({
	id: "host.removewriter",
	title: "removeWriter drops a repo from listRepos until it writes again",
	tier: "must",
	citations: [L("com.atproto.space.removeWriter"), L("com.atproto.space.listRepos")],
	needs: ["operator"],
	destructive: true,
	async run(ctx) {
		const space = await createProbeSpace(ctx, publicRead());
		const remove = (did: string) =>
			xrpcPost(asOperator(ctx), "com.atproto.space.removeWriter", { space: space.uri, did });
		try {
			await mustCreateRecord(ctx, space.uri, "a");
			const credential = await obtainPublicCredential(ctx, space.uri);
			const listed = async () => (await listRepos(ctx, credential)).repos.some((r) => r.did === ctx.target.did);
			if (!(await listed())) return fail("the authority's repo was not in the writer set to begin with");
			const removed = await remove(ctx.target.did);
			if (removed.status !== 200) return fail(`removeWriter ${describe(removed)}`, removed.json);
			if (await listed()) return fail("removeWriter left the repo in listRepos");
			// Idempotent: removing an account that isn't a writer succeeds.
			const absent = await remove(fakeDid());
			if (absent.status !== 200) return fail(`removeWriter of a non-writer returned ${describe(absent)}`, absent.json);
			await mustCreateRecord(ctx, space.uri, "b");
			return (await listed())
				? pass("removed, idempotent for a non-writer, and tracked again after a new write")
				: fail("a new write by an authorised account did not return it to the writer set");
		} finally {
			await deleteProbeSpace(ctx, space.uri);
		}
	},
});

const registerRoundTrip = defineCheck({
	id: "host.registernotify-round-trip",
	title: "registerNotify returns a future expiry; unregisterNotify is idempotent",
	tier: "must",
	citations: [L("com.atproto.space.registerNotify"), L("com.atproto.space.unregisterNotify")],
	needs: ["operator"],
	destructive: true,
	async run(ctx) {
		const space = await createProbeSpace(ctx, publicRead());
		try {
			const credential = await obtainPublicCredential(ctx, space.uri);
			// A bare DID names an account, served by its #atproto_pds — the
			// target's own DID is the one service identifier sure to resolve.
			const call = (nsid: string) =>
				credentialCall(ctx, credential, nsid, {
					body: { space: space.uri, service: ctx.target.did },
					audience: ctx.target.did,
				});
			const reg = await call("com.atproto.space.registerNotify");
			if (reg.status !== 200) return fail(`registerNotify ${describe(reg)}`, reg.json);
			const expiresAt = Date.parse(String((reg.json as { expiresAt?: unknown }).expiresAt));
			if (!(expiresAt > Date.now())) return fail("expiresAt is not a future datetime", reg.json);
			const un1 = await call("com.atproto.space.unregisterNotify");
			const un2 = await call("com.atproto.space.unregisterNotify");
			return un1.status === 200 && un2.status === 200
				? pass("registered with a future expiry; unregistered twice")
				: fail(`unregisterNotify returned ${describe(un1)} then ${describe(un2)}`, { first: un1.json, second: un2.json });
		} finally {
			await deleteProbeSpace(ctx, space.uri);
		}
	},
});

const registerUnresolvable = defineCheck({
	id: "host.registernotify-unresolvable",
	title: "registerNotify for a service that does not resolve answers ServiceNotResolvable",
	tier: "must",
	citations: [L("com.atproto.space.registerNotify@error:ServiceNotResolvable")],
	needs: ["operator"],
	destructive: true,
	async run(ctx) {
		const space = await createProbeSpace(ctx, publicRead());
		try {
			const credential = await obtainPublicCredential(ctx, space.uri);
			const res = await credentialCall(ctx, credential, "com.atproto.space.registerNotify", {
				body: { space: space.uri, service: `${FOREIGN_DID}#space_syncer` },
				audience: ctx.target.did,
			});
			return res.error === "ServiceNotResolvable"
				? pass("answered ServiceNotResolvable")
				: fail(`answered ${describe(res)}, expected ServiceNotResolvable`, res.json);
		} finally {
			await deleteProbeSpace(ctx, space.uri);
		}
	},
});

const hostAfterDelete = defineCheck({
	id: "host.deleted-space-not-found",
	title: "Space-host methods on a deleted space answer SpaceNotFound",
	tier: "must",
	citations: [
		L("com.atproto.space.listRepos@error:SpaceNotFound"),
		L("com.atproto.space.registerNotify@error:SpaceNotFound"),
		L("com.atproto.space.unregisterNotify@error:SpaceNotFound"),
	],
	needs: ["operator"],
	destructive: true,
	async run(ctx) {
		// A credential issued before deletion is still a well-formed, unexpired
		// credential; what has gone is the space.
		const space = await createProbeSpace(ctx, publicRead());
		const credential = await obtainPublicCredential(ctx, space.uri);
		await deleteProbeSpace(ctx, space.uri);
		const body = { space: space.uri, service: ctx.target.did };
		const probes = [
			["listRepos", await listRepos(ctx, credential).then((r) => r.res)],
			["registerNotify", await credentialCall(ctx, credential, "com.atproto.space.registerNotify", { body, audience: ctx.target.did })],
			["unregisterNotify", await credentialCall(ctx, credential, "com.atproto.space.unregisterNotify", { body, audience: ctx.target.did })],
		] as const;
		const misses = probes.filter(([, r]) => r.error !== "SpaceNotFound");
		return misses.length
			? fail(`expected SpaceNotFound: ${misses.map(([n, r]) => `${n} → ${describe(r)}`).join("; ")}`)
			: pass("all three answered SpaceNotFound");
	},
});

// --- deliveries to a harness syncer --------------------------------------

const NOTIFY_TIMEOUT_MS = 10_000;

const forwardedNotifyWrite = defineCheck({
	id: "notify.forwarded-notifywrite",
	title: "A registered syncer receives sequenced notifyWrite calls",
	tier: "must",
	citations: [L("com.atproto.space.notifyWrite"), L("com.atproto.space.registerNotify")],
	needs: ["operator", "syncer-inbox"],
	destructive: true,
	async run(ctx) {
		const inbox = ctx.syncerInbox!;
		const space = await createProbeSpace(ctx, publicRead());
		try {
			await mustCreateRecord(ctx, space.uri, "before");
			const credential = await obtainPublicCredential(ctx, space.uri);
			const reg = await credentialCall(ctx, credential, "com.atproto.space.registerNotify", {
				body: { space: space.uri, service: inbox.service },
				audience: ctx.target.did,
			});
			if (reg.status !== 200) return fail(`registerNotify ${describe(reg)}`, reg.json);
			const forThis = (d: InboxDelivery) =>
				d.lxm === "com.atproto.space.notifyWrite" &&
				(d.body as { space?: string } | undefined)?.space === space.uri;
			const since = Date.now();
			await mustCreateRecord(ctx, space.uri, "one");
			const first = await inbox.waitFor((d) => forThis(d) && d.receivedAt >= since, NOTIFY_TIMEOUT_MS);
			if (!first) return fail("no notifyWrite reached the syncer after a write");
			const a = first.body as Record<string, unknown>;
			await mustCreateRecord(ctx, space.uri, "two");
			const second = await inbox.waitFor(
				(d) => forThis(d) && (d.body as { spaceRev?: string }).spaceRev !== a.spaceRev && d.receivedAt >= first.receivedAt,
				NOTIFY_TIMEOUT_MS,
			);
			if (!second) return fail("no notifyWrite reached the syncer after a second write");
			const b = second.body as Record<string, unknown>;
			const problems: string[] = [];
			for (const [label, body] of [["first", a], ["second", b]] as const) {
				if (body.repo !== ctx.target.did) problems.push(`${label} repo ${String(body.repo)}`);
				if (!isTid(body.repoRev)) problems.push(`${label} repoRev ${String(body.repoRev)}`);
				if (!isTid(body.spaceRev)) problems.push(`${label} has no spaceRev`);
				if (lexBytes(body.data)?.length !== 32) problems.push(`${label} data is not 32 bytes`);
			}
			if (b.prevSpaceRev !== a.spaceRev) problems.push(`second prevSpaceRev ${String(b.prevSpaceRev)} ≠ first spaceRev ${String(a.spaceRev)}`);
			if (!second.authorization?.startsWith("Bearer ")) problems.push("delivered without service auth");
			return problems.length
				? fail(problems.join("; "), { first: a, second: b })
				: pass("two sequenced deliveries; prevSpaceRev chains to the previous spaceRev");
		} finally {
			await deleteProbeSpace(ctx, space.uri);
		}
	},
});

const spaceDeletedDelivered = defineCheck({
	id: "notify.space-deleted-delivered",
	title: "A registered syncer is sent notifySpaceDeleted when the space is deleted",
	tier: "must",
	citations: [L("com.atproto.space.notifySpaceDeleted"), L("com.atproto.space.deleteSpace")],
	needs: ["operator", "syncer-inbox"],
	destructive: true,
	async run(ctx) {
		const inbox = ctx.syncerInbox!;
		const space = await createProbeSpace(ctx, publicRead());
		let deleted = false;
		try {
			const credential = await obtainPublicCredential(ctx, space.uri);
			const reg = await credentialCall(ctx, credential, "com.atproto.space.registerNotify", {
				body: { space: space.uri, service: inbox.service },
				audience: ctx.target.did,
			});
			if (reg.status !== 200) return fail(`registerNotify ${describe(reg)}`, reg.json);
			await deleteProbeSpace(ctx, space.uri);
			deleted = true;
			const got = await inbox.waitFor(
				(d) =>
					d.lxm === "com.atproto.space.notifySpaceDeleted" &&
					(d.body as { space?: string } | undefined)?.space === space.uri,
				NOTIFY_TIMEOUT_MS,
			);
			return got
				? pass("notifySpaceDeleted delivered")
				: fail(`no notifySpaceDeleted within ${NOTIFY_TIMEOUT_MS / 1000}s`);
		} finally {
			if (!deleted) await deleteProbeSpace(ctx, space.uri);
		}
	},
});

export const hostChecks: Check[] = [
	hostRequiresCredential,
	listReposShape,
	listReposReflects,
	removeWriter,
	registerRoundTrip,
	registerUnresolvable,
	hostAfterDelete,
	forwardedNotifyWrite,
	spaceDeletedDelivered,
];
