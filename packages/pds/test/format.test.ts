import { describe, it, expect } from "vitest";
import { normalizeRecordLinks } from "../src/format";
import { CID } from "@atproto/lex-data";

describe("normalizeRecordLinks", () => {
	it("should convert $link objects to CID instances", () => {
		const cid = "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";
		const input = { ref: { $link: cid } };
		const result = normalizeRecordLinks(input) as Record<string, unknown>;

		expect(CID.asCID(result.ref)).not.toBeNull();
		expect(result.ref?.toString()).toBe(cid);
	});

	it("should normalize blob refs with nested $link", () => {
		const cid = "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";
		const input = {
			$type: "blob",
			ref: { $link: cid },
			mimeType: "image/jpeg",
			size: 12345,
		};
		const result = normalizeRecordLinks(input) as Record<string, unknown>;

		expect(result.$type).toBe("blob");
		expect(CID.asCID(result.ref)).not.toBeNull();
		expect(result.ref?.toString()).toBe(cid);
		expect(result.mimeType).toBe("image/jpeg");
		expect(result.size).toBe(12345);
	});

	it("should handle deeply nested blob refs in records", () => {
		const cid = "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";
		const input = {
			$type: "app.bsky.feed.post",
			text: "Hello world",
			embed: {
				$type: "app.bsky.embed.images",
				images: [
					{
						alt: "test image",
						image: {
							$type: "blob",
							ref: { $link: cid },
							mimeType: "image/jpeg",
							size: 12345,
						},
					},
				],
			},
		};
		const result = normalizeRecordLinks(input) as any;

		const blobRef = result.embed.images[0].image;
		expect(blobRef.$type).toBe("blob");
		expect(CID.asCID(blobRef.ref)).not.toBeNull();
		expect(blobRef.ref.toString()).toBe(cid);
	});

	it("should convert $bytes objects to Uint8Array", () => {
		const input = { data: { $bytes: "AQID" } }; // base64 for [1, 2, 3]
		const result = normalizeRecordLinks(input) as Record<string, unknown>;

		expect(result.data).toBeInstanceOf(Uint8Array);
		expect(result.data).toEqual(new Uint8Array([1, 2, 3]));
	});

	it("should pass through primitives unchanged", () => {
		expect(normalizeRecordLinks("hello")).toBe("hello");
		expect(normalizeRecordLinks(42)).toBe(42);
		expect(normalizeRecordLinks(true)).toBe(true);
		expect(normalizeRecordLinks(null)).toBeNull();
		expect(normalizeRecordLinks(undefined)).toBeUndefined();
	});

	it("should pass through objects without special keys unchanged", () => {
		const input = { text: "hello", count: 42 };
		const result = normalizeRecordLinks(input);
		expect(result).toBe(input); // same reference, no copy needed
	});

	it("should not modify invalid $link objects", () => {
		// $link with extra keys should not be converted
		const input = { $link: "bafk...", extra: "key" };
		const result = normalizeRecordLinks(input);
		expect(result).toBe(input);
	});

	it("should handle arrays with blob refs", () => {
		const cid = "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";
		const input = [
			{ ref: { $link: cid } },
			{ text: "no link here" },
		];
		const result = normalizeRecordLinks(input) as any[];

		expect(CID.asCID(result[0].ref)).not.toBeNull();
		expect(result[1]).toBe(input[1]); // unchanged items keep reference
	});
});
