/**
 * Environment bindings for the Edge PDS Worker
 */
export interface Env {
	// Durable Object namespace for account storage
	ACCOUNT: DurableObjectNamespace

	// R2 bucket for blob storage (optional - enable R2 in dashboard first)
	BLOBS?: R2Bucket

	// The account's DID (did:web:... or did:plc:...)
	DID: string

	// The account's handle (e.g., "alice.example.com")
	HANDLE: string

	// Public hostname of this PDS
	PDS_HOSTNAME: string

	// Private key for signing commits (hex or multibase encoded)
	SIGNING_KEY: string

	// Public key for DID document (multibase encoded)
	SIGNING_KEY_PUBLIC: string

	// Bearer token for write authentication (MVP)
	AUTH_TOKEN: string
}
