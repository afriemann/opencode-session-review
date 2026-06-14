// test/suspect-fabrication.test.js
// Tests for the suspect-fabrication signal in cmdCapture().
//
// The signal fires when ALL of:
//   1. The session's agent is in opts.fabricationAgents
//   2. Zero webfetch tool-call parts exist in the time window
//   3. At least one assistant text part "looks sourced":
//      contains an http/https URL, OR '### Sources', OR '| URL |'
//
// These tests mirror the structure of capture.test.js, using the same
// jest.unstable_mockModule pattern to inject in-memory databases.

import { DatabaseSync } from 'node:sqlite';
import { jest } from '@jest/globals';
import { ensureSchema } from '../src/lib/schema.js';
import { buildSessionStore } from './fixtures/session-store-builder.js';

// Hold references swapped per test (pattern from capture.test.js)
let currentLedger;
let currentSessionStore;

let cmdCapture;
let sessionStoreHelper;

beforeAll(async () => {
  jest.unstable_mockModule('../src/lib/db.js', () => ({
    openDatabases: jest.fn(() => ({
      ledger: currentLedger,
      sessionStore: currentSessionStore,
    })),
    openLedger: jest.fn(() => currentLedger),
  }));

  const mod = await import('../src/lib/commands/capture.js');
  cmdCapture = mod.cmdCapture;
});

beforeEach(() => {
  currentLedger = new DatabaseSync(':memory:');
  ensureSchema(currentLedger);

  sessionStoreHelper = buildSessionStore();
  currentSessionStore = sessionStoreHelper.db;
});

// Base opts — approval-toil path is never hit (no bash parts inserted)
const BASE_OPTS = {
  openCodeDb: ':memory:',
  findingsDb: ':memory:',
  captureMinIntervalMs: 0,
  excludedAgents: ['agent-engineer', 'session-finding-deduper'],
  approvalAllowPrefixes: ['go', 'gh', 'git', 'npm'],
  approvalDenyShapes: ['git push *', 'git commit *'],
  fabricationAgents: ['web-researcher'],
};

const NOW = 1000000;

describe('suspect-fabrication signal', () => {
  // ── Test 1 ──────────────────────────────────────────────────────────────
  test('agent in fabricationAgents, assistant text has URL, zero webfetch calls → exactly ONE finding', async () => {
    const sessionId = 'sess-fab-url';
    sessionStoreHelper.addSession(sessionId, 'web-researcher', NOW - 10000);
    sessionStoreHelper.addAssistantTextPart(
      sessionId,
      'According to https://example.com/docs the answer is yes.',
      NOW - 5000,
    );

    const result = await cmdCapture(sessionId, BASE_OPTS);

    expect(result.skipped).toBeUndefined();
    expect(result.new).toHaveLength(1);
    expect(result.new[0].signal_type).toBe('suspect-fabrication');
    expect(result.new[0].tool).toBe('webfetch');
    expect(result.new[0].agent).toBe('web-researcher');
  });

  // ── Test 2 ──────────────────────────────────────────────────────────────
  test('agent in fabricationAgents, assistant text has URL, but ≥1 webfetch call → NO finding', async () => {
    const sessionId = 'sess-fab-has-fetch';
    sessionStoreHelper.addSession(sessionId, 'web-researcher', NOW - 10000);
    sessionStoreHelper.addAssistantTextPart(
      sessionId,
      'According to https://example.com/docs the answer is yes.',
      NOW - 5000,
    );
    // A real webfetch call in the same window proves the agent tried to fetch
    sessionStoreHelper.addWebfetchCall(sessionId, 'https://example.com/docs', NOW - 6000);

    const result = await cmdCapture(sessionId, BASE_OPTS);

    expect(result.new).toHaveLength(0);
    expect(result.new.some((f) => f.signal_type === 'suspect-fabrication')).toBe(false);
  });

  // ── Test 3 ──────────────────────────────────────────────────────────────
  test('agent NOT in fabricationAgents, URL in assistant text, zero fetches → NO finding (gated out)', async () => {
    const sessionId = 'sess-fab-wrong-agent';
    sessionStoreHelper.addSession(sessionId, 'developer', NOW - 10000);
    sessionStoreHelper.addAssistantTextPart(
      sessionId,
      'See https://example.com for details.',
      NOW - 5000,
    );

    const result = await cmdCapture(sessionId, {
      ...BASE_OPTS,
      // developer is not in the fabrication agents list
      fabricationAgents: ['web-researcher'],
    });

    expect(result.new).toHaveLength(0);
    expect(result.new.some((f) => f.signal_type === 'suspect-fabrication')).toBe(false);
  });

  // ── Test 4 ──────────────────────────────────────────────────────────────
  test('zero fetches, URL only in user prompt (not assistant text) → NO finding', async () => {
    const sessionId = 'sess-fab-user-url';
    sessionStoreHelper.addSession(sessionId, 'web-researcher', NOW - 10000);
    // User asks a question with a URL in the prompt
    sessionStoreHelper.addUserTextPart(
      sessionId,
      'Please research https://example.com/article for me.',
      NOW - 8000,
    );
    // Assistant replies with plain text, no URL, no sources marker
    sessionStoreHelper.addAssistantTextPart(
      sessionId,
      'The article discusses various topics in software engineering.',
      NOW - 5000,
    );

    const result = await cmdCapture(sessionId, BASE_OPTS);

    expect(result.new).toHaveLength(0);
    expect(result.new.some((f) => f.signal_type === 'suspect-fabrication')).toBe(false);
  });

  // ── Test 5 ──────────────────────────────────────────────────────────────
  test('recurrence: two sessions both fabricating → occurrence_count increments, one finding row', async () => {
    const sessionId1 = 'sess-fab-recur-1';
    const sessionId2 = 'sess-fab-recur-2';

    // Session 1: fabrication
    sessionStoreHelper.addSession(sessionId1, 'web-researcher', NOW - 10000);
    sessionStoreHelper.addAssistantTextPart(
      sessionId1,
      'According to https://example.com the answer is 42.',
      NOW - 5000,
    );

    const result1 = await cmdCapture(sessionId1, BASE_OPTS);
    expect(result1.new).toHaveLength(1);
    expect(result1.new[0].signal_type).toBe('suspect-fabrication');
    const findingId = result1.new[0].id;

    // Session 2: same pattern, different session
    sessionStoreHelper.addSession(sessionId2, 'web-researcher', NOW - 10000);
    sessionStoreHelper.addAssistantTextPart(
      sessionId2,
      'See https://other.example.org/ref for full details.',
      NOW - 5000,
    );

    const result2 = await cmdCapture(sessionId2, BASE_OPTS);

    // Same fingerprint (stable descriptor) → not new, but occurrence_count++
    expect(result2.new).toHaveLength(0);

    // The finding row still exists with occurrence_count === 2
    const row = currentLedger
      .prepare('SELECT occurrence_count FROM findings WHERE id = ?')
      .get(findingId);
    expect(Number(row.occurrence_count)).toBe(2);

    // Both sessions linked to the one finding
    const sessions = currentLedger
      .prepare('SELECT session_id FROM finding_sessions WHERE finding_id = ?')
      .all(findingId);
    const sessionIds = sessions.map((r) => r.session_id);
    expect(sessionIds).toContain(sessionId1);
    expect(sessionIds).toContain(sessionId2);
    expect(sessions).toHaveLength(2);
  });

  // ── Test 6 ──────────────────────────────────────────────────────────────
  test('assistant text has ### Sources marker (no raw URL), zero fetches → finding emitted', async () => {
    const sessionId = 'sess-fab-sources-heading';
    sessionStoreHelper.addSession(sessionId, 'web-researcher', NOW - 10000);
    sessionStoreHelper.addAssistantTextPart(
      sessionId,
      '## Summary\nThe answer is yes.\n\n### Sources\n- Wikipedia article on topic\n- Journal paper 2024',
      NOW - 5000,
    );

    const result = await cmdCapture(sessionId, BASE_OPTS);

    expect(result.new).toHaveLength(1);
    expect(result.new[0].signal_type).toBe('suspect-fabrication');
  });

  // ── Additional coverage ──────────────────────────────────────────────────
  test('| URL | table marker (no raw URL, no ### Sources) → finding emitted', async () => {
    const sessionId = 'sess-fab-url-table';
    sessionStoreHelper.addSession(sessionId, 'web-researcher', NOW - 10000);
    sessionStoreHelper.addAssistantTextPart(
      sessionId,
      '| URL | Title | Description |\n|---|---|---|\n| (none found) | - | - |',
      NOW - 5000,
    );

    const result = await cmdCapture(sessionId, BASE_OPTS);

    expect(result.new).toHaveLength(1);
    expect(result.new[0].signal_type).toBe('suspect-fabrication');
  });

  test('fabricationAgents list is empty → no suspect-fabrication checked for any agent', async () => {
    const sessionId = 'sess-fab-empty-list';
    sessionStoreHelper.addSession(sessionId, 'web-researcher', NOW - 10000);
    sessionStoreHelper.addAssistantTextPart(
      sessionId,
      'See https://example.com for details.',
      NOW - 5000,
    );

    const result = await cmdCapture(sessionId, {
      ...BASE_OPTS,
      fabricationAgents: [],
    });

    expect(result.new).toHaveLength(0);
  });

  test('fabricationAgents omitted (undefined) → no crash, no finding', async () => {
    const sessionId = 'sess-fab-undefined-list';
    sessionStoreHelper.addSession(sessionId, 'web-researcher', NOW - 10000);
    sessionStoreHelper.addAssistantTextPart(
      sessionId,
      'See https://example.com for details.',
      NOW - 5000,
    );

    const { fabricationAgents: _removed, ...optsWithout } = BASE_OPTS;
    const result = await cmdCapture(sessionId, optsWithout);

    expect(result.new).toHaveLength(0);
  });

  test('description string matches the expected shape', async () => {
    const sessionId = 'sess-fab-desc';
    sessionStoreHelper.addSession(sessionId, 'web-researcher', NOW - 10000);
    sessionStoreHelper.addAssistantTextPart(
      sessionId,
      'According to https://example.com the facts are clear.',
      NOW - 5000,
    );

    const result = await cmdCapture(sessionId, BASE_OPTS);

    expect(result.new).toHaveLength(1);
    expect(result.new[0].description).toBe(
      'suspect-fabrication [webfetch] @web-researcher: answer cited sources with zero webfetch calls this session',
    );
  });

  test('webfetch call with error status still prevents fabrication signal (counts as attempted fetch)', async () => {
    const sessionId = 'sess-fab-failed-fetch';
    sessionStoreHelper.addSession(sessionId, 'web-researcher', NOW - 10000);
    sessionStoreHelper.addAssistantTextPart(
      sessionId,
      'According to https://example.com the answer is clear.',
      NOW - 5000,
    );
    // An errored webfetch call — still proves the agent tried (status='error' but tool='webfetch')
    sessionStoreHelper.addPart(
      sessionId,
      {
        type: 'tool',
        tool: 'webfetch',
        state: { status: 'error', error: 'timeout', input: { url: 'https://example.com' } },
      },
      NOW - 6000,
    );

    const result = await cmdCapture(sessionId, BASE_OPTS);

    // The errored webfetch creates a tool-error finding, but NOT a suspect-fabrication finding
    expect(result.new.some((f) => f.signal_type === 'suspect-fabrication')).toBe(false);
  });

  test('at most ONE finding per capture pass even with multiple sourced text parts', async () => {
    const sessionId = 'sess-fab-multi-text';
    sessionStoreHelper.addSession(sessionId, 'web-researcher', NOW - 10000);
    // Two separate assistant text parts both containing URLs
    sessionStoreHelper.addAssistantTextPart(
      sessionId,
      'See https://example.com/page1 for reference.',
      NOW - 6000,
    );
    sessionStoreHelper.addAssistantTextPart(
      sessionId,
      'Also see https://example.com/page2 for more details.',
      NOW - 5000,
    );

    const result = await cmdCapture(sessionId, BASE_OPTS);

    // Must emit exactly ONE finding, not two
    expect(result.new).toHaveLength(1);
    expect(result.new[0].signal_type).toBe('suspect-fabrication');
  });

  // ── Boundary: NULL message_id ────────────────────────────────────────────
  // Documents the known, intentional JOIN exclusion boundary: a text part with
  // no message_id (or whose message_id has no matching message row) is silently
  // dropped by the INNER JOIN in extractAssistantTextParts. This is the correct
  // behaviour given the opencode schema guarantee. If a future query change
  // converts the JOIN to a LEFT JOIN (or removes it), this test will fail and
  // alert the author to re-examine the role-filter logic.
  test('text part with NULL message_id is excluded by JOIN → NO finding', async () => {
    const sessionId = 'sess-fab-null-msgid';
    sessionStoreHelper.addSession(sessionId, 'web-researcher', NOW - 10000);
    // Insert a raw part with no message_id — simulates orphaned / legacy row.
    // addPart() does not set message_id, so the column is NULL.
    sessionStoreHelper.addPart(
      sessionId,
      { type: 'text', text: 'According to https://example.com the answer is yes.' },
      NOW - 5000,
    );

    const result = await cmdCapture(sessionId, BASE_OPTS);

    // The INNER JOIN drops the orphan part → no sourced text found → no finding.
    expect(result.new).toHaveLength(0);
    expect(result.new.some((f) => f.signal_type === 'suspect-fabrication')).toBe(false);
  });

  // ── Boundary: exclusive lower-bound watermark ────────────────────────────
  // Verifies that a part with time_created === wmPartMs is NOT captured
  // (the window is `time_created > wmPartMs`, i.e. exclusive lower bound).
  test('sourced assistant text part exactly at watermark lower bound → NO finding', async () => {
    const sessionId = 'sess-fab-wm-boundary';
    const WM = 500000; // arbitrary watermark value

    sessionStoreHelper.addSession(sessionId, 'web-researcher', WM - 10000);

    // Pre-seed the watermark so wmPartMs === WM when cmdCapture reads it.
    // advanceWatermark writes `last_part_ms = upper` and `last_capture_ms = now`.
    // We call it directly on the ledger before the capture call.
    // captureMinIntervalMs=0 so the throttle gate is never active.
    const { advanceWatermark } = await import('../src/lib/watermark.js');
    advanceWatermark(currentLedger, sessionId, WM, WM - 1);

    // Part AT the watermark boundary (time_created === WM → excluded by >).
    sessionStoreHelper.addAssistantTextPart(
      sessionId,
      'According to https://example.com the answer is yes.',
      WM, // exactly at the lower bound — must be excluded
    );

    const result = await cmdCapture(sessionId, BASE_OPTS);

    expect(result.new).toHaveLength(0);
    expect(result.new.some((f) => f.signal_type === 'suspect-fabrication')).toBe(false);
  });
});
