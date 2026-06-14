// src/lib/signals.js — Read-only queries against the opencode session store.
//
// Each function uses prepared statements with ? positional parameters.
// The JSON field paths mirror the bash ro_tsv() queries in cmd_capture().
//
// Session store schema (opencode's own, accessed read-only):
//   part(session_id, time_created, data TEXT)
//     data is a JSON blob with fields:
//       $.type              — 'tool' for tool-call parts
//       $.tool              — tool name
//       $.state.status      — 'completed' | 'error'
//       $.state.error       — error string (when status='error')
//       $.state.input.command — bash command (when tool='bash')
//
//   session(id, agent)

/**
 * Extract tool-error parts from a session's time window.
 * Excludes permission rejections (those have their own query).
 *
 * @param {import('node:sqlite').DatabaseSync} sessionStore
 * @param {string} sessionId
 * @param {number} wmPartMs  - lower bound (exclusive)
 * @param {number} upperMs   - upper bound (inclusive)
 * @returns {Array<{signalType: 'tool-error', tool: string, rawText: string}>}
 */
export function extractToolErrors(sessionStore, sessionId, wmPartMs, upperMs) {
  const rows = sessionStore
    .prepare(
      `SELECT
         COALESCE(json_extract(data, '$.tool'), '') AS tool,
         replace(replace(COALESCE(json_extract(data, '$.state.error'), ''), char(10), ' '), char(9), ' ') AS txt
       FROM part
       WHERE session_id = ?
         AND time_created > ? AND time_created <= ?
         AND json_extract(data, '$.type') = 'tool'
         AND json_extract(data, '$.state.status') = 'error'
         AND COALESCE(json_extract(data, '$.state.error'), '') NOT LIKE '%rejected permission%'`
    )
    .all(sessionId, wmPartMs, upperMs);

  return rows.map((r) => ({
    signalType: 'tool-error',
    tool: r.tool || '',
    rawText: r.txt || '',
  }));
}

/**
 * Extract permission-reject parts from a session's time window.
 * These are tool parts whose error message contains 'rejected permission'.
 * The raw text for these is the bash command ($.state.input.command),
 * matching the bash script's permission-reject query.
 *
 * @param {import('node:sqlite').DatabaseSync} sessionStore
 * @param {string} sessionId
 * @param {number} wmPartMs
 * @param {number} upperMs
 * @returns {Array<{signalType: 'permission-reject', tool: string, rawText: string}>}
 */
export function extractPermissionRejects(sessionStore, sessionId, wmPartMs, upperMs) {
  const rows = sessionStore
    .prepare(
      `SELECT
         COALESCE(json_extract(data, '$.tool'), '') AS tool,
         replace(replace(COALESCE(json_extract(data, '$.state.input.command'), ''), char(10), ' '), char(9), ' ') AS txt
       FROM part
       WHERE session_id = ?
         AND time_created > ? AND time_created <= ?
         AND json_extract(data, '$.state.error') LIKE '%rejected permission%'`
    )
    .all(sessionId, wmPartMs, upperMs);

  return rows.map((r) => ({
    signalType: 'permission-reject',
    tool: r.tool || '',
    rawText: r.txt || '',
  }));
}

/**
 * Extract completed bash command strings from a session's time window.
 * Returns only non-empty command strings.
 *
 * @param {import('node:sqlite').DatabaseSync} sessionStore
 * @param {string} sessionId
 * @param {number} wmPartMs
 * @param {number} upperMs
 * @returns {string[]}
 */
export function extractBashCommands(sessionStore, sessionId, wmPartMs, upperMs) {
  const rows = sessionStore
    .prepare(
      `SELECT
         replace(replace(COALESCE(json_extract(data, '$.state.input.command'), ''), char(10), ' '), char(9), ' ') AS cmd
       FROM part
       WHERE session_id = ?
         AND time_created > ? AND time_created <= ?
         AND json_extract(data, '$.type') = 'tool'
         AND json_extract(data, '$.tool') = 'bash'
         AND json_extract(data, '$.state.status') = 'completed'
         AND COALESCE(json_extract(data, '$.state.input.command'), '') <> ''`
    )
    .all(sessionId, wmPartMs, upperMs);

  return rows.map((r) => r.cmd).filter(Boolean);
}

/**
 * Get the agent name for a session.
 *
 * @param {import('node:sqlite').DatabaseSync} sessionStore
 * @param {string} sessionId
 * @returns {string | null}
 */
export function getSessionAgent(sessionStore, sessionId) {
  const row = sessionStore
    .prepare('SELECT agent FROM session WHERE id = ?')
    .get(sessionId);
  return (row && row.agent) || null;
}
