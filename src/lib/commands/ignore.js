// src/lib/commands/ignore.js — Permanently suppress a finding's fingerprint.
//
// Ports cmd_ignore() from session-finding-capture.sh.
// Records each finding's fingerprint in ignored_fingerprints and resolves the
// finding. Future approval-toil captures skip any matching fingerprint (gate 5
// in commands/capture.js), so the candidate stops accruing.
//
// Note: tool-error and permission-reject captures do NOT consult
// ignored_fingerprints, so ignoring one of those resolves it but a future
// occurrence will reopen it. The `ignore` command is primarily intended for
// approval-toil candidates.

/**
 * Permanently suppress one or more findings by fingerprint.
 *
 * @param {import('node:sqlite').DatabaseSync} ledger
 * @param {number[]} ids
 */
export function cmdIgnore(ledger, ids) {
  if (!ids || ids.length === 0) {
    throw new Error('ignore: requires at least one finding id');
  }
  for (const id of ids) {
    if (!Number.isInteger(id) || id <= 0) {
      throw new Error(`ignore: invalid id (not a positive integer): ${id}`);
    }
  }
  const now = Date.now();

  // Verify all rows exist before mutating anything.
  for (const id of ids) {
    const { n } = ledger
      .prepare('SELECT COUNT(*) AS n FROM findings WHERE id = ?')
      .get(id);
    if (n !== 1) {
      throw new Error(`ignore: finding id ${id} not found in ledger`);
    }
  }

  ledger.exec('BEGIN IMMEDIATE');
  try {
    const insertFp = ledger.prepare(
      `INSERT OR IGNORE INTO ignored_fingerprints (fingerprint, reason, created_ms)
         SELECT fingerprint, 'user-ignored via finding ' || id, ?
           FROM findings WHERE id = ?`
    );
    const resolve = ledger.prepare(
      "UPDATE findings SET status = 'resolved' WHERE id = ?"
    );
    for (const id of ids) {
      insertFp.run(now, id);
      resolve.run(id);
    }
    ledger.exec('COMMIT');
  } catch (err) {
    ledger.exec('ROLLBACK');
    throw err;
  }
}
