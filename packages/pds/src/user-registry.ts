/**
 * User Registry - D1 Database for tracking user registrations
 *
 * This module provides functions for registering new users in a global D1 database.
 * The registry tracks:
 * - Sequential user number (which user this is, e.g., user #42)
 * - FID (Farcaster ID)
 * - Farcaster custody address (optional)
 * - AT Protocol signing public key
 * - Registration timestamp
 */

/**
 * User registration record from the D1 database.
 */
export interface UserRegistration {
	/** Sequential user number (auto-incremented primary key) */
	user_number: number;
	/** Farcaster ID */
	fid: string;
	/** Farcaster custody address (optional, from SIWF flow) */
	farcaster_address: string | null;
	/** AT Protocol signing public key (multibase-encoded) */
	signing_pubkey: string;
	/** ISO 8601 timestamp when user was registered */
	created_at: string;
}

/**
 * Register a new user in the global registry.
 *
 * This function is idempotent - if the user is already registered,
 * it returns the existing registration.
 *
 * @param db - D1 database instance
 * @param fid - Farcaster ID
 * @param signingPubkey - AT Protocol signing public key (multibase-encoded)
 * @param farcasterAddress - Optional Farcaster custody address
 * @returns The user registration record
 */
export async function registerUser(
	db: D1Database,
	fid: string,
	signingPubkey: string,
	farcasterAddress?: string,
): Promise<UserRegistration> {
	// Check if already registered (idempotent)
	const existing = await db
		.prepare("SELECT * FROM user_registry WHERE fid = ?")
		.bind(fid)
		.first<UserRegistration>();

	if (existing) {
		return existing;
	}

	// Insert new user
	await db
		.prepare(
			`INSERT INTO user_registry (fid, farcaster_address, signing_pubkey)
       VALUES (?, ?, ?)`,
		)
		.bind(fid, farcasterAddress ?? null, signingPubkey)
		.run();

	// Return the inserted row
	const result = await db
		.prepare("SELECT * FROM user_registry WHERE fid = ?")
		.bind(fid)
		.first<UserRegistration>();

	// Should always exist after successful insert
	return result!;
}

/**
 * Delete a user registration by FID.
 *
 * @param db - D1 database instance
 * @param fid - Farcaster ID
 * @returns true if a row was deleted, false if not found
 */
export async function deleteUser(
	db: D1Database,
	fid: string,
): Promise<boolean> {
	const result = await db
		.prepare("DELETE FROM user_registry WHERE fid = ?")
		.bind(fid)
		.run();
	return (result.meta.changes ?? 0) > 0;
}

/**
 * Get a user registration by FID.
 *
 * @param db - D1 database instance
 * @param fid - Farcaster ID
 * @returns The user registration record, or null if not found
 */
export async function getUserByFid(
	db: D1Database,
	fid: string,
): Promise<UserRegistration | null> {
	return await db
		.prepare("SELECT * FROM user_registry WHERE fid = ?")
		.bind(fid)
		.first<UserRegistration>();
}

/**
 * Get a user registration by user number.
 *
 * @param db - D1 database instance
 * @param userNumber - Sequential user number
 * @returns The user registration record, or null if not found
 */
export async function getUserByNumber(
	db: D1Database,
	userNumber: number,
): Promise<UserRegistration | null> {
	return await db
		.prepare("SELECT * FROM user_registry WHERE user_number = ?")
		.bind(userNumber)
		.first<UserRegistration>();
}

/**
 * Get the total count of registered users.
 *
 * @param db - D1 database instance
 * @returns The total number of registered users
 */
export async function getUserCount(db: D1Database): Promise<number> {
	const result = await db
		.prepare("SELECT COUNT(*) as count FROM user_registry")
		.first<{ count: number }>();

	return result?.count ?? 0;
}
