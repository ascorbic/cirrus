import { Secp256k1Keypair, randomStr } from "@atproto/crypto";

const MINUTE = 60 * 1000;

type ServiceJwtParams = {
	iss: string;
	aud: string;
	lxm: string | null;
	keypair: Secp256k1Keypair;
};

function jsonToB64Url(json: Record<string, unknown>): string {
	return Buffer.from(JSON.stringify(json)).toString("base64url");
}

function noUndefinedVals<T extends Record<string, unknown>>(
	obj: T,
): Partial<T> {
	const result: Partial<T> = {};
	for (const [key, val] of Object.entries(obj)) {
		if (val !== undefined) {
			result[key as keyof T] = val as T[keyof T];
		}
	}
	return result;
}

/**
 * Create a service JWT for proxied requests to AppView.
 * The JWT asserts that the PDS vouches for the user identified by `iss`.
 */
export async function createServiceJwt(
	params: ServiceJwtParams,
): Promise<string> {
	const { iss, aud, keypair } = params;
	const iat = Math.floor(Date.now() / 1000);
	const exp = iat + MINUTE / 1000;
	const lxm = params.lxm ?? undefined;
	const jti = randomStr(16, "hex");

	const header = {
		typ: "JWT",
		alg: keypair.jwtAlg,
	};

	const payload = noUndefinedVals({
		iat,
		iss,
		aud,
		exp,
		lxm,
		jti,
	});

	const toSignStr = `${jsonToB64Url(header)}.${jsonToB64Url(payload as Record<string, unknown>)}`;
	const toSign = Buffer.from(toSignStr, "utf8");
	const sig = Buffer.from(await keypair.sign(toSign));

	return `${toSignStr}.${sig.toString("base64url")}`;
}
