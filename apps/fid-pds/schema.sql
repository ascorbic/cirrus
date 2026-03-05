-- User Registry Schema for D1
-- Tracks user registrations with sequential numbering

CREATE TABLE IF NOT EXISTS user_registry (
  user_number INTEGER PRIMARY KEY AUTOINCREMENT,
  fid TEXT NOT NULL UNIQUE,
  farcaster_address TEXT,
  signing_pubkey TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Index for FID lookups
CREATE INDEX IF NOT EXISTS idx_user_registry_fid ON user_registry(fid);

-- Allowlist: FIDs permitted to create accounts (when ALLOWLIST_ENABLED=true)
CREATE TABLE IF NOT EXISTS allowlist (
  fid TEXT PRIMARY KEY,
  added_at TEXT NOT NULL DEFAULT (datetime('now')),
  added_by TEXT
);

-- Waitlist: FIDs that have requested early access
CREATE TABLE IF NOT EXISTS waitlist (
  fid TEXT PRIMARY KEY,
  requested_at TEXT NOT NULL DEFAULT (datetime('now')),
  farcaster_address TEXT
);
