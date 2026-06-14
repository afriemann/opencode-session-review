// test/upsert.test.js
// Tests for upsertSignal() from src/lib/upsert.js

import { DatabaseSync } from 'node:sqlite';
import { ensureSchema } from '../src/lib/schema.js';
import { upsertSignal } from '../src/lib/upsert.js';

function makeLedger() {
  const db = new DatabaseSync(':memory:');
  ensureSchema(db);
  return db;
}

const baseOpts = {
  signalType: 'tool-error',
  agent: 'my-agent',
  tool: 'bash',
  description: 'test description',
  severity: 'normal',
  fingerprint: 'aabbccdd11223344aabbccdd11223344aabbccdd',
  sessionId: 'session-001',
  nowMs: 1000,
};

describe('upsertSignal()', () => {
  test('insert a new finding → { isNew: true, id: positive integer }', () => {
    const ledger = makeLedger();
    const result = upsertSignal(ledger, baseOpts);
    expect(result.isNew).toBe(true);
    expect(Number.isInteger(result.id)).toBe(true);
    expect(result.id).toBeGreaterThan(0);
  });

  test('new finding row has correct fields', () => {
    const ledger = makeLedger();
    const result = upsertSignal(ledger, baseOpts);
    const row = ledger
      .prepare('SELECT * FROM findings WHERE id = ?')
      .get(result.id);
    expect(row.fingerprint).toBe(baseOpts.fingerprint);
    expect(row.signal_type).toBe(baseOpts.signalType);
    expect(row.agent).toBe(baseOpts.agent);
    expect(row.tool).toBe(baseOpts.tool);
    expect(row.description).toBe(baseOpts.description);
    expect(row.severity).toBe(baseOpts.severity);
    expect(row.status).toBe('open');
    expect(Number(row.occurrence_count)).toBe(1);
    expect(Number(row.first_seen)).toBe(baseOpts.nowMs);
    expect(Number(row.last_seen)).toBe(baseOpts.nowMs);
  });

  test('upsert same fingerprint → { isNew: false }, occurrence_count incremented', () => {
    const ledger = makeLedger();
    upsertSignal(ledger, baseOpts);

    const second = upsertSignal(ledger, { ...baseOpts, nowMs: 2000 });
    expect(second.isNew).toBe(false);
    expect(second.id).toBe(
      ledger.prepare('SELECT id FROM findings WHERE fingerprint = ?').get(baseOpts.fingerprint).id,
    );

    const row = ledger
      .prepare('SELECT occurrence_count FROM findings WHERE fingerprint = ?')
      .get(baseOpts.fingerprint);
    expect(Number(row.occurrence_count)).toBe(2);
  });

  test('upsert same fingerprint → last_seen updated', () => {
    const ledger = makeLedger();
    upsertSignal(ledger, baseOpts);
    upsertSignal(ledger, { ...baseOpts, nowMs: 9999 });

    const row = ledger
      .prepare('SELECT last_seen FROM findings WHERE fingerprint = ?')
      .get(baseOpts.fingerprint);
    expect(Number(row.last_seen)).toBe(9999);
  });

  test('re-open: resolved finding → status becomes "open" on re-upsert', () => {
    const ledger = makeLedger();
    const { id } = upsertSignal(ledger, baseOpts);

    // Manually resolve
    ledger.prepare("UPDATE findings SET status = 'resolved' WHERE id = ?").run(id);
    const beforeRow = ledger.prepare('SELECT status FROM findings WHERE id = ?').get(id);
    expect(beforeRow.status).toBe('resolved');

    // Upsert again → should re-open
    upsertSignal(ledger, { ...baseOpts, nowMs: 3000 });
    const afterRow = ledger.prepare('SELECT status FROM findings WHERE id = ?').get(id);
    expect(afterRow.status).toBe('open');
  });

  test('finding_sessions row created on first insert', () => {
    const ledger = makeLedger();
    const { id } = upsertSignal(ledger, baseOpts);

    const fsRow = ledger
      .prepare('SELECT * FROM finding_sessions WHERE finding_id = ? AND session_id = ?')
      .get(id, baseOpts.sessionId);
    expect(fsRow).toBeDefined();
  });

  test('INSERT OR IGNORE: second upsert with same session does not create duplicate finding_sessions row', () => {
    const ledger = makeLedger();
    const { id } = upsertSignal(ledger, baseOpts);
    // Second upsert with same session
    upsertSignal(ledger, { ...baseOpts, nowMs: 2000 });

    const rows = ledger
      .prepare('SELECT * FROM finding_sessions WHERE finding_id = ? AND session_id = ?')
      .all(id, baseOpts.sessionId);
    expect(rows).toHaveLength(1);
  });

  test('different session on re-upsert → new finding_sessions row added', () => {
    const ledger = makeLedger();
    const { id } = upsertSignal(ledger, baseOpts);
    upsertSignal(ledger, { ...baseOpts, sessionId: 'session-002', nowMs: 2000 });

    const rows = ledger
      .prepare('SELECT * FROM finding_sessions WHERE finding_id = ?')
      .all(id);
    expect(rows).toHaveLength(2);
  });
});
