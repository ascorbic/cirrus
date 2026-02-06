import { CID } from "@atproto/lex-data";

/**
 * Normalize a JSON record for IPLD/CBOR encoding.
 *
 * Incoming API records contain JSON representations of CID links as
 * `{ "$link": "bafk..." }` objects. For correct dag-cbor encoding,
 * these must be converted to actual CID instances before the record
 * is passed to `@atproto/repo` (which calls `lexToIpld` → `dataToCborBlock`).
 *
 * Without this normalization, blob refs like:
 *   `{ "$type": "blob", "ref": { "$link": "bafk..." }, ... }`
 * get CBOR-encoded with `ref` as a nested map instead of a CID tag,
 * producing incorrect block hashes that cause blob resolution failures.
 */
export function normalizeRecordLinks(obj: unknown): unknown {
	if (obj === null || obj === undefined) return obj;

	if (Array.isArray(obj)) {
		let copy: unknown[] | undefined;
		for (let i = 0; i < obj.length; i++) {
			const normalized = normalizeRecordLinks(obj[i]);
			if (normalized !== obj[i]) {
				copy ??= [...obj];
				copy[i] = normalized;
			}
		}
		return copy ?? obj;
	}

	if (typeof obj === "object") {
		const record = obj as Record<string, unknown>;

		// Convert { "$link": "<cid>" } to CID instance
		if (
			typeof record.$link === "string" &&
			Object.keys(record).length === 1
		) {
			try {
				return CID.parse(record.$link);
			} catch {
				return obj;
			}
		}

		// Convert { "$bytes": "<base64>" } to Uint8Array
		if (
			typeof record.$bytes === "string" &&
			Object.keys(record).length === 1
		) {
			try {
				const binary = atob(record.$bytes);
				const bytes = new Uint8Array(binary.length);
				for (let i = 0; i < binary.length; i++) {
					bytes[i] = binary.charCodeAt(i);
				}
				return bytes;
			} catch {
				return obj;
			}
		}

		// Recursively normalize all properties
		let copy: Record<string, unknown> | undefined;
		for (const key of Object.keys(record)) {
			const normalized = normalizeRecordLinks(record[key]);
			if (normalized !== record[key]) {
				copy ??= { ...record };
				copy[key] = normalized;
			}
		}
		return copy ?? obj;
	}

	return obj;
}

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
