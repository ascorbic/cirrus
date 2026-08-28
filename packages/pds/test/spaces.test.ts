import { describe, expect, it } from "vitest";
import { env, worker } from "./helpers";

const authed = {
	"Content-Type": "application/json",
	Authorization: `Bearer ${env.AUTH_TOKEN}`,
};

function get(path: string, headers: Record<string, string> = {}) {
	return worker.fetch(new Request(`http://pds.test${path}`, { headers }), env);
}

function post(
	path: string,
	body: unknown,
	headers: Record<string, string> = authed,
) {
	return worker.fetch(
		new Request(`http://pds.test${path}`, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
		}),
		env,
	);
}

let spaceN = 0;
async function createSpace(): Promise<string> {
	const res = await post("/xrpc/com.atproto.simplespace.createSpace", {
		type: "app.bsky.group",
		skey: `pds${spaceN++}x`,
		policy: { $type: "com.atproto.simplespace.defs#memberListPolicy" },
		appAccess: { $type: "com.atproto.simplespace.defs#open" },
	});
	expect(res.status).toBe(200);
	return ((await res.json()) as { uri: string }).uri;
}

describe("spaces integration", () => {
	it("advertises the space host in the DID document", async () => {
		const res = await get("/.well-known/did.json");
		const doc = (await res.json()) as {
			service: Array<{ id: string; type: string; serviceEndpoint: string }>;
			verificationMethod: Array<{ id: string }>;
		};
		const entry = doc.service.find((s) => s.id === "#atproto_space_host");
		expect(entry).toMatchObject({
			type: "AtprotoSpaceHost",
			serviceEndpoint: `https://${env.PDS_HOSTNAME}`,
		});
		// No dedicated #atproto_space verification key: the proposal falls
		// back to #atproto.
		expect(
			doc.verificationMethod.some((m) => m.id.endsWith("#atproto_space")),
		).toBe(false);
	});

	it("stores and returns private records (S1)", async () => {
		const space = await createSpace();
		const create = await post("/xrpc/com.atproto.space.createRecord", {
			space,
			repo: env.DID,
			collection: "test.cirrus.note",
			rkey: "note1",
			record: { $type: "test.cirrus.note", text: "private note" },
		});
		expect(create.status).toBe(200);
		const created = (await create.json()) as { uri: string; cid: string };
		expect(created.uri).toBe(
			`${space}/${env.DID}/test.cirrus.note/note1`,
		);

		const read = await get(
			`/xrpc/com.atproto.space.getRecord?space=${encodeURIComponent(space)}&repo=${env.DID}&collection=test.cirrus.note&rkey=note1`,
			{ Authorization: `Bearer ${env.AUTH_TOKEN}` },
		);
		expect(read.status).toBe(200);
		expect(
			((await read.json()) as { value: { text: string } }).value.text,
		).toBe("private note");

		// Unauthenticated read is refused.
		const anon = await get(
			`/xrpc/com.atproto.space.getRecord?space=${encodeURIComponent(space)}&repo=${env.DID}&collection=test.cirrus.note&rkey=note1`,
		);
		expect(anon.status).toBe(401);

		// The record does not exist in the public repo.
		const publicRead = await get(
			`/xrpc/com.atproto.repo.getRecord?repo=${env.DID}&collection=test.cirrus.note&rkey=note1`,
		);
		expect(publicRead.status).not.toBe(200);
	});

	it("keeps space blobs off the public sync endpoint (S6)", async () => {
		const space = await createSpace();
		const bytes = new Uint8Array([0x53, 0x50, 0x41, 0x43, 0x45, 0x42]);
		const upload = await worker.fetch(
			new Request("http://pds.test/xrpc/com.atproto.repo.uploadBlob", {
				method: "POST",
				headers: {
					"Content-Type": "application/octet-stream",
					Authorization: `Bearer ${env.AUTH_TOKEN}`,
				},
				body: bytes,
			}),
			env,
		);
		expect(upload.status).toBe(200);
		const { blob } = (await upload.json()) as {
			blob: { ref: { $link: string } };
		};
		const cid = blob.ref.$link;

		const write = await post("/xrpc/com.atproto.space.createRecord", {
			space,
			repo: env.DID,
			collection: "test.cirrus.file",
			rkey: "file1",
			record: { $type: "test.cirrus.file", file: blob },
		});
		expect(write.status).toBe(200);

		// The public endpoint refuses the CID even though it exists.
		const publicBlob = await get(
			`/xrpc/com.atproto.sync.getBlob?did=${env.DID}&cid=${cid}`,
		);
		expect(publicBlob.status).toBe(404);

		// The space endpoint streams it with a covering session.
		const spaceBlob = await get(
			`/xrpc/com.atproto.space.getBlob?space=${encodeURIComponent(space)}&repo=${env.DID}&cid=${cid}`,
			{ Authorization: `Bearer ${env.AUTH_TOKEN}` },
		);
		expect(spaceBlob.status).toBe(200);
		expect(spaceBlob.headers.get("Cache-Control")).toBe("private, no-store");
		expect(new Uint8Array(await spaceBlob.arrayBuffer())).toEqual(bytes);
	});

	it("mints delegation tokens (S2)", async () => {
		const authority = "did:web:elsewhere.test";
		const space = `at://${authority}/space/app.bsky.group/friends`;
		const res = await get(
			`/xrpc/com.atproto.space.getDelegationToken?space=${encodeURIComponent(space)}`,
			{ Authorization: `Bearer ${env.AUTH_TOKEN}` },
		);
		expect(res.status).toBe(200);
		const { token } = (await res.json()) as { token: string };
		const [headerB64, payloadB64] = token.split(".") as [string, string];
		const decode = (part: string) =>
			JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/")));
		expect(decode(headerB64)).toMatchObject({
			typ: "atproto-space-delegation+jwt",
			kid: "#atproto",
		});
		expect(decode(payloadB64)).toMatchObject({
			iss: env.DID,
			sub: space,
			aud: `${authority}#atproto_space_host`,
		});
	});

	it("lists spaces from the index", async () => {
		const space = await createSpace();
		const res = await get("/xrpc/com.atproto.space.listSpaces?limit=100", {
			Authorization: `Bearer ${env.AUTH_TOKEN}`,
		});
		expect(res.status).toBe(200);
		const { spaces } = (await res.json()) as {
			spaces: Array<{ uri: string }>;
		};
		expect(spaces.map((s) => s.uri)).toContain(space);
	});

	it("refuses app-password sessions on spaces but not the public repo", async () => {
		// Create an app password and log in with it.
		const created = await post(
			"/xrpc/com.atproto.server.createAppPassword",
			{ name: "spaces-test" },
		);
		expect(created.status).toBe(200);
		const { password } = (await created.json()) as { password: string };

		const session = await post(
			"/xrpc/com.atproto.server.createSession",
			{ identifier: env.HANDLE, password },
			{ "Content-Type": "application/json" },
		);
		expect(session.status).toBe(200);
		const { accessJwt } = (await session.json()) as { accessJwt: string };
		const appPassAuth = {
			"Content-Type": "application/json",
			Authorization: `Bearer ${accessJwt}`,
		};

		// Public repo write still works.
		const publicWrite = await post(
			"/xrpc/com.atproto.repo.createRecord",
			{
				repo: env.DID,
				collection: "test.cirrus.note",
				record: { $type: "test.cirrus.note", text: "from app password" },
			},
			appPassAuth,
		);
		expect(publicWrite.status).toBe(200);

		// Spaces refuse the same session.
		const space = await createSpace();
		const spaceWrite = await post(
			"/xrpc/com.atproto.space.createRecord",
			{
				space,
				repo: env.DID,
				collection: "test.cirrus.note",
				record: { $type: "test.cirrus.note", text: "denied" },
			},
			appPassAuth,
		);
		expect(spaceWrite.status).toBe(403);
		expect(((await spaceWrite.json()) as { message: string }).message).toMatch(
			/App password/i,
		);
	});

	it("reports spaces status and resets all space data (S7)", async () => {
		const space = await createSpace();
		await post("/xrpc/com.atproto.space.createRecord", {
			space,
			repo: env.DID,
			collection: "test.cirrus.note",
			record: { $type: "test.cirrus.note", text: "doomed" },
		});

		// Status requires the operator token.
		const anonStatus = await get("/xrpc/gg.mk.experimental.getSpacesStatus");
		expect(anonStatus.status).toBe(401);

		const status = await get("/xrpc/gg.mk.experimental.getSpacesStatus", {
			Authorization: `Bearer ${env.AUTH_TOKEN}`,
		});
		expect(status.status).toBe(200);
		const statusBody = (await status.json()) as {
			enabled: boolean;
			schemaVersion: number;
			spaces: Array<{ uri: string; role: string; recordCount: number }>;
		};
		expect(statusBody.enabled).toBe(true);
		expect(statusBody.schemaVersion).toBeGreaterThanOrEqual(1);
		const entry = statusBody.spaces.find((s) => s.uri === space);
		expect(entry).toMatchObject({ role: "authority", recordCount: 1 });

		// The public repo head before the reset.
		const beforeReset = await (
			await get(`/xrpc/com.atproto.sync.getLatestCommit?did=${env.DID}`)
		).json();

		const reset = await post("/xrpc/gg.mk.experimental.spacesReset", {});
		expect(reset.status).toBe(200);
		const resetBody = (await reset.json()) as { spacesDeleted: number };
		expect(resetBody.spacesDeleted).toBeGreaterThan(0);

		// Clean state: nothing listed, reads say RepoNotFound.
		const listed = await get("/xrpc/com.atproto.space.listSpaces", {
			Authorization: `Bearer ${env.AUTH_TOKEN}`,
		});
		expect(((await listed.json()) as { spaces: unknown[] }).spaces).toEqual(
			[],
		);
		const read = await get(
			`/xrpc/com.atproto.space.getRecord?space=${encodeURIComponent(space)}&repo=${env.DID}&collection=test.cirrus.note&rkey=x`,
			{ Authorization: `Bearer ${env.AUTH_TOKEN}` },
		);
		expect(read.status).toBe(404);

		// The public repo is untouched.
		const afterReset = await (
			await get(`/xrpc/com.atproto.sync.getLatestCommit?did=${env.DID}`)
		).json();
		expect(afterReset).toEqual(beforeReset);
	});

	it("keeps the firehose and public repo untouched by space writes", async () => {
		const space = await createSpace();
		const before = await (
			await get(`/xrpc/com.atproto.sync.getLatestCommit?did=${env.DID}`)
		).json();
		await post("/xrpc/com.atproto.space.createRecord", {
			space,
			repo: env.DID,
			collection: "test.cirrus.note",
			record: { $type: "test.cirrus.note", text: "no firehose" },
		});
		const after = await (
			await get(`/xrpc/com.atproto.sync.getLatestCommit?did=${env.DID}`)
		).json();
		expect(after).toEqual(before);
	});
});
