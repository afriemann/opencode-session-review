// test/capture.test.js
// Integration tests for cmdCapture() from src/lib/commands/capture.js
//
// These tests use in-memory databases: buildSessionStore() for the opencode
// session store and a fresh in-memory ledger for the findings.
//
// The approval-toil path requires agentBashRules() which calls
// `opencode debug config` — not available in the test environment.
// However, the pass is gated on `bashCmds.length > 0` (line 109 of capture.js).
// Tests that do NOT add bash parts will never trigger that path, and that is
// tested explicitly. Tests for excluded-agent and throttle likewise do not
// require bash rules.
//
// To make cmdCapture use in-memory databases instead of real file paths, we
// mock src/lib/db.js so openDatabases() returns our in-memory instances.

import { DatabaseSync } from 'node:sqlite';
import { jest } from '@jest/globals';
import { ensureSchema } from '../src/lib/schema.js';
import { buildSessionStore } from './fixtures/session-store-builder.js';

// We need to mock the db module before importing cmdCapture so it uses
// in-memory databases. Jest's ESM module mocking with unstable_mockModule.
let cmdCapture;
let ledger;
let sessionStoreHelper;

// Hold references so we can swap them per test
let currentLedger;
let currentSessionStore;

beforeAll(async () => {
  // Set up Jest module mock for db.js
  jest.unstable_mockModule('../src/lib/db.js', () => ({
    openDatabases: jest.fn(({ ledgerPath, sessionStorePath }) => {
      return { ledger: currentLedger, sessionStore: currentSessionStore };
    }),
    openLedger: jest.fn(() => currentLedger),
  }));

  // Import cmdCapture AFTER mock is installed
  const mod = await import('../src/lib/commands/capture.js');
  cmdCapture = mod.cmdCapture;
});

beforeEach(() => {
  // Fresh in-memory databases for each test
  currentLedger = new DatabaseSync(':memory:');
  ensureSchema(currentLedger);

  sessionStoreHelper = buildSessionStore();
  currentSessionStore = sessionStoreHelper.db;
});

const BASE_OPTS = {
  openCodeDb: ':memory:',
  findingsDb: ':memory:',
  captureMinIntervalMs: 0,   // disable throttle for most tests
  excludedAgents: ['agent-engineer', 'session-finding-deduper'],
  approvalAllowPrefixes: ['go', 'gh', 'git', 'npm'],
  approvalDenyShapes: ['git push *', 'git commit *'],
};

const NOW = 1000000;

describe('cmdCapture()', () => {
  test('session with 2 tool-error parts → new array contains 2 findings', async () => {
    const sessionId = 'sess-two-errors';
    sessionStoreHelper.addSession(sessionId, 'dev-agent', NOW - 10000);
    sessionStoreHelper.addToolError(sessionId, 'bash', 'command not found: foobar', NOW - 5000);
    sessionStoreHelper.addToolError(sessionId, 'read', 'file not found: /missing.txt', NOW - 4000);

    const result = await cmdCapture(sessionId, {
      ...BASE_OPTS,
      captureMinIntervalMs: 0,
    });

    expect(result.skipped).toBeUndefined();
    expect(Array.isArray(result.new)).toBe(true);
    expect(result.new).toHaveLength(2);
    expect(Array.isArray(result.open_others)).toBe(true);
  });

  test('re-run (second call, upper > watermark) → new is empty (no double-count)', async () => {
    const sessionId = 'sess-rerun';
    sessionStoreHelper.addSession(sessionId, 'dev-agent', NOW - 10000);
    sessionStoreHelper.addToolError(sessionId, 'bash', 'cmd not found: bar', NOW - 8000);
    sessionStoreHelper.addToolError(sessionId, 'read', 'no such file', NOW - 7000);

    // First capture
    const first = await cmdCapture(sessionId, BASE_OPTS);
    expect(first.new).toHaveLength(2);

    // Second capture (same session, no new parts in the time window)
    const second = await cmdCapture(sessionId, BASE_OPTS);
    // No new parts since watermark advance → new should be empty
    expect(second.new).toHaveLength(0);
    // Per cmdCapture implementation: when newIds.length === 0, returns { new: [], open_others: [] }
    // (open_others is only populated alongside new findings for the dedup prompt)
    expect(Array.isArray(second.open_others)).toBe(true);
  });

  test('re-run with a new part after first capture → new finding captured, previous in open_others', async () => {
    const sessionId = 'sess-rerun2';
    sessionStoreHelper.addSession(sessionId, 'dev-agent', NOW - 10000);
    sessionStoreHelper.addToolError(sessionId, 'bash', 'first error rerun2', NOW - 8000);

    // First capture at time T1
    const first = await cmdCapture(sessionId, BASE_OPTS);
    expect(first.new).toHaveLength(1);
    const firstId = first.new[0].id;

    // Add a NEW part with time_created = Date.now() (after first capture settled the watermark).
    // The watermark was set to `upper = Date.now()` during the first call.
    // Since `addToolError` defaults to Date.now(), and we're now after the first call
    // completed (synchronous sqlite writes), this part's timestamp > watermark.
    await new Promise((res) => setTimeout(res, 5));
    sessionStoreHelper.addToolError(
      sessionId,
      'read',
      'second entirely different error rerun2',
      Date.now(),
    );

    const second = await cmdCapture(sessionId, BASE_OPTS);
    // The new error should be captured as a new finding
    expect(second.new).toHaveLength(1);
    expect(second.new[0].id).not.toBe(firstId);
    // open_others should contain the first finding
    expect(second.open_others.some((f) => f.id === firstId)).toBe(true);
  });

  test('session with a permission-reject part → signal_type === "permission-reject"', async () => {
    const sessionId = 'sess-perm-reject';
    sessionStoreHelper.addSession(sessionId, 'dev-agent', NOW - 10000);
    sessionStoreHelper.addPermissionReject(sessionId, 'bash', 'rm -rf /important', NOW - 5000);

    const result = await cmdCapture(sessionId, BASE_OPTS);

    expect(result.skipped).toBeUndefined();
    expect(result.new).toHaveLength(1);
    expect(result.new[0].signal_type).toBe('permission-reject');
  });

  test('excluded agent session → returns { skipped: "excluded-agent" }', async () => {
    const sessionId = 'sess-excluded';
    sessionStoreHelper.addSession(sessionId, 'agent-engineer', NOW - 10000);
    sessionStoreHelper.addToolError(sessionId, 'bash', 'some error', NOW - 5000);

    const result = await cmdCapture(sessionId, BASE_OPTS);

    expect(result.skipped).toBe('excluded-agent');
    expect(result.new).toHaveLength(0);
    expect(result.open_others).toHaveLength(0);
  });

  test('throttle: two calls within captureMinIntervalMs → second returns { skipped: "throttled" }', async () => {
    const sessionId = 'sess-throttle';
    sessionStoreHelper.addSession(sessionId, 'dev-agent', NOW - 10000);
    sessionStoreHelper.addToolError(sessionId, 'bash', 'error A', NOW - 5000);

    // First capture with a long throttle interval
    const THROTTLE_MS = 60000;
    await cmdCapture(sessionId, {
      ...BASE_OPTS,
      captureMinIntervalMs: THROTTLE_MS,
    });

    // Second immediate capture — should be throttled
    const second = await cmdCapture(sessionId, {
      ...BASE_OPTS,
      captureMinIntervalMs: THROTTLE_MS,
    });

    expect(second.skipped).toBe('throttled');
  });

  test('session not found in store → throws', async () => {
    await expect(
      cmdCapture('nonexistent-session-id', BASE_OPTS),
    ).rejects.toThrow('session not found in store');
  });

  test('no bash parts → approval-toil path not triggered (no call to agentBashRules)', async () => {
    // This verifies the guard: if no bash commands, the toil pass is skipped.
    // The test will error if agentBashRules somehow throws from missing binary.
    const sessionId = 'sess-no-bash';
    sessionStoreHelper.addSession(sessionId, 'dev-agent', NOW - 10000);
    sessionStoreHelper.addToolError(sessionId, 'read', 'file missing', NOW - 5000);

    const result = await cmdCapture(sessionId, BASE_OPTS);

    // Should succeed without errors from agentBashRules
    expect(result.new).toHaveLength(1);
    expect(result.new[0].signal_type).toBe('tool-error');
  });

  test('same fingerprint across two sessions is not double-counted in new', async () => {
    const sessionId1 = 'sess-fp-1';
    const sessionId2 = 'sess-fp-2';
    // Same error text and tool → same fingerprint
    const sameError = 'identical error message for both sessions';

    sessionStoreHelper.addSession(sessionId1, 'dev-agent', NOW - 10000);
    sessionStoreHelper.addSession(sessionId2, 'dev-agent', NOW - 10000);
    sessionStoreHelper.addToolError(sessionId1, 'bash', sameError, NOW - 5000);
    sessionStoreHelper.addToolError(sessionId2, 'bash', sameError, NOW - 4000);

    // Capture session 1 → inserts the finding as new
    const result1 = await cmdCapture(sessionId1, BASE_OPTS);
    expect(result1.new).toHaveLength(1);

    // Capture session 2 → same fingerprint; upsertSignal re-opens but isNew=false
    const result2 = await cmdCapture(sessionId2, BASE_OPTS);
    // The finding already exists, so it's not reported as new
    expect(result2.new).toHaveLength(0);
  });
});
