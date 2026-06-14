// src/lib/db.js — Database factory.
//
// Opens both the findings ledger (rw) and the opencode session store (ro)
// and returns the DatabaseSync instances. No other module imports node:sqlite
// directly — they all receive the db objects from openDatabases().
//
// The ledger is opened with PRAGMA busy_timeout = 5000 so concurrent capture
// processes wait for the lock instead of failing immediately.
//
// Both databases are opened lazily: openDatabases() must be called explicitly
// by each command that needs them. This keeps `init` working even when the
// session store does not yet exist.

import { DatabaseSync } from 'node:sqlite';

/**
 * Open both databases and return them.
 *
 * @param {object} opts
 * @param {string} opts.ledgerPath       - path to the findings ledger (rw)
 * @param {string} opts.sessionStorePath - path to the opencode session store (ro)
 * @returns {{ ledger: DatabaseSync, sessionStore: DatabaseSync }}
 */
export function openDatabases({ ledgerPath, sessionStorePath }) {
  const ledger = new DatabaseSync(ledgerPath);
  ledger.exec('PRAGMA busy_timeout = 5000');

  const sessionStore = new DatabaseSync(sessionStorePath, { readOnly: true });

  return { ledger, sessionStore };
}

/**
 * Open only the findings ledger (rw). Used by commands that do not need
 * the session store (merge, resolve, reopen, ignore, list, json-open, init).
 *
 * @param {string} ledgerPath
 * @returns {DatabaseSync}
 */
export function openLedger(ledgerPath) {
  const ledger = new DatabaseSync(ledgerPath);
  ledger.exec('PRAGMA busy_timeout = 5000');
  return ledger;
}
