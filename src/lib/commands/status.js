// src/lib/commands/status.js — Set finding status (resolve / reopen).
//
// Ports cmd_set_status() / cmd_resolve() / cmd_reopen() from
// session-finding-capture.sh. Validates all IDs before mutating anything,
// then runs all updates in a single transaction.

/**
 * Set status for one or more finding rows.
 *
 * @param {import('node:sqlite').DatabaseSync} ledger
 * @param {number[]} ids
 * @param {'resolved' | 'open'} status
 */
function setStatus(ledger, ids, status) {
  if (!ids || ids.length === 0) {
    throw new Error(`${status}: requires at least one finding id`);
  }
  for (const id of ids) {
    if (!Number.isInteger(id) || id <= 0) {
      throw new Error(`${status}: invalid id (not a positive integer): ${id}`);
    }
  }
  // Verify all rows exist before opening the transaction.
  for (const id of ids) {
    const { n } = ledger
      .prepare('SELECT COUNT(*) AS n FROM findings WHERE id = ?')
      .get(id);
    if (n !== 1) {
      throw new Error(`${status}: finding id ${id} not found in ledger`);
    }
  }

  ledger.exec('BEGIN IMMEDIATE');
  try {
    const stmt = ledger.prepare("UPDATE findings SET status = ? WHERE id = ?");
    for (const id of ids) {
      stmt.run(status, id);
    }
    ledger.exec('COMMIT');
  } catch (err) {
    ledger.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Set status='resolved' for each finding id. Idempotent.
 *
 * @param {import('node:sqlite').DatabaseSync} ledger
 * @param {number[]} ids
 */
export function cmdResolve(ledger, ids) {
  setStatus(ledger, ids, 'resolved');
}

/**
 * Set status='open' for each finding id. Idempotent.
 *
 * @param {import('node:sqlite').DatabaseSync} ledger
 * @param {number[]} ids
 */
export function cmdReopen(ledger, ids) {
  setStatus(ledger, ids, 'open');
}
