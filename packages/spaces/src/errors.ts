/**
 * Typed errors for the spaces engine.
 *
 * Durable Object RPC flattens thrown errors into a wrapper `Error` whose
 * message is `"${name}: ${message}"`, so every error here encodes its
 * protocol error name as a message prefix. Worker-side handlers recover the
 * name with {@link parseSpaceErrorCode} and map it onto the lexicon error
 * shape.
 */

/** Protocol error names used across the space and policy endpoints. */
export const SPACE_ERROR_CODES = [
	"SpaceNotFound",
	"SpaceDeleted",
	"SpaceAlreadyExists",
	"RepoNotFound",
	"RepoDeactivated",
	"RepoTakendown",
	"RecordNotFound",
	"RecordAlreadyExists",
	"BlobNotFound",
	"AppNotAuthorized",
	"NotAuthorized",
	"AccountNotAuthorized",
	"InvalidDelegationToken",
	"InvalidClientAttestation",
	"InvalidCredential",
	"PolicyMismatch",
	"UnsupportedPolicy",
	"ServiceNotResolvable",
	"InvalidCursor",
	"InvalidSpaceUri",
	"InvalidRequest",
	"FutureRev",
	"InvalidSpaceMac",
	"InvalidRepoFile",
	"RepoMismatch",
	"InvalidSpaceMeta",
	"RegistrationNotConfirmed",
	"UpstreamFailure",
	// Space credential authentication failures, named as the reference
	// names them (all 401).
	"MissingJwt",
	"BadJwt",
	"BadJwtType",
	"BadJwtIss",
	"BadJwtSub",
	"BadJwtAudience",
	"BadJwtCnf",
	"BadJwtSignature",
	"JwtExpired",
	"BadSpaceSignature",
	"BadSpaceAudience",
	"CredentialRevoked",
	"Forbidden",
	"KemKeyUnavailable",
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
	AppNotAuthorized: 403,
	// NotAuthorized is the management methods' "not the space authority",
	// a 400 as the reference answers it.
	AccountNotAuthorized: 403,
	Forbidden: 403,
	UpstreamFailure: 502,
	InvalidClientAttestation: 401,
	MissingJwt: 401,
	BadJwt: 401,
	BadJwtType: 401,
	BadJwtIss: 401,
	BadJwtSub: 401,
	BadJwtAudience: 401,
	BadJwtCnf: 401,
	BadJwtSignature: 401,
	JwtExpired: 401,
	BadSpaceSignature: 401,
	BadSpaceAudience: 401,
	CredentialRevoked: 401,
	KemKeyUnavailable: 503,
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
		// Durable Object RPC re-throws errors with the class name folded into
		// the message ("SpaceError: RecordNotFound: ..."), so scan the first
		// few prefix segments for a known code.
		let message = err.message;
		for (let hop = 0; hop < 3; hop++) {
			const colon = message.indexOf(": ");
			if (colon <= 0) break;
			const code = message.slice(0, colon);
			if (CODE_SET.has(code)) {
				return {
					code: code as SpaceErrorCode,
					message: message.slice(colon + 2),
				};
			}
			message = message.slice(colon + 2);
		}
	}
	return null;
}

/** HTTP status for a recovered space error name. */
export function spaceErrorStatus(code: SpaceErrorCode): number {
	return ERROR_STATUS[code] ?? 400;
}
