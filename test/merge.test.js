// test/merge.test.js
// Tests for cmdMerge() from src/lib/commands/merge.js

import { DatabaseSync } from 'node:sqlite';
import { ensureSchema } from '../src/lib/schema.js';
import { upsertSignal } from '../src/lib/upsert.js';
import { cmdMerge } from '../src/lib/commands/merge.js';

function makeLedger() {
  const db = new DatabaseSync(':memory:');
  ensureSchema(db);
  return db;
}

/**
 * Helper: insert a finding and return its id.
 */
function insertFinding(
  ledger,
  {
    fingerprint,
    signalType = 'tool-error',
    agent = 'test-agent',
    tool = 'bash',
    description = 'test',
    severity = 'normal',
    sessionId = 'sess-1',
    nowMs = 1000,
  } = {},
) {
  return upsertSignal(ledger, {
    fingerprint,
    signalType,
    agent,
    tool,
    description,
    severity,
    sessionId,
    nowMs,
  });
}

describe('cmdMerge()', () => {
  test('successful merge: occurrence_count is summed', () => {
    const ledger = makeLedger();
    const { id: dupId } = insertFinding(ledger, {
      fingerprint: 'fp-dup-aaaaaaaabbbbbbbbccccccccdddddddd11',
    });
    const { id: intoId } = insertFinding(ledger, {
      fingerprint: 'fp-into-11111111222222223333333344444444aa',
    });

    // Give dup a second occurrence so we can check summing
    upsertSignal(ledger, {
      fingerprint: 'fp-dup-aaaaaaaabbbbbbbbccccccccdddddddd11',
      signalType: 'tool-error',
      agent: 'test-agent',
      tool: 'bash',
      description: 'test',
      severity: 'normal',
      sessionId: 'sess-extra',
      nowMs: 2000,
    });

    // into starts at occurrence_count=1, dup at 2
    const beforeInto = ledger
      .prepare('SELECT occurrence_count FROM findings WHERE id = ?')
      .get(intoId);
    const beforeDup = ledger
      .prepare('SELECT occurrence_count FROM findings WHERE id = ?')
      .get(dupId);
    const expectedCount = Number(beforeInto.occurrence_count) + Number(beforeDup.occurrence_count);

    cmdMerge(ledger, dupId, intoId);

    const afterInto = ledger
      .prepare('SELECT occurrence_count FROM findings WHERE id = ?')
      .get(intoId);
    expect(Number(afterInto.occurrence_count)).toBe(expectedCount);
  });

  test('successful merge: duplicate row deleted', () => {
    const ledger = makeLedger();
    const { id: dupId } = insertFinding(ledger, {
      fingerprint: 'fp-dup2-aabbccdd11223344aabbccdd11223344ab',
    });
    const { id: intoId } = insertFinding(ledger, {
      fingerprint: 'fp-into2-aabbccdd11223344aabbccdd11223344cd',
    });

    cmdMerge(ledger, dupId, intoId);

    const dupRow = ledger.prepare('SELECT id FROM findings WHERE id = ?').get(dupId);
    expect(dupRow).toBeUndefined();
  });

  test('session_id rows moved from dup to into', () => {
    const ledger = makeLedger();
    const { id: dupId } = insertFinding(ledger, {
      fingerprint: 'fp-dup3-aabbccdd11223344aabbccdd11223344ef',
      sessionId: 'dup-session',
    });
    const { id: intoId } = insertFinding(ledger, {
      fingerprint: 'fp-into3-aabbccdd11223344aabbccdd11223344gh',
      sessionId: 'into-session',
    });

    cmdMerge(ledger, dupId, intoId);

    const sessions = ledger
      .prepare('SELECT session_id FROM finding_sessions WHERE finding_id = ?')
      .all(intoId)
      .map((r) => r.session_id);
    expect(sessions).toContain('dup-session');
    expect(sessions).toContain('into-session');
  });

  test('severity propagation: if dup is "severe", survivor becomes "severe"', () => {
    const ledger = makeLedger();
    const { id: dupId } = insertFinding(ledger, {
      fingerprint: 'fp-dup4-aabbccdd11223344aabbccdd11223344ij',
      severity: 'severe',
    });
    const { id: intoId } = insertFinding(ledger, {
      fingerprint: 'fp-into4-aabbccdd11223344aabbccdd11223344kl',
      severity: 'normal',
    });

    cmdMerge(ledger, dupId, intoId);

    const intoRow = ledger.prepare('SELECT severity FROM findings WHERE id = ?').get(intoId);
    expect(intoRow.severity).toBe('severe');
  });

  test('severity propagation: if into is "severe" and dup is "normal", survivor is still "severe"', () => {
    const ledger = makeLedger();
    const { id: dupId } = insertFinding(ledger, {
      fingerprint: 'fp-dup5-aabbccdd11223344aabbccdd11223344mn',
      severity: 'normal',
    });
    const { id: intoId } = insertFinding(ledger, {
      fingerprint: 'fp-into5-aabbccdd11223344aabbccdd11223344op',
      severity: 'severe',
    });

    cmdMerge(ledger, dupId, intoId);

    const intoRow = ledger.prepare('SELECT severity FROM findings WHERE id = ?').get(intoId);
    expect(intoRow.severity).toBe('severe');
  });

  test('last_seen takes MAX of both rows', () => {
    const ledger = makeLedger();
    const { id: dupId } = insertFinding(ledger, {
      fingerprint: 'fp-dup6-aabbccdd11223344aabbccdd11223344qr',
      nowMs: 9000,
    });
    const { id: intoId } = insertFinding(ledger, {
      fingerprint: 'fp-into6-aabbccdd11223344aabbccdd11223344st',
      nowMs: 3000,
    });

    cmdMerge(ledger, dupId, intoId);

    const intoRow = ledger.prepare('SELECT last_seen FROM findings WHERE id = ?').get(intoId);
    expect(Number(intoRow.last_seen)).toBe(9000);
  });

  test('merging non-existent IDs → throws an error', () => {
    const ledger = makeLedger();
    expect(() => cmdMerge(ledger, 9999, 8888)).toThrow();
  });

  test('dupId === intoId → throws an error', () => {
    const ledger = makeLedger();
    const { id } = insertFinding(ledger, {
      fingerprint: 'fp-same-aabbccdd11223344aabbccdd11223344uv',
    });
    expect(() => cmdMerge(ledger, id, id)).toThrow('dupId and intoId must differ');
  });

  test('non-integer dupId → throws an error', () => {
    const ledger = makeLedger();
    expect(() => cmdMerge(ledger, 'abc', 1)).toThrow();
  });

  test('non-positive intoId → throws an error', () => {
    const ledger = makeLedger();
    expect(() => cmdMerge(ledger, 1, 0)).toThrow();
  });
});
