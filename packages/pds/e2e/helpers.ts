import { AtpAgent } from "@atproto/api";

export function getPort(): number {
	return ((globalThis as Record<string, unknown>).__e2e_port__ as number) ?? 5173;
}

export function getBaseUrl(): string {
	return `http://localhost:${getPort()}`;
}

export function createAgent(): AtpAgent {
	return new AtpAgent({ service: getBaseUrl() });
}

/**
 * Generate a unique rkey for test isolation
 */
export function uniqueRkey(): string {
	return `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// Test credentials for WebFID format: did:web:NNN.domain where NNN is a FID
export const TEST_DID = "did:web:1.test.local";
export const TEST_HANDLE = "1.test.local";
