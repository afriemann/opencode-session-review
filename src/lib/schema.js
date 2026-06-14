// src/lib/schema.js — Idempotent schema creation for the findings ledger.
//
// Call ensureSchema(ledger) at the start of every write command.
// All four tables are created with CREATE TABLE IF NOT EXISTS so the call
// is safe to repeat on an already-initialised ledger.

/**
 * Ensure all required tables exist in the ledger database.
 * Idempotent: safe to call on an already-initialised ledger.
 * @param {import('node:sqlite').DatabaseSync} ledger
 */
export function ensureSchema(ledger) {
  ledger.exec(`
    CREATE TABLE IF NOT EXISTS findings (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      fingerprint      TEXT UNIQUE NOT NULL,
      signal_type      TEXT NOT NULL,
      agent            TEXT,
      tool             TEXT,
      description      TEXT NOT NULL,
      severity         TEXT NOT NULL DEFAULT 'normal',
      status           TEXT NOT NULL DEFAULT 'open',
      occurrence_count INTEGER NOT NULL DEFAULT 0,
      first_seen       INTEGER NOT NULL,
      last_seen        INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS finding_sessions (
      finding_id INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      PRIMARY KEY (finding_id, session_id)
    );
    CREATE TABLE IF NOT EXISTS capture_watermark (
      session_id      TEXT PRIMARY KEY,
      last_part_ms    INTEGER NOT NULL DEFAULT 0,
      last_capture_ms INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS ignored_fingerprints (
      fingerprint TEXT PRIMARY KEY,
      reason      TEXT,
      created_ms  INTEGER NOT NULL
    );
  `);
}
