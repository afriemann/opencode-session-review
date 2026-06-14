// src/lib/upsert.js — Create-then-reconcile upsert for the findings ledger.
//
// This module is the ledger's sole insert/update path for finding rows.
// It implements the same "create-then-reconcile" model as bash upsert_signal():
//   • New fingerprint  → INSERT INTO findings + INSERT OR IGNORE INTO finding_sessions
//   • Known fingerprint → UPDATE occurrence_count/last_seen/status (re-open) +
//                         INSERT OR IGNORE INTO finding_sessions
//
// Re-open semantics: a resolved finding whose fingerprint recurs is
// automatically set back to 'open' so it appears in list/json-open again.

/**
 * Insert or update one finding in the ledger.
 *
 * @param {import('node:sqlite').DatabaseSync} ledger
 * @param {object} opts
 * @param {string} opts.signalType    - 'tool-error' | 'permission-reject' | 'approval-toil'
 * @param {string} opts.agent         - agent name
 * @param {string} opts.tool          - tool name
 * @param {string} opts.description   - human-readable description (truncated upstream)
 * @param {string} opts.severity      - 'severe' | 'normal'
 * @param {string} opts.fingerprint   - 40-hex SHA-1
 * @param {string} opts.sessionId     - session UUID
 * @param {number} opts.nowMs         - epoch ms timestamp
 * @returns {{ isNew: boolean, id: number }}
 */
export function upsertSignal(
  ledger,
  { signalType, agent, tool, description, severity, fingerprint, sessionId, nowMs }
) {
  const existing = ledger
    .prepare('SELECT id FROM findings WHERE fingerprint = ?')
    .get(fingerprint);

  if (existing) {
    const id = existing.id;
    ledger
      .prepare(
        `UPDATE findings
           SET status = 'open',
               occurrence_count = occurrence_count + 1,
               last_seen = ?
         WHERE id = ?`
      )
      .run(nowMs, id);
    ledger
      .prepare(
        'INSERT OR IGNORE INTO finding_sessions (finding_id, session_id) VALUES (?, ?)'
      )
      .run(id, sessionId);
    return { isNew: false, id };
  }

  // New fingerprint: insert the finding row then link the session.
  ledger
    .prepare(
      `INSERT INTO findings
         (fingerprint, signal_type, agent, tool, description, severity,
          status, occurrence_count, first_seen, last_seen)
       VALUES (?, ?, ?, ?, ?, ?, 'open', 1, ?, ?)`
    )
    .run(fingerprint, signalType, agent, tool, description, severity, nowMs, nowMs);

  // Retrieve the newly inserted id (last_insert_rowid() equivalent via SELECT).
  const inserted = ledger
    .prepare('SELECT id FROM findings WHERE fingerprint = ?')
    .get(fingerprint);
  const newId = inserted.id;

  ledger
    .prepare(
      'INSERT OR IGNORE INTO finding_sessions (finding_id, session_id) VALUES (?, ?)'
    )
    .run(newId, sessionId);

  return { isNew: true, id: newId };
}
