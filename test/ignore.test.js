// test/ignore.test.js
// Tests for cmdIgnore() from src/lib/commands/ignore.js

import { DatabaseSync } from 'node:sqlite';
import { ensureSchema } from '../src/lib/schema.js';
import { upsertSignal } from '../src/lib/upsert.js';
import { cmdIgnore } from '../src/lib/commands/ignore.js';

function makeLedger() {
  const db = new DatabaseSync(':memory:');
  ensureSchema(db);
  return db;
}

function insertFinding(ledger, fingerprint, sessionId = 'sess-1') {
  return upsertSignal(ledger, {
    fingerprint,
    signalType: 'approval-toil',
    agent: 'test-agent',
    tool: 'bash',
    description: 'test approval toil finding',
    severity: 'normal',
    sessionId,
    nowMs: Date.now(),
  });
}

describe('cmdIgnore()', () => {
  test('fingerprint appears in ignored_fingerprints after ignore', () => {
    const ledger = makeLedger();
    const fp = 'fp-ignore1-aabbccdd11223344aabbccdd11223344ab';
    const { id } = insertFinding(ledger, fp);

    cmdIgnore(ledger, [id]);

    const row = ledger
      .prepare('SELECT fingerprint FROM ignored_fingerprints WHERE fingerprint = ?')
      .get(fp);
    expect(row).toBeDefined();
    expect(row.fingerprint).toBe(fp);
  });

  test('finding status becomes "resolved" after ignore', () => {
    const ledger = makeLedger();
    const fp = 'fp-ignore2-aabbccdd11223344aabbccdd11223344cd';
    const { id } = insertFinding(ledger, fp);

    cmdIgnore(ledger, [id]);

    const row = ledger.prepare('SELECT status FROM findings WHERE id = ?').get(id);
    expect(row.status).toBe('resolved');
  });

  test('ignore multiple findings at once', () => {
    const ledger = makeLedger();
    const fp1 = 'fp-ignore3a-aabbccdd11223344aabbccdd11223344ef';
    const fp2 = 'fp-ignore3b-aabbccdd11223344aabbccdd11223344gh';
    const { id: id1 } = insertFinding(ledger, fp1);
    const { id: id2 } = insertFinding(ledger, fp2, 'sess-2');

    cmdIgnore(ledger, [id1, id2]);

    const row1 = ledger.prepare('SELECT status FROM findings WHERE id = ?').get(id1);
    const row2 = ledger.prepare('SELECT status FROM findings WHERE id = ?').get(id2);
    expect(row1.status).toBe('resolved');
    expect(row2.status).toBe('resolved');

    const fp1Row = ledger
      .prepare('SELECT fingerprint FROM ignored_fingerprints WHERE fingerprint = ?')
      .get(fp1);
    expect(fp1Row).toBeDefined();
    const fp2Row = ledger
      .prepare('SELECT fingerprint FROM ignored_fingerprints WHERE fingerprint = ?')
      .get(fp2);
    expect(fp2Row).toBeDefined();
  });

  test('non-existent ID → throws an error', () => {
    const ledger = makeLedger();
    expect(() => cmdIgnore(ledger, [99999])).toThrow();
  });

  test('empty ids → throws an error', () => {
    const ledger = makeLedger();
    expect(() => cmdIgnore(ledger, [])).toThrow();
  });

  test('non-positive id → throws an error', () => {
    const ledger = makeLedger();
    expect(() => cmdIgnore(ledger, [0])).toThrow();
  });

  test('ignored fingerprint prevents re-insert via ignored_fingerprints table (gate 5)', () => {
    // Gate 5 is checked in cmdCapture using the ignored_fingerprints table.
    // Here we verify that after cmdIgnore, the fingerprint IS in ignored_fingerprints,
    // so the gate 5 SELECT COUNT(*) query would return n=1.
    const ledger = makeLedger();
    const fp = 'fp-gate5-aabbccdd11223344aabbccdd11223344ij';
    const { id } = insertFinding(ledger, fp);

    cmdIgnore(ledger, [id]);

    // Simulate gate 5 check from cmdCapture
    const { n } = ledger
      .prepare('SELECT COUNT(*) AS n FROM ignored_fingerprints WHERE fingerprint = ?')
      .get(fp);
    expect(n).toBe(1);
  });

  test('upsertSignal with same fingerprint after ignore re-opens the finding (no gate 5 in upsertSignal)', () => {
    // Gate 5 is in cmdCapture, not upsertSignal. So upsertSignal itself will
    // re-open the finding. This test documents and verifies that boundary.
    const ledger = makeLedger();
    const fp = 'fp-reopen-gate5-aabbccdd11223344aabbccdd1122';
    const { id } = insertFinding(ledger, fp);

    cmdIgnore(ledger, [id]);
    const beforeStatus = ledger.prepare('SELECT status FROM findings WHERE id = ?').get(id);
    expect(beforeStatus.status).toBe('resolved');

    // upsertSignal bypasses gate 5 (which lives in cmdCapture) and re-opens
    upsertSignal(ledger, {
      fingerprint: fp,
      signalType: 'approval-toil',
      agent: 'test-agent',
      tool: 'bash',
      description: 'second occurrence',
      severity: 'normal',
      sessionId: 'sess-2',
      nowMs: Date.now() + 1000,
    });

    const afterStatus = ledger.prepare('SELECT status FROM findings WHERE id = ?').get(id);
    expect(afterStatus.status).toBe('open');
  });
});
