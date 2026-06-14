// test/status.test.js
// Tests for cmdResolve() and cmdReopen() from src/lib/commands/status.js

import { DatabaseSync } from 'node:sqlite';
import { ensureSchema } from '../src/lib/schema.js';
import { upsertSignal } from '../src/lib/upsert.js';
import { cmdResolve, cmdReopen } from '../src/lib/commands/status.js';

function makeLedger() {
  const db = new DatabaseSync(':memory:');
  ensureSchema(db);
  return db;
}

function insertFinding(ledger, fingerprint, sessionId = 'sess-1') {
  return upsertSignal(ledger, {
    fingerprint,
    signalType: 'tool-error',
    agent: 'test-agent',
    tool: 'bash',
    description: 'test description',
    severity: 'normal',
    sessionId,
    nowMs: Date.now(),
  });
}

describe('cmdResolve()', () => {
  test('resolve an open finding → status becomes "resolved"', () => {
    const ledger = makeLedger();
    const { id } = insertFinding(ledger, 'fp-resolve-aabbccdd11223344aabbccdd11223344');

    cmdResolve(ledger, [id]);

    const row = ledger.prepare('SELECT status FROM findings WHERE id = ?').get(id);
    expect(row.status).toBe('resolved');
  });

  test('idempotent: resolving an already-resolved finding does not error', () => {
    const ledger = makeLedger();
    const { id } = insertFinding(ledger, 'fp-resolve2-aabbccdd11223344aabbccdd11223344');

    cmdResolve(ledger, [id]);
    expect(() => cmdResolve(ledger, [id])).not.toThrow();

    const row = ledger.prepare('SELECT status FROM findings WHERE id = ?').get(id);
    expect(row.status).toBe('resolved');
  });

  test('resolve multiple IDs at once', () => {
    const ledger = makeLedger();
    const { id: id1 } = insertFinding(ledger, 'fp-multi1-aabbccdd11223344aabbccdd11223344');
    const { id: id2 } = insertFinding(ledger, 'fp-multi2-aabbccdd11223344aabbccdd11223344');

    cmdResolve(ledger, [id1, id2]);

    const row1 = ledger.prepare('SELECT status FROM findings WHERE id = ?').get(id1);
    const row2 = ledger.prepare('SELECT status FROM findings WHERE id = ?').get(id2);
    expect(row1.status).toBe('resolved');
    expect(row2.status).toBe('resolved');
  });

  test('non-existent ID → throws an error', () => {
    const ledger = makeLedger();
    expect(() => cmdResolve(ledger, [99999])).toThrow();
  });

  test('empty ids array → throws an error', () => {
    const ledger = makeLedger();
    expect(() => cmdResolve(ledger, [])).toThrow();
  });

  test('non-positive id → throws an error', () => {
    const ledger = makeLedger();
    expect(() => cmdResolve(ledger, [0])).toThrow();
  });
});

describe('cmdReopen()', () => {
  test('reopen a resolved finding → status becomes "open"', () => {
    const ledger = makeLedger();
    const { id } = insertFinding(ledger, 'fp-reopen-aabbccdd11223344aabbccdd11223344');

    // Resolve first
    cmdResolve(ledger, [id]);
    const before = ledger.prepare('SELECT status FROM findings WHERE id = ?').get(id);
    expect(before.status).toBe('resolved');

    // Now reopen
    cmdReopen(ledger, [id]);
    const after = ledger.prepare('SELECT status FROM findings WHERE id = ?').get(id);
    expect(after.status).toBe('open');
  });

  test('idempotent: reopening an already-open finding does not error', () => {
    const ledger = makeLedger();
    const { id } = insertFinding(ledger, 'fp-reopen2-aabbccdd11223344aabbccdd11223344');

    // Already open
    expect(() => cmdReopen(ledger, [id])).not.toThrow();
    const row = ledger.prepare('SELECT status FROM findings WHERE id = ?').get(id);
    expect(row.status).toBe('open');
  });

  test('non-existent ID → throws an error', () => {
    const ledger = makeLedger();
    expect(() => cmdReopen(ledger, [99999])).toThrow();
  });

  test('empty ids array → throws an error', () => {
    const ledger = makeLedger();
    expect(() => cmdReopen(ledger, [])).toThrow();
  });
});
