export { jsonToLex as normalizeRecordLinks } from "@atproto/lexicon";

/**
 * Detect content type from file magic bytes.
 * Returns the detected MIME type or null if unknown.
 */
export function detectContentType(bytes: Uint8Array): string | null {
	// MP4/M4V/MOV - check for ftyp box
	if (bytes.length >= 12) {
		const ftyp = String.fromCharCode(
			bytes[4]!,
			bytes[5]!,
			bytes[6]!,
			bytes[7]!,
		);
		if (ftyp === "ftyp") {
			// Check brand for more specific type
			const brand = String.fromCharCode(
				bytes[8]!,
				bytes[9]!,
				bytes[10]!,
				bytes[11]!,
			);
			if (
				brand === "isom" ||
				brand === "iso2" ||
				brand === "mp41" ||
				brand === "mp42" ||
				brand === "avc1"
			) {
				return "video/mp4";
			}
			if (brand === "M4V " || brand === "M4VH" || brand === "M4VP") {
				return "video/x-m4v";
			}
			if (brand === "qt  ") {
				return "video/quicktime";
			}
			// Default to mp4 for any ftyp
			return "video/mp4";
		}
	}

	// JPEG
	if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
		return "image/jpeg";
	}

	// PNG
	if (
		bytes[0] === 0x89 &&
		bytes[1] === 0x50 &&
		bytes[2] === 0x4e &&
		bytes[3] === 0x47
	) {
		return "image/png";
	}

	// GIF
	if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
		return "image/gif";
	}

	// WebP
	if (
		bytes[0] === 0x52 &&
		bytes[1] === 0x49 &&
		bytes[2] === 0x46 &&
		bytes[3] === 0x46 &&
		bytes[8] === 0x57 &&
		bytes[9] === 0x45 &&
		bytes[10] === 0x42 &&
		bytes[11] === 0x50
	) {
		return "image/webp";
	}

	// WebM
	if (
		bytes[0] === 0x1a &&
		bytes[1] === 0x45 &&
		bytes[2] === 0xdf &&
		bytes[3] === 0xa3
	) {
		return "video/webm";
	}

	return null;
}
