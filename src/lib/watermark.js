// src/lib/watermark.js — Per-session capture watermark read/write.
//
// The watermark keeps track of how far through a session's parts we have
// already consumed (last_part_ms) and when we last ran a non-throttled
// capture (last_capture_ms). Both default to 0 for first-time captures.

/**
 * Read the current watermark for a session from the ledger.
 * Returns { lastPartMs: 0, lastCaptureMs: 0 } if no row exists.
 *
 * @param {import('node:sqlite').DatabaseSync} ledger
 * @param {string} sessionId
 * @returns {{ lastPartMs: number, lastCaptureMs: number }}
 */
export function readWatermark(ledger, sessionId) {
  const row = ledger
    .prepare(
      'SELECT last_part_ms, last_capture_ms FROM capture_watermark WHERE session_id = ?'
    )
    .get(sessionId);
  if (!row) return { lastPartMs: 0, lastCaptureMs: 0 };
  return {
    lastPartMs: Number(row.last_part_ms) || 0,
    lastCaptureMs: Number(row.last_capture_ms) || 0,
  };
}

/**
 * Advance the watermark for a session.
 *
 * last_part_ms is updated to MAX(current, upper) so it never goes backwards
 * (guards against concurrent capture or clock skew).
 * last_capture_ms is set to `now` unconditionally.
 *
 * Uses an UPSERT (INSERT ... ON CONFLICT DO UPDATE) to handle both the
 * first-time insert and subsequent updates atomically.
 *
 * @param {import('node:sqlite').DatabaseSync} ledger
 * @param {string} sessionId
 * @param {number} upper   - new upper bound for last_part_ms (epoch ms)
 * @param {number} now     - current epoch ms, written to last_capture_ms
 */
export function advanceWatermark(ledger, sessionId, upper, now) {
  ledger
    .prepare(
      `INSERT INTO capture_watermark (session_id, last_part_ms, last_capture_ms)
         VALUES (?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         last_part_ms    = MAX(capture_watermark.last_part_ms, excluded.last_part_ms),
         last_capture_ms = excluded.last_capture_ms`
    )
    .run(sessionId, upper, now);
}
