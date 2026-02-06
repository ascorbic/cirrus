import { describe, it, expect } from "vitest";
import { normalizeRecordLinks } from "../src/format";
import { CID } from "@atproto/lex-data";
import { BlobRef } from "@atproto/lexicon";

describe("normalizeRecordLinks", () => {
	it("should convert $link objects to CID instances", () => {
		const cid = "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";
		const input = { ref: { $link: cid } };
		const result = normalizeRecordLinks(input) as Record<string, unknown>;

		expect(CID.asCID(result.ref)).not.toBeNull();
		expect(result.ref?.toString()).toBe(cid);
	});

	it("should normalize blob refs into BlobRef instances", () => {
		const cid = "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";
		const input = {
			$type: "blob",
			ref: { $link: cid },
			mimeType: "image/jpeg",
			size: 12345,
		};
		const result = normalizeRecordLinks(input);

		expect(result).toBeInstanceOf(BlobRef);
		const blobRef = result as BlobRef;
		expect(blobRef.ref.toString()).toBe(cid);
		expect(blobRef.mimeType).toBe("image/jpeg");
		expect(blobRef.size).toBe(12345);
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
		expect(blobRef).toBeInstanceOf(BlobRef);
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
	});

	it("should handle arrays with blob refs", () => {
		const cid = "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";
		const input = [
			{ ref: { $link: cid } },
			{ text: "no link here" },
		];
		const result = normalizeRecordLinks(input) as any[];

		expect(CID.asCID(result[0].ref)).not.toBeNull();
	});
});
