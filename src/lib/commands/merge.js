// src/lib/commands/merge.js — Merge a duplicate finding into an existing one.
//
// Ports cmd_merge() from session-finding-capture.sh. All mutations run in a
// single transaction so an interruption cannot orphan rows or corrupt counts.

/**
 * Merge finding `dupId` into `intoId`.
 *
 * Steps (in one BEGIN IMMEDIATE transaction):
 *   1. Validate both IDs exist.
 *   2. UPDATE OR IGNORE finding_sessions: move dup's sessions to into.
 *   3. DELETE remaining dup's finding_sessions rows.
 *   4. UPDATE findings: sum occurrence_count, MAX(last_seen), propagate 'severe'.
 *   5. DELETE FROM findings WHERE id = dupId.
 *
 * @param {import('node:sqlite').DatabaseSync} ledger
 * @param {number} dupId   - the duplicate (to be removed)
 * @param {number} intoId  - the canonical row to keep
 */
export function cmdMerge(ledger, dupId, intoId) {
  if (!Number.isInteger(dupId) || dupId <= 0)
    throw new Error(`merge: dupId must be a positive integer, got: ${dupId}`);
  if (!Number.isInteger(intoId) || intoId <= 0)
    throw new Error(`merge: intoId must be a positive integer, got: ${intoId}`);
  if (dupId === intoId)
    throw new Error('merge: dupId and intoId must differ');

  // Validate both rows exist before mutating anything.
  const count = (id) =>
    ledger.prepare('SELECT COUNT(*) AS n FROM findings WHERE id = ?').get(id).n;
  if (count(dupId) !== 1 || count(intoId) !== 1) {
    throw new Error(
      `merge: one or both IDs not found in ledger (${dupId}, ${intoId})`
    );
  }

  ledger.exec('BEGIN IMMEDIATE');
  try {
    // Move dup's session links to into (INSERT OR IGNORE prevents PK conflicts).
    ledger
      .prepare(
        'UPDATE OR IGNORE finding_sessions SET finding_id = ? WHERE finding_id = ?'
      )
      .run(intoId, dupId);
    // Remove any remaining dup session links (those that conflicted above).
    ledger
      .prepare('DELETE FROM finding_sessions WHERE finding_id = ?')
      .run(dupId);
    // Merge counts, last_seen, and severity into the canonical row.
    ledger
      .prepare(
        `UPDATE findings
           SET occurrence_count = occurrence_count +
                 (SELECT occurrence_count FROM findings WHERE id = ?),
               last_seen = MAX(last_seen,
                 (SELECT last_seen FROM findings WHERE id = ?)),
               severity = CASE
                 WHEN severity = 'severe'
                   OR (SELECT severity FROM findings WHERE id = ?) = 'severe'
                 THEN 'severe'
                 ELSE severity
               END
         WHERE id = ?`
      )
      .run(dupId, dupId, dupId, intoId);
    // Delete the duplicate row.
    ledger.prepare('DELETE FROM findings WHERE id = ?').run(dupId);
    ledger.exec('COMMIT');
  } catch (err) {
    ledger.exec('ROLLBACK');
    throw err;
  }
}
