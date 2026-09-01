/**
 * Operator checks: everything an authenticated session can prove with the
 * platform's own `fetch` and WebCrypto — no alpha crypto libs, no foreign
 * identities. They run wherever the base checks run, browsers included, as
 * long as the harness supplies an `operator` capability (and, for the
 * blob and credential checks, `pds-blobs` / `pds-delegation`).
 *
 * The split matters: checks live here or in `../full/checks.js` by what
 * they *actually import*, not by topic. A check that only makes authed
 * XRPC calls belongs here even if its subject is credentials — the
 * operator's own delegation → credential → read flow needs nothing but an
 * ES256 JWT the browser can mint.
 */

import { defineCheck } from "../registry.js";
import {
	asOperator,
	operatorFetch,
	xrpcGet,
	xrpcPost,
	type XrpcResult,
} from "../http.js";
import {
	fail,
	pass,
	type Check,
	type CheckContext,
	type DpopKey,
} from "../model.js";
import { createDpopKey, createDpopProofJwt } from "../dpop.js";
import { readCarHeader } from "../car.js";

// The probe collections and space type are published, resolvable
// lexicons under the suite's own authority (see ../../probe-lexicons) —
// so strict, dynamically-resolving targets can validate them, while
// AppViews ignore them (nothing under earth.cirrus.check.* is app.bsky.*).
export const POST = "earth.cirrus.check.note";
export const note = (text: string) => ({ $type: POST, text });

const PROBE_TYPE = "earth.cirrus.check.space";

export interface ProbeSpace {
	uri: string;
	type: string;
	skey: string;
}

/** A run-unique skey so probe spaces never collide with real ones. */
function probeSkey(): string {
	const rand = crypto.getRandomValues(new Uint8Array(8));
	return `probe${Array.from(rand, (b) => b.toString(36))
		.join("")
		.slice(0, 10)}`;
}

/**
 * Create a probe space owned by the target and cache it for the run.
 * Requires an operator session with space management authority.
 */
export async function createProbeSpace(
	ctx: CheckContext,
	policy: Record<string, unknown> = {
		$type: "com.atproto.simplespace.defs#memberListPolicy",
	},
	appAccess: Record<string, unknown> = {
		$type: "com.atproto.simplespace.defs#open",
	},
): Promise<ProbeSpace> {
	const skey = probeSkey();
	const res = await xrpcPost(
		asOperator(ctx),
		"com.atproto.simplespace.createSpace",
		{
			type: PROBE_TYPE,
			skey,
			policy,
			appAccess,
		},
	);
	if (res.status !== 200) {
		throw new Error(
			`createSpace failed: ${res.status} ${res.error ?? ""} ${JSON.stringify(res.json)}`,
		);
	}
	const uri = (res.json as { uri: string }).uri;
	return { uri, type: PROBE_TYPE, skey };
}

/** Delete a probe space, best-effort (cleanup). */
export async function deleteProbeSpace(
	ctx: CheckContext,
	space: string,
): Promise<void> {
	await xrpcPost(asOperator(ctx), "com.atproto.simplespace.deleteSpace", {
		space,
	}).catch(() => {});
}

/** Operator creates a record in a space; returns the response. */
export async function operatorCreateRecord(
	ctx: CheckContext,
	space: string,
	collection: string,
	rkey: string,
	record: Record<string, unknown>,
): Promise<XrpcResult> {
	return xrpcPost(asOperator(ctx), "com.atproto.space.createRecord", {
		space,
		repo: ctx.target.did,
		collection,
		rkey,
		record,
	});
}

export interface Credential {
	credential: string;
	dpopKey: DpopKey;
}

/**
 * Obtain a credential the way a real app does: ask the target's own
 * `getDelegationToken` (with the operator session) for a delegation token,
 * then exchange it at `getSpaceCredential`. This is the bulletin self-flow
 * — it needs no harness-held reader key, so it runs against any real PDS
 * (Cirrus, the reference) and exercises the target's own token minting.
 */
export async function obtainCredentialViaDelegation(
	ctx: CheckContext,
	space: string,
): Promise<{
	result: XrpcResult;
	credential?: Credential;
	delegation: XrpcResult;
}> {
	const delegation = await xrpcGet(
		asOperator(ctx),
		"com.atproto.space.getDelegationToken",
		{ space },
	);
	if (delegation.status !== 200) {
		return { result: delegation, delegation };
	}
	const token = (delegation.json as { token: string }).token;
	// The DPoP key is transport-owned (any ES256 key), not tied to a harness
	// identity — so this flow needs no identity provider.
	const dpopKey = await createDpopKey();
	const proof = await createDpopProofJwt(dpopKey, {
		htm: "POST",
		htu: `${ctx.target.origin}/xrpc/com.atproto.space.getSpaceCredential`,
	});
	const result = await xrpcPost(
		ctx,
		"com.atproto.space.getSpaceCredential",
		{ space },
		{ Authorization: `Bearer ${token}`, DPoP: proof },
	);
	if (result.status === 200) {
		const credential = (result.json as { credential: string }).credential;
		return { result, credential: { credential, dpopKey }, delegation };
	}
	return { result, delegation };
}

/** A credential-authenticated GET, with a fresh proof bound to the request. */
export async function credentialGet(
	ctx: CheckContext,
	credential: Credential,
	nsid: string,
	params: Record<string, string | undefined>,
): Promise<XrpcResult> {
	const url = new URL(`${ctx.target.origin}/xrpc/${nsid}`);
	for (const [key, value] of Object.entries(params)) {
		if (value !== undefined) url.searchParams.set(key, value);
	}
	const proof = await createDpopProofJwt(credential.dpopKey, {
		htm: "GET",
		htu: `${ctx.target.origin}/xrpc/${nsid}`,
		credential: credential.credential,
	});
	const response = await ctx.fetch(url.toString(), {
		method: "GET",
		headers: {
			Authorization: `DPoP ${credential.credential}`,
			DPoP: proof,
		},
	});
	const contentType = response.headers.get("Content-Type") ?? "";
	let json: unknown;
	let error: string | undefined;
	if (contentType.includes("application/json")) {
		json = await response
			.clone()
			.json()
			.catch(() => undefined);
		if (json && typeof json === "object" && "error" in json) {
			error = String((json as { error: unknown }).error);
		}
	}
	return {
		status: response.status,
		json,
		error,
		headers: response.headers,
		response,
	};
}

// --- writes -----------------------------------------------------------

const writesCreateRead = defineCheck({
	id: "writes.create-and-read",
	title: "Operator creates a record and reads it back",
	tier: "must",
	citations: [
		{ source: "lexicon", ref: "com.atproto.space.createRecord" },
		{ source: "lexicon", ref: "com.atproto.space.getRecord" },
	],
	needs: ["operator"],
	destructive: true,
	async run(ctx) {
		const space = await createProbeSpace(ctx);
		try {
			const created = await operatorCreateRecord(
				ctx,
				space.uri,
				POST,
				"rec1",
				note("hello"),
			);
			if (created.status !== 200) {
				return fail(
					`createRecord ${created.status} ${created.error ?? ""}`,
					created.json,
				);
			}
			const read = await xrpcGet(
				asOperator(ctx),
				"com.atproto.space.getRecord",
				{
					space: space.uri,
					repo: ctx.target.did,
					collection: POST,
					rkey: "rec1",
				},
			);
			if (read.status !== 200) {
				return fail(`getRecord ${read.status} ${read.error ?? ""}`, read.json);
			}
			const value = (read.json as { value?: { text?: string } }).value;
			return value?.text === "hello"
				? pass("round-tripped the record value")
				: fail("record value did not round-trip", read.json);
		} finally {
			await deleteProbeSpace(ctx, space.uri);
		}
	},
});

const writesUnauthReadRefused = defineCheck({
	id: "auth.existing-record-unauth-refused",
	title: "An existing space record is not readable without auth",
	tier: "must",
	citations: [{ source: "lexicon", ref: "com.atproto.space.getRecord" }],
	needs: ["operator"],
	destructive: true,
	async run(ctx) {
		// The browser-safe auth.getrecord-unauthenticated-refused can only
		// probe a *nonexistent* space (it has no operator to create one), so on
		// its own it cannot distinguish a host that enforces auth from one that
		// 401s missing spaces but serves existing records to anyone. This is
		// the other half: put a real record there, then read it with no
		// credentials at all.
		const space = await createProbeSpace(ctx);
		try {
			const created = await operatorCreateRecord(
				ctx,
				space.uri,
				POST,
				"private",
				note("not for you"),
			);
			if (created.status !== 200) {
				return fail(
					`createRecord ${created.status} ${created.error ?? ""}; cannot probe the unauth read`,
					created.json,
				);
			}
			const res = await xrpcGet(ctx, "com.atproto.space.getRecord", {
				space: space.uri,
				repo: ctx.target.did,
				collection: POST,
				rkey: "private",
			});
			if (res.status === 200) {
				return fail(
					"an existing space record was served with no auth",
					res.json,
				);
			}
			return res.status === 401 || res.status === 403
				? pass(`unauthenticated read of a real record refused (${res.status})`)
				: fail(
						`refused, but with ${res.status} ${res.error ?? ""} rather than 401/403`,
						res.json,
					);
		} finally {
			await deleteProbeSpace(ctx, space.uri);
		}
	},
});

const writesDuplicate = defineCheck({
	id: "writes.duplicate-rejected",
	title: "A second create at the same key is refused with RecordAlreadyExists",
	tier: "must",
	citations: [
		{
			source: "lexicon",
			ref: "com.atproto.space.createRecord@error:RecordAlreadyExists",
		},
	],
	needs: ["operator"],
	destructive: true,
	async run(ctx) {
		const space = await createProbeSpace(ctx);
		try {
			const first = await operatorCreateRecord(
				ctx,
				space.uri,
				POST,
				"dup",
				note("one"),
			);
			if (first.status !== 200) {
				return fail(
					`first create failed (${first.status}); cannot test duplicates`,
					first.json,
				);
			}
			const second = await operatorCreateRecord(
				ctx,
				space.uri,
				POST,
				"dup",
				note("two"),
			);
			if (second.status === 200) return fail("duplicate create returned 200");
			return second.error === "RecordAlreadyExists"
				? pass("refused with RecordAlreadyExists")
				: fail(
						`refused but error was ${second.error} (${second.status})`,
						second.json,
					);
		} finally {
			await deleteProbeSpace(ctx, space.uri);
		}
	},
});

const writesDeleteIdempotent = defineCheck({
	id: "writes.delete-idempotent",
	title: "deleteRecord removes the record and is idempotent",
	tier: "must",
	citations: [
		{ source: "lexicon", ref: "com.atproto.space.deleteRecord" },
		{ source: "lexicon", ref: "com.atproto.space.getRecord" },
	],
	needs: ["operator"],
	destructive: true,
	async run(ctx) {
		const space = await createProbeSpace(ctx);
		try {
			const del = (rkey: string) =>
				xrpcPost(asOperator(ctx), "com.atproto.space.deleteRecord", {
					space: space.uri,
					repo: ctx.target.did,
					collection: POST,
					rkey,
				});

			// Effect first: a delete must actually remove the record. Without
			// this, a deleteRecord that is a complete no-op (200, nothing
			// happens) would pass on idempotency alone.
			const created = await operatorCreateRecord(
				ctx,
				space.uri,
				POST,
				"doomed",
				note("bye"),
			);
			if (created.status !== 200) {
				return fail(
					`createRecord ${created.status} ${created.error ?? ""}; cannot test deletion`,
					created.json,
				);
			}
			const removed = await del("doomed");
			if (removed.status !== 200) {
				return fail(
					`delete of an existing record returned ${removed.status} ${removed.error ?? ""}`,
					removed.json,
				);
			}
			const after = await xrpcGet(
				asOperator(ctx),
				"com.atproto.space.getRecord",
				{
					space: space.uri,
					repo: ctx.target.did,
					collection: POST,
					rkey: "doomed",
				},
			);
			if (after.status === 200) {
				return fail("a deleted record was still readable", after.json);
			}

			// Then idempotency: deleting it again (and deleting a key that
			// never existed) both succeed.
			const again = await del("doomed");
			const ghost = await del("ghost");
			if (again.status !== 200 || ghost.status !== 200) {
				return fail(
					`repeat delete returned ${again.status}, absent-key delete returned ${ghost.status}`,
					{ again: again.json, ghost: ghost.json },
				);
			}
			return pass("delete removed the record; repeat and absent deletes 200");
		} finally {
			await deleteProbeSpace(ctx, space.uri);
		}
	},
});

const writesApplyWritesAtomic = defineCheck({
	id: "writes.applywrites-atomic",
	title: "A failing applyWrites batch commits nothing",
	tier: "must",
	citations: [
		{ source: "lexicon", ref: "com.atproto.space.applyWrites" },
		{
			source: "lexicon",
			ref: "com.atproto.space.applyWrites@error:RecordAlreadyExists",
		},
	],
	needs: ["operator"],
	destructive: true,
	async run(ctx) {
		const space = await createProbeSpace(ctx);
		const op = asOperator(ctx);
		try {
			await operatorCreateRecord(ctx, space.uri, POST, "exists", note("here"));

			// Positive control: a non-colliding batch must commit both ops.
			// Without this, a target that has no applyWrites at all (404s the
			// method) would pass the rollback assertion below vacuously.
			const ok = await xrpcPost(op, "com.atproto.space.applyWrites", {
				space: space.uri,
				repo: ctx.target.did,
				writes: [
					{
						$type: "com.atproto.space.applyWrites#create",
						collection: POST,
						rkey: "ok1",
						value: note("1"),
					},
					{
						$type: "com.atproto.space.applyWrites#create",
						collection: POST,
						rkey: "ok2",
						value: note("2"),
					},
				],
			});
			if (ok.status !== 200) {
				return fail(
					`applyWrites did not accept a valid batch (${ok.status} ${ok.error ?? ""})`,
					ok.json,
				);
			}

			// A batch whose second op collides must fail with
			// RecordAlreadyExists and roll the first op back.
			const batch = await xrpcPost(op, "com.atproto.space.applyWrites", {
				space: space.uri,
				repo: ctx.target.did,
				writes: [
					{
						$type: "com.atproto.space.applyWrites#create",
						collection: POST,
						rkey: "fresh",
						value: note("new"),
					},
					{
						$type: "com.atproto.space.applyWrites#create",
						collection: POST,
						rkey: "exists",
						value: note("collide"),
					},
				],
			});
			if (batch.status === 200) return fail("colliding batch returned 200");
			if (batch.error !== "RecordAlreadyExists") {
				return fail(
					`colliding batch refused with ${batch.error} (${batch.status}), expected RecordAlreadyExists`,
					batch.json,
				);
			}
			const check = await xrpcGet(op, "com.atproto.space.getRecord", {
				space: space.uri,
				repo: ctx.target.did,
				collection: POST,
				rkey: "fresh",
			});
			return check.status !== 200
				? pass("a failed batch committed nothing")
				: fail("a failed batch left its first op committed", check.json);
		} finally {
			await deleteProbeSpace(ctx, space.uri);
		}
	},
});

// --- credential (self-flow) -------------------------------------------

const credentialSelfRoundTrip = defineCheck({
	id: "credential.self-round-trip",
	title:
		"Operator obtains a credential for its own space via getDelegationToken and reads",
	tier: "must",
	citations: [
		{ source: "lexicon", ref: "com.atproto.space.getDelegationToken" },
		{ source: "lexicon", ref: "com.atproto.space.getSpaceCredential" },
		{ source: "lexicon", ref: "com.atproto.space.getRecord" },
	],
	// Needs the target's own getDelegationToken (pds-delegation) plus an
	// operator session. No harness identity — the operator is its own
	// reader — so this runs against any real PDS, unlike credential.round-trip.
	needs: ["operator", "pds-delegation"],
	destructive: true,
	async run(ctx) {
		const space = await createProbeSpace(ctx, {
			$type: "com.atproto.simplespace.defs#publicPolicy",
		});
		try {
			await operatorCreateRecord(ctx, space.uri, POST, "self", note("mine"));
			const { result, credential, delegation } =
				await obtainCredentialViaDelegation(ctx, space.uri);
			if (delegation.status !== 200) {
				return fail(
					`getDelegationToken ${delegation.status} ${delegation.error ?? ""}`,
					delegation.json,
				);
			}
			if (!credential) {
				return fail(
					`getSpaceCredential ${result.status} ${result.error ?? ""}`,
					result.json,
				);
			}
			const read = await credentialGet(
				ctx,
				credential,
				"com.atproto.space.getRecord",
				{
					space: space.uri,
					repo: ctx.target.did,
					collection: POST,
					rkey: "self",
				},
			);
			return read.status === 200
				? pass("delegation → credential → read round-trip works")
				: fail(
						`credential read failed: ${read.status} ${read.error ?? ""}`,
						read.json,
					);
		} finally {
			await deleteProbeSpace(ctx, space.uri);
		}
	},
});

// --- sync --------------------------------------------------------------

const syncGetRepoTwoRoots = defineCheck({
	id: "sync.getrepo-two-roots",
	title: "getRepo returns a CAR declaring exactly two roots",
	tier: "must",
	citations: [{ source: "lexicon", ref: "com.atproto.space.getRepo" }],
	needs: ["operator"],
	destructive: true,
	async run(ctx) {
		const space = await createProbeSpace(ctx);
		try {
			await operatorCreateRecord(ctx, space.uri, POST, "x", note("car"));
			const res = await operatorFetch(ctx)(
				`${ctx.target.origin}/xrpc/com.atproto.space.getRepo?space=${encodeURIComponent(space.uri)}&repo=${encodeURIComponent(ctx.target.did)}`,
			);
			if (res.status !== 200) return fail(`getRepo ${res.status}`);
			const contentType = res.headers.get("Content-Type") ?? "";
			if (!contentType.includes("application/vnd.ipld.car")) {
				return fail(`getRepo content-type was ${contentType}`);
			}
			const bytes = new Uint8Array(await res.arrayBuffer());
			const header = readCarHeader(bytes);
			return header.rootCount === 2
				? pass(`CAR v${header.version} with 2 roots`)
				: fail(`CAR declared ${header.rootCount} roots, expected 2`);
		} finally {
			await deleteProbeSpace(ctx, space.uri);
		}
	},
});

const syncListRecordsDescending = defineCheck({
	id: "sync.listrecords-descending-default",
	title: "listRecords defaults to descending record order",
	tier: "should",
	citations: [
		{ source: "reference", ref: "listRecords default order (descending)" },
		{ source: "lexicon", ref: "com.atproto.space.listRecords" },
	],
	needs: ["operator"],
	destructive: true,
	async run(ctx) {
		const space = await createProbeSpace(ctx);
		try {
			for (const rkey of ["aaa", "bbb", "ccc"]) {
				await operatorCreateRecord(ctx, space.uri, POST, rkey, note(rkey));
			}
			const res = await xrpcGet(
				asOperator(ctx),
				"com.atproto.space.listRecords",
				{
					space: space.uri,
					repo: ctx.target.did,
					collection: POST,
				},
			);
			if (res.status !== 200) return fail(`listRecords ${res.status}`);
			const rkeys = (
				res.json as { records: Array<{ rkey: string }> }
			).records.map((r) => r.rkey);
			return rkeys.join(",") === "ccc,bbb,aaa"
				? pass("records returned descending by default")
				: fail(`order was ${rkeys.join(",")}, reference is descending`);
		} finally {
			await deleteProbeSpace(ctx, space.uri);
		}
	},
});

// --- host role ---------------------------------------------------------

const hostListReposNeedsCredential = defineCheck({
	id: "host.listrepos-requires-credential",
	title: "listRepos requires a space credential",
	tier: "must",
	citations: [{ source: "lexicon", ref: "com.atproto.space.listRepos" }],
	needs: ["operator"],
	destructive: true,
	async run(ctx) {
		const space = await createProbeSpace(ctx);
		try {
			const res = await xrpcGet(ctx, "com.atproto.space.listRepos", {
				space: space.uri,
			});
			return res.status === 401 || res.status === 403
				? pass(`unauthenticated listRepos refused with ${res.status}`)
				: fail(`unauthenticated listRepos returned ${res.status}`, res.json);
		} finally {
			await deleteProbeSpace(ctx, space.uri);
		}
	},
});

// --- simplespace -------------------------------------------------------

const simplespaceUnsupportedPolicy = defineCheck({
	id: "simplespace.unsupported-policy-rejected",
	title: "createSpace rejects an unknown policy variant",
	tier: "must",
	citations: [
		{
			source: "lexicon",
			ref: "com.atproto.simplespace.createSpace@error:UnsupportedPolicy",
		},
	],
	needs: ["operator"],
	async run(ctx) {
		const res = await xrpcPost(
			asOperator(ctx),
			"com.atproto.simplespace.createSpace",
			{
				type: PROBE_TYPE,
				policy: { $type: "com.example.mysteryPolicy" },
				appAccess: { $type: "com.atproto.simplespace.defs#open" },
			},
		);
		if (res.status === 200) {
			await deleteProbeSpace(ctx, (res.json as { uri: string }).uri);
			return fail("an unknown policy variant was accepted");
		}
		return res.error === "UnsupportedPolicy"
			? pass("rejected with UnsupportedPolicy")
			: fail(
					`rejected with ${res.error} (${res.status}), expected UnsupportedPolicy`,
					res.json,
				);
	},
});

const simplespaceGetSpace = defineCheck({
	id: "simplespace.getspace-reflects-config",
	title: "getSpace reflects the created policy and appAccess",
	tier: "must",
	citations: [
		{ source: "lexicon", ref: "com.atproto.simplespace.createSpace" },
		{ source: "lexicon", ref: "com.atproto.simplespace.getSpace" },
	],
	needs: ["operator"],
	destructive: true,
	async run(ctx) {
		const space = await createProbeSpace(ctx, {
			$type: "com.atproto.simplespace.defs#publicPolicy",
		});
		try {
			const res = await xrpcGet(
				asOperator(ctx),
				"com.atproto.simplespace.getSpace",
				{
					space: space.uri,
				},
			);
			if (res.status !== 200)
				return fail(`getSpace ${res.status} ${res.error ?? ""}`, res.json);
			const body = res.json as {
				policy?: { $type?: string };
				appAccess?: { $type?: string };
			};
			const policyType = body.policy?.$type;
			if (policyType !== "com.atproto.simplespace.defs#publicPolicy") {
				return fail(`getSpace policy was ${policyType}`, res.json);
			}
			// The title promises appAccess too — createProbeSpace passed #open.
			const appAccessType = body.appAccess?.$type;
			return appAccessType === "com.atproto.simplespace.defs#open"
				? pass("getSpace reported the public policy and open appAccess")
				: fail(`getSpace appAccess was ${appAccessType}`, res.json);
		} finally {
			await deleteProbeSpace(ctx, space.uri);
		}
	},
});

// --- blobs -------------------------------------------------------------

/** Blob isolation (S6): a space blob is never public. */
const blobsSpaceNotPublic = defineCheck({
	id: "blobs.space-blob-not-public",
	title: "A blob is not publicly served unless a public record references it",
	tier: "must",
	citations: [
		{ source: "lexicon", ref: "com.atproto.space.getBlob" },
		{ source: "proposal", ref: "0016#blob-sync" },
	],
	// uploadBlob and sync.getBlob are host-PDS endpoints, not space methods —
	// a standalone space host has neither, so gate on pds-blobs or this
	// check would false-fail wherever they are absent.
	needs: ["operator", "pds-blobs"],
	destructive: true,
	async run(ctx) {
		// The principle under test is a positive gate, not cleanup: a blob must
		// never be publicly addressable until a *public* record references it.
		// Probe both slices of that — freshly uploaded (unreferenced), then
		// referenced only from a space. Serving either from the public
		// sync.getBlob leaks bytes the proposal says are fetched via the
		// credential-gated space.getBlob.
		const space = await createProbeSpace(ctx);
		try {
			const bytes = crypto.getRandomValues(new Uint8Array(16));
			const upload = await operatorFetch(ctx)(
				`${ctx.target.origin}/xrpc/com.atproto.repo.uploadBlob`,
				{
					method: "POST",
					headers: { "Content-Type": "application/octet-stream" },
					body: bytes,
				},
			);
			if (upload.status !== 200) return fail(`uploadBlob ${upload.status}`);
			const blob = (
				(await upload.json()) as { blob: { ref: { $link: string } } }
			).blob;
			const cid = blob.ref.$link;
			const publicUrl = `${ctx.target.origin}/xrpc/com.atproto.sync.getBlob?did=${encodeURIComponent(ctx.target.did)}&cid=${cid}`;

			const stagedGet = await ctx.fetch(publicUrl);
			if (stagedGet.status === 200) {
				return fail(
					"an uploaded, unreferenced blob was served by the public sync.getBlob",
				);
			}

			const write = await operatorCreateRecord(
				ctx,
				space.uri,
				"earth.cirrus.check.withblob",
				"self",
				{
					$type: "earth.cirrus.check.withblob",
					file: blob,
				},
			);
			if (write.status !== 200)
				return fail(
					`referencing write ${write.status} ${write.error ?? ""}`,
					write.json,
				);
			const publicGet = await ctx.fetch(publicUrl);
			return publicGet.status === 200
				? fail("a space blob was served by the public sync.getBlob")
				: pass(
						`public sync.getBlob refused the blob unreferenced (${stagedGet.status}) and space-referenced (${publicGet.status})`,
					);
		} finally {
			await deleteProbeSpace(ctx, space.uri);
		}
	},
});

/**
 * The operator catalog: runnable anywhere the harness has an operator
 * session — browser included.
 */
export const operatorChecks: Check[] = [
	writesCreateRead,
	writesUnauthReadRefused,
	writesDuplicate,
	writesDeleteIdempotent,
	writesApplyWritesAtomic,
	credentialSelfRoundTrip,
	syncGetRepoTwoRoots,
	syncListRecordsDescending,
	hostListReposNeedsCredential,
	simplespaceUnsupportedPolicy,
	simplespaceGetSpace,
	blobsSpaceNotPublic,
];
