import { describe, expect, it } from "vitest";
import { isSpaceRefString } from "@atproto/syntax";
import {
	formatSpaceUri,
	parseSpaceUri,
	requireSpaceUri,
	spaceId,
	spaceRecordUri,
} from "../src/space-uri";
import { spaceBlobKey, spaceBlobPrefix } from "../src/blob-keys";
import { SpaceError } from "../src/errors";
import { nextRev, tidCutoff } from "../src/tid";

const AUTHORITY = "did:web:alice.test";
const URI = `at:space/${AUTHORITY}/app.bsky.group/3kbcq3p7ad400`;

describe("parseSpaceUri", () => {
	it("parses a valid space URI", () => {
		const ref = parseSpaceUri(URI);
		expect(ref).toEqual({
			uri: URI,
			authority: AUTHORITY,
			type: "app.bsky.group",
			skey: "3kbcq3p7ad400",
		});
	});

	it("round-trips through formatSpaceUri", () => {
		expect(formatSpaceUri(AUTHORITY, "app.bsky.group", "3kbcq3p7ad400")).toBe(
			URI,
		);
	});

	it("rejects non-space URIs", () => {
		expect(parseSpaceUri("at://did:web:a.test/app.bsky.feed.post/abc")).toBe(
			null,
		);
		expect(parseSpaceUri("https://example.com")).toBe(null);
		expect(parseSpaceUri("at:space/did:web:a.test/app.bsky.group")).toBe(
			null,
		);
		expect(
			parseSpaceUri("at:space/did:web:a.test/app.bsky.group/a/b"),
		).toBe(null);
		expect(parseSpaceUri("at:space/notadid/app.bsky.group/abc")).toBe(null);
		expect(parseSpaceUri("at:space/did:web:a.test/notansid/abc")).toBe(null);
	});

	it("refuses the alpha's earlier at://{did}/space/... form", () => {
		expect(
			parseSpaceUri(`at://${AUTHORITY}/space/app.bsky.group/3kbcq3p7ad400`),
		).toBe(null);
	});

	it("refuses a handle as the space authority", () => {
		expect(parseSpaceUri("at:space/alice.test/app.bsky.group/abc")).toBe(null);
	});

	it("refuses a record URI where a space is expected", () => {
		expect(
			parseSpaceUri(`${URI}/did:web:bob.test/app.bsky.feed.post/3kabc`),
		).toBe(null);
	});

	it("agrees with the reference space-ref parser", () => {
		const cases = [
			URI,
			`at://${AUTHORITY}/space/app.bsky.group/3kbcq3p7ad400`,
			"at:space/alice.test/app.bsky.group/abc",
			"at:space/did:web:a.test/app.bsky.group",
			`${URI}/did:web:bob.test/app.bsky.feed.post/3kabc`,
			"at:space/did:web:a.test/notansid/abc",
			"at:space/did:plc:abcdefghijklmnopqrstuvwx/com.example.forum/general",
			"at:space/did:web:under_score.test/app.bsky.group/self",
		];
		for (const value of cases) {
			expect(parseSpaceUri(value) !== null, value).toBe(isSpaceRefString(value));
		}
	});

	it("requireSpaceUri throws InvalidRequest, as the reference answers", () => {
		expect(() => requireSpaceUri("nope")).toThrow(SpaceError);
		expect(() => requireSpaceUri(undefined)).toThrow(/InvalidRequest/);
	});
});

describe("spaceRecordUri", () => {
	it("appends repo, collection and rkey to the space URI", () => {
		expect(
			spaceRecordUri(URI, "did:web:bob.test", "app.bsky.feed.post", "3kabc"),
		).toBe(`${URI}/did:web:bob.test/app.bsky.feed.post/3kabc`);
	});
});

describe("spaceId", () => {
	it("is deterministic, lowercase base32 of sha-256", async () => {
		const a = await spaceId(URI);
		const b = await spaceId(URI);
		expect(a).toBe(b);
		expect(a).toMatch(/^[a-z2-7]{52}$/);
		expect(await spaceId(`${URI}x`)).not.toBe(a);
	});

	it("feeds R2 key helpers", async () => {
		const id = await spaceId(URI);
		expect(spaceBlobPrefix("did:web:op.test", id)).toBe(
			`did:web:op.test/space/${id}/`,
		);
		expect(spaceBlobKey("did:web:op.test", id, "bafcid")).toBe(
			`did:web:op.test/space/${id}/bafcid`,
		);
	});
});

describe("nextRev", () => {
	it("returns a fresh TID when there is no previous rev", () => {
		expect(nextRev(null)).toMatch(/^[2-7a-z]{13}$/);
	});

	it("is strictly greater than the previous rev", () => {
		let rev = nextRev(null);
		for (let i = 0; i < 100; i++) {
			const next = nextRev(rev);
			expect(next > rev).toBe(true);
			rev = next;
		}
	});

	it("increments past a future previous rev", () => {
		const future = "zzzzzzzzzzzzy";
		expect(nextRev(future) > future).toBe(true);
	});
});

describe("tidCutoff", () => {
	it("is a valid TID below the current clock", () => {
		const cutoff = tidCutoff(1000 * 60);
		const now = nextRev(null);
		expect(cutoff).toMatch(/^[2-7a-z]{13}$/);
		expect(cutoff < now).toBe(true);
	});

	it("orders by age", () => {
		expect(tidCutoff(60_000) > tidCutoff(120_000)).toBe(true);
	});
});
