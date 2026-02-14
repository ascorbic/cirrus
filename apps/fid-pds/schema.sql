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
