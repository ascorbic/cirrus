/**
 * DID resolution utilities for XRPC service proxying
 */

export interface DidDocument {
	"@context"?: string | string[];
	id: string;
	alsoKnownAs?: string[];
	verificationMethod?: Array<{
		id: string;
		type: string;
		controller: string;
		publicKeyMultibase?: string;
	}>;
	service?: Array<{
		id: string;
		type: string;
		serviceEndpoint: string;
	}>;
}

/**
 * Parse atproto-proxy header value
 * Format: "did:web:example.com#service_id"
 * Returns: { did: "did:web:example.com", serviceId: "service_id" }
 */
export function parseProxyHeader(
	header: string,
): { did: string; serviceId: string } | null {
	const parts = header.split("#");
	if (parts.length !== 2) {
		return null;
	}

	const [did, serviceId] = parts;
	if (!did.startsWith("did:")) {
		return null;
	}

	return { did, serviceId };
}

/**
 * Resolve a DID to its DID document
 * Currently supports did:web and did:plc
 */
export async function resolveDidDocument(did: string): Promise<DidDocument> {
	if (did.startsWith("did:web:")) {
		return resolveDidWeb(did);
	}

	if (did.startsWith("did:plc:")) {
		return resolveDidPlc(did);
	}

	throw new Error(`Unsupported DID method: ${did}`);
}

/**
 * Resolve a did:web DID
 * did:web:example.com -> https://example.com/.well-known/did.json
 * did:web:example.com:path -> https://example.com/path/did.json
 */
async function resolveDidWeb(did: string): Promise<DidDocument> {
	const didParts = did.split(":");
	if (didParts.length < 3) {
		throw new Error(`Invalid did:web format: ${did}`);
	}

	// Remove "did" and "web" prefix
	const parts = didParts.slice(2);

	// First part is the domain (may include port)
	const domain = decodeURIComponent(parts[0]);

	// Remaining parts form the path
	const path = parts.slice(1).map(decodeURIComponent).join("/");

	let url: string;
	if (path) {
		url = `https://${domain}/${path}/did.json`;
	} else {
		url = `https://${domain}/.well-known/did.json`;
	}

	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(
			`Failed to resolve did:web ${did}: ${response.status} ${response.statusText}`,
		);
	}

	const doc = await response.json();
	return doc as DidDocument;
}

/**
 * Resolve a did:plc DID from the PLC directory
 */
async function resolveDidPlc(did: string): Promise<DidDocument> {
	const plcId = did.split(":")[2];
	if (!plcId) {
		throw new Error(`Invalid did:plc format: ${did}`);
	}

	const url = `https://plc.directory/${did}`;
	const response = await fetch(url);

	if (!response.ok) {
		throw new Error(
			`Failed to resolve did:plc ${did}: ${response.status} ${response.statusText}`,
		);
	}

	const doc = await response.json();
	return doc as DidDocument;
}

/**
 * Extract service endpoint URL from DID document
 * Returns the serviceEndpoint URL for the matching service ID
 */
export function extractServiceEndpoint(
	doc: DidDocument,
	serviceId: string,
): string | null {
	if (!doc.service) {
		return null;
	}

	// Service ID may be just the fragment (e.g., "atproto_labeler")
	// or the full ID (e.g., "did:web:example.com#atproto_labeler")
	const normalizedServiceId = serviceId.startsWith("#")
		? serviceId
		: `#${serviceId}`;

	const service = doc.service.find(
		(s) =>
			s.id === normalizedServiceId ||
			s.id === `${doc.id}${normalizedServiceId}` ||
			s.id === serviceId,
	);

	if (!service) {
		return null;
	}

	return service.serviceEndpoint;
}
