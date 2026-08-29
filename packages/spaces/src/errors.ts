/**
 * Typed errors for the spaces engine.
 *
 * Durable Object RPC flattens thrown errors into a wrapper `Error` whose
 * message is `"${name}: ${message}"`, so every error here encodes its
 * protocol error name as a message prefix. Worker-side handlers recover the
 * name with {@link parseSpaceErrorCode} and map it onto the lexicon error
 * shape.
 */

/** Protocol error names used across space and simplespace endpoints. */
export const SPACE_ERROR_CODES = [
	"SpaceNotFound",
	"SpaceDeleted",
	"SpaceAlreadyExists",
	"RepoNotFound",
	"RecordNotFound",
	"RecordAlreadyExists",
	"BlobNotFound",
	"UserNotAuthorized",
	"AppNotAuthorized",
	"NotAuthorized",
	"InvalidDelegationToken",
	"InvalidClientAttestation",
	"InvalidCredential",
	"NotSpaceOwner",
	"UnsupportedPolicy",
	"UnsupportedAppAccess",
	"ServiceNotResolvable",
	"MalformedCursor",
	"InvalidSpaceUri",
	"InvalidRequest",
	"SpacesSchemaOutdated",
] as const;

export type SpaceErrorCode = (typeof SPACE_ERROR_CODES)[number];

const CODE_SET: ReadonlySet<string> = new Set(SPACE_ERROR_CODES);

/** HTTP status for each error name when it isn't the default 400. */
const ERROR_STATUS: Partial<Record<SpaceErrorCode, number>> = {
	SpaceNotFound: 404,
	RepoNotFound: 404,
	BlobNotFound: 404,
	RecordAlreadyExists: 409,
	SpaceAlreadyExists: 409,
	UserNotAuthorized: 403,
	AppNotAuthorized: 403,
	NotAuthorized: 403,
	NotSpaceOwner: 403,
	InvalidDelegationToken: 401,
	InvalidClientAttestation: 401,
	InvalidCredential: 401,
	SpacesSchemaOutdated: 503,
};

export class SpaceError extends Error {
	override name = "SpaceError";
	constructor(
		readonly code: SpaceErrorCode,
		message: string,
	) {
		// The `${code}: ` prefix survives the DO RPC boundary.
		super(`${code}: ${message}`);
	}

	get status(): number {
		return ERROR_STATUS[this.code] ?? 400;
	}

	/** The human message without the code prefix. */
	get detail(): string {
		return this.message.slice(this.code.length + 2);
	}
}

/**
 * Recover the space error name from an error that may have crossed a DO RPC
 * boundary. Returns null for errors that aren't space errors.
 */
export function parseSpaceErrorCode(
	err: unknown,
): { code: SpaceErrorCode; message: string } | null {
	if (err instanceof SpaceError) {
		return { code: err.code, message: err.detail };
	}
	if (err instanceof Error) {
		const colon = err.message.indexOf(": ");
		if (colon > 0) {
			const code = err.message.slice(0, colon);
			if (CODE_SET.has(code)) {
				return {
					code: code as SpaceErrorCode,
					message: err.message.slice(colon + 2),
				};
			}
		}
	}
	return null;
}

/** HTTP status for a recovered space error name. */
export function spaceErrorStatus(code: SpaceErrorCode): number {
	return ERROR_STATUS[code] ?? 400;
}
