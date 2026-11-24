-- Migration: Add invite_codes table and track user invite_code on registration
CREATE TABLE IF NOT EXISTS invite_codes (
  code TEXT PRIMARY KEY,
  max_uses INTEGER NOT NULL DEFAULT 1,
  remaining_uses INTEGER NOT NULL DEFAULT 1,
  expires_at INTEGER,
  last_used_at INTEGER,
  created_at INTEGER NOT NULL,
  created_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_invite_codes_created_at ON invite_codes(created_at DESC);

ALTER TABLE users ADD COLUMN invite_code TEXT;
