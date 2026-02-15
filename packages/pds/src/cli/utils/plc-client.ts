/**
 * PLC Directory client for identity operations
 *
 * Handles communication with the PLC directory and source PDS
 * for DID document updates during migration.
 *
 * Uses @atcute/client for type-safe XRPC calls.
 */
import { Client, ok, type FetchHandler } from "@atcute/client";
// Import for type augmentation - gives us typed XRPC method signatures
import type {} from "@atcute/atproto";

const PLC_DIRECTORY = "https://plc.directory";

/**
 * PLC operation structure (from plc.directory)
 */
export interface PlcOperation {
	type: string;
	prev: string | null;
	sig: string;
	rotationKeys: string[];
	verificationMethods: Record<string, string>;
	alsoKnownAs: string[];
	services: Record<string, { type: string; endpoint: string }>;
}

/**
 * Audit log entry from plc.directory
 */
export interface PlcAuditLog {
	did: string;
	operation: PlcOperation;
	cid: string;
	nullified: boolean;
	createdAt: string;
}

/**
 * Signed PLC operation ready for submission
 */
export interface SignedPlcOperation {
	type: "plc_operation";
	prev: string | null;
	sig: string;
	rotationKeys: string[];
	verificationMethods: Record<string, string>;
	alsoKnownAs: string[];
	services: Record<string, { type: string; endpoint: string }>;
}

export interface CredentialInfo {
	type: "email" | "passkey";
	email?: string;
	pending?: boolean;
}

/**
 * Result of requesting a PLC operation signature
 */
export interface PlcSignatureRequest {
	/** Whether the request was successful */
	success: boolean;
	/** Where to check for the token (email, passkey, etc.) */
	credentialInfo?: CredentialInfo;
	/** Error message if failed */
	error?: string;
}

/**
 * Result of signing a PLC operation
 */
export interface PlcSignatureResult {
	/** Whether the operation was signed successfully */
	success: boolean;
	/** The signed operation, ready to submit to PLC */
	signedOperation?: SignedPlcOperation;
	/** Error message if failed */
	error?: string;
}

/**
 * Create a fetch handler that adds optional auth token
 */
function createAuthHandler(baseUrl: string, token?: string): FetchHandler {
	return async (pathname, init) => {
		const url = new URL(pathname, baseUrl);
		const headers = new Headers(init.headers);
		if (token) {
			headers.set("Authorization", `Bearer ${token}`);
		}
		return fetch(url, { ...init, headers });
	};
}

/**
 * Client for interacting with source PDS for PLC operations
 *
 * Uses @atcute/client for type-safe XRPC calls to:
 * - com.atproto.identity.requestPlcOperationSignature
 * - com.atproto.identity.signPlcOperation
 */
export class SourcePdsPlcClient {
	private client: Client;
	private authToken?: string;
	private baseUrl: string;

	constructor(baseUrl: string, authToken?: string) {
		this.baseUrl = baseUrl;
		this.authToken = authToken;
		this.client = new Client({
			handler: createAuthHandler(baseUrl, authToken),
		});
	}

	setAuthToken(token: string): void {
		this.authToken = token;
		this.client = new Client({
			handler: createAuthHandler(this.baseUrl, token),
		});
	}

	/**
	 * Request a PLC operation signature from the source PDS.
	 * This triggers the source PDS to send an email token to the user.
	 *
	 * Uses: com.atproto.identity.requestPlcOperationSignature
	 */
	async requestPlcOperationSignature(): Promise<PlcSignatureRequest> {
		try {
			await ok(
				this.client.post("com.atproto.identity.requestPlcOperationSignature", {
					as: null, // This endpoint returns no body
				}),
			);

			// The endpoint returns 200 with no body on success
			// Email has been sent
			return {
				success: true,
				credentialInfo: { type: "email" },
			};
		} catch (err) {
			const errorMessage = err instanceof Error ? err.message : "Network error";

			return {
				success: false,
				error: errorMessage,
			};
		}
	}

	/**
	 * Get a signed PLC operation from the source PDS.
	 * This builds and signs the operation to migrate to the new PDS.
	 *
	 * Uses: com.atproto.identity.signPlcOperation
	 *
	 * @param token - The email token received from the source PDS
	 * @param newPdsEndpoint - The endpoint URL of the new PDS
	 * @param newSigningKey - The new signing key DID (did:key:...)
	 */
	async signPlcOperation(
		token: string,
		newPdsEndpoint: string,
		newSigningKey: string,
	): Promise<PlcSignatureResult> {
		try {
			const result = await ok(
				this.client.post("com.atproto.identity.signPlcOperation", {
					input: {
						token,
						rotationKeys: undefined, // Keep existing rotation keys
						alsoKnownAs: undefined, // Keep existing aliases
						verificationMethods: {
							atproto: newSigningKey,
						},
						services: {
							atproto_pds: {
								type: "AtprotoPersonalDataServer",
								endpoint: newPdsEndpoint,
							},
						},
					},
				}),
			);

			return {
				success: true,
				signedOperation: result.operation as SignedPlcOperation,
			};
		} catch (err) {
			const errorMessage = err instanceof Error ? err.message : "Network error";

			// Check for specific error types
			if (
				errorMessage.includes("expired") ||
				errorMessage.includes("ExpiredToken")
			) {
				return {
					success: false,
					error: "Token expired. Request a new one and try again.",
				};
			}
			if (
				errorMessage.includes("invalid") ||
				errorMessage.includes("InvalidToken")
			) {
				return {
					success: false,
					error: "Invalid token. Check you entered it correctly.",
				};
			}

			return {
				success: false,
				error: errorMessage,
			};
		}
	}
}

/**
 * Client for interacting with the PLC directory
 *
 * The PLC directory has its own REST API (not XRPC), so we use raw fetch here.
 * See: https://web.plc.directory/
 */
export class PlcDirectoryClient {
	constructor(private plcUrl: string = PLC_DIRECTORY) {}

	/**
	 * Get the audit log for a DID (list of all operations)
	 */
	async getAuditLog(did: string): Promise<PlcAuditLog[]> {
		const res = await fetch(`${this.plcUrl}/${did}/log/audit`);
		if (!res.ok) {
			throw new Error(`Failed to fetch audit log: ${res.status}`);
		}
		return res.json() as Promise<PlcAuditLog[]>;
	}

	/**
	 * Get the current DID document
	 */
	async getDocument(did: string): Promise<Record<string, unknown> | null> {
		const res = await fetch(`${this.plcUrl}/${did}`);
		if (!res.ok) {
			if (res.status === 404) return null;
			throw new Error(`Failed to fetch DID document: ${res.status}`);
		}
		return res.json() as Promise<Record<string, unknown>>;
	}

	/**
	 * Submit a signed PLC operation to the directory
	 */
	async submitOperation(
		did: string,
		operation: SignedPlcOperation,
	): Promise<{ success: boolean; error?: string }> {
		try {
			const res = await fetch(`${this.plcUrl}/${did}`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(operation),
			});

			if (!res.ok) {
				const errorBody = await res.text();
				return {
					success: false,
					error: `PLC directory rejected operation: ${errorBody}`,
				};
			}

			return { success: true };
		} catch (err) {
			return {
				success: false,
				error: err instanceof Error ? err.message : "Network error",
			};
		}
	}
}
