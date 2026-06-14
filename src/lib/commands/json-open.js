// src/lib/commands/json-open.js — JSON array of open findings.
//
// Ports cmd_json_open() from session-finding-capture.sh.
// Returns all open findings with distinct-session counts for machine consumption.

/**
 * Return all open findings as an array of objects.
 *
 * Fields (matching the bash JSON output):
 *   id, severity, signal_type, agent, tool, occurrence_count,
 *   distinct_sessions, description
 *
 * @param {import('node:sqlite').DatabaseSync} ledger
 * @returns {Array<object>}
 */
export function cmdJsonOpen(ledger) {
  return ledger
    .prepare(
      `SELECT
         f.id,
         f.severity,
         f.signal_type,
         f.agent,
         f.tool,
         f.occurrence_count,
         (SELECT COUNT(*) FROM finding_sessions s WHERE s.finding_id = f.id)
           AS distinct_sessions,
         f.description
       FROM findings f
       WHERE f.status = 'open'
       ORDER BY (f.severity = 'severe') DESC,
                f.occurrence_count DESC`
    )
    .all();
}
