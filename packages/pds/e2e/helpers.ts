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

export const TEST_DID = "did:web:test.local";
export const TEST_HANDLE = "test.local";
export const TEST_PASSWORD = "test-password"; // Matches PASSWORD_HASH in .dev.vars
export const TEST_AUTH_TOKEN = "test-token";
