// src/lib/commands/list.js — Human-readable table of open findings.
//
// Ports cmd_list() from session-finding-capture.sh.
// Returns rows ordered severe-first, then by occurrence_count DESC, then by
// distinct session count DESC. Description is truncated to 90 chars.

/**
 * Return open findings as an array of objects for human display.
 *
 * Columns (matching the bash sqlite3 column-mode output):
 *   id, severity (sev), signal_type (signal), tool, occurrence_count (n),
 *   sessions (distinct session count), description (truncated to 90 chars)
 *
 * @param {import('node:sqlite').DatabaseSync} ledger
 * @returns {Array<{id: number, sev: string, signal: string, tool: string, n: number, sessions: number, description: string}>}
 */
export function cmdList(ledger) {
  return ledger
    .prepare(
      `SELECT
         f.id,
         f.severity AS sev,
         f.signal_type AS signal,
         f.tool AS tool,
         f.occurrence_count AS n,
         (SELECT COUNT(*) FROM finding_sessions s WHERE s.finding_id = f.id) AS sessions,
         substr(f.description, 1, 90) AS description
       FROM findings f
       WHERE f.status = 'open'
       ORDER BY (f.severity = 'severe') DESC,
                f.occurrence_count DESC,
                sessions DESC`
    )
    .all();
}
