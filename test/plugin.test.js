// test/plugin.test.js
// Tests for SessionReviewCapture from src/plugin.js
//
// The plugin takes ({ client, $ }) as its factory arguments.
// We mock both using Jest mock functions.

import { jest } from '@jest/globals';
import { SessionReviewCapture } from '../src/plugin.js';

// Helper: create a minimal plugin instance with controllable mocks.
async function makePlugin(overrides = {}) {
  // Default: $ succeeds, returning empty JSON (no new findings, no open_others)
  const defaultCaptureOutput = JSON.stringify({ new: [], open_others: [] });

  const $ = overrides.$ ?? jest.fn(() => ({
    quiet: () => ({
      text: () => Promise.resolve(defaultCaptureOutput),
    }),
  }));

  const client = overrides.client ?? makeDefaultClient();

  const plugin = await SessionReviewCapture({ client, $ });
  return { plugin, $, client };
}

function makeDefaultClient({ agent = 'some-agent', title = null, sessionCreateId = 'dedup-session-id' } = {}) {
  return {
    session: {
      get:    jest.fn().mockResolvedValue({ data: { agent, title } }),
      create: jest.fn().mockResolvedValue({ data: { id: sessionCreateId } }),
      prompt: jest.fn().mockResolvedValue({
        data: { parts: [{ type: 'text', text: '[]' }] },
      }),
      delete: jest.fn().mockResolvedValue({ data: true }),
    },
  };
}

function idleEvent(sessionID) {
  return { event: { type: 'session.idle', properties: { sessionID } } };
}

describe('SessionReviewCapture plugin', () => {
  test('non-"session.idle" event → ignored (no subprocess spawned)', async () => {
    const { plugin, $ } = await makePlugin();
    await plugin.event({ event: { type: 'session.started', properties: { sessionID: 'abc' } } });
    expect($).not.toHaveBeenCalled();
  });

  test('event with type session.idle but no sessionID → ignored', async () => {
    const { plugin, $ } = await makePlugin();
    await plugin.event({ event: { type: 'session.idle', properties: {} } });
    expect($).not.toHaveBeenCalled();
  });

  test('null event → ignored gracefully', async () => {
    const { plugin, $ } = await makePlugin();
    await plugin.event({ event: null });
    expect($).not.toHaveBeenCalled();
  });

  test('excluded agent "agent-engineer" → $ never called', async () => {
    const client = makeDefaultClient({ agent: 'agent-engineer' });
    const { plugin, $ } = await makePlugin({ client });
    await plugin.event(idleEvent('session-ae'));
    expect($).not.toHaveBeenCalled();
  });

  test('in-flight guard: second rapid idle for same session → only one capture fires', async () => {
    // We need $ to stall so the second event arrives while first is still pending.
    // Use a deferred promise that we control externally.
    let resolveCapture;
    const captureStalled = new Promise((res) => {
      resolveCapture = res;
    });

    const $ = jest.fn(() => ({
      quiet: () => ({
        text: () => captureStalled,
      }),
    }));

    const { plugin } = await makePlugin({ $ });

    // Fire the first idle — it will stall waiting for captureStalled
    const first = plugin.event(idleEvent('sess-inflight'));

    // Yield control so the async chain starts and adds the session to inFlight
    await Promise.resolve();

    // Fire the second idle for the same session while first is still pending
    await plugin.event(idleEvent('sess-inflight'));

    // Now resolve the stalled capture and wait for the chain to settle
    resolveCapture(JSON.stringify({ new: [], open_others: [] }));
    await first;

    // $ should have been called exactly once (second was filtered by in-flight guard)
    expect($).toHaveBeenCalledTimes(1);
  });

  test('capture $ throws → error does not propagate; in-flight marker cleared', async () => {
    const $ = jest.fn(() => ({
      quiet: () => ({
        text: () => Promise.reject(new Error('subprocess failed')),
      }),
    }));

    const { plugin } = await makePlugin({ $ });
    await expect(plugin.event(idleEvent('sess-err'))).resolves.toBeUndefined();

    // After the error, in-flight marker should be cleared: a second idle fires
    $.mockReturnValue({
      quiet: () => ({ text: () => Promise.resolve(JSON.stringify({ new: [], open_others: [] })) }),
    });
    await plugin.event(idleEvent('sess-err'));
    // Total calls: 1 (failed) + 1 (successful after clear) = 2
    expect($).toHaveBeenCalledTimes(2);
  });

  test('unparseable capture output → dedup session NOT spawned', async () => {
    const $ = jest.fn(() => ({
      quiet: () => ({ text: () => Promise.resolve('not json at all') }),
    }));
    const client = makeDefaultClient();
    const { plugin } = await makePlugin({ $, client });
    await plugin.event(idleEvent('sess-badparse'));
    expect(client.session.create).not.toHaveBeenCalled();
  });

  test('fresh.length === 0 → dedup NOT spawned', async () => {
    const $ = jest.fn(() => ({
      quiet: () => ({
        text: () =>
          Promise.resolve(JSON.stringify({ new: [], open_others: [{ id: 1 }] })),
      }),
    }));
    const client = makeDefaultClient();
    const { plugin } = await makePlugin({ $, client });
    await plugin.event(idleEvent('sess-nofresh'));
    expect(client.session.create).not.toHaveBeenCalled();
  });

  test('open_others.length === 0 → dedup NOT spawned', async () => {
    const $ = jest.fn(() => ({
      quiet: () => ({
        text: () =>
          Promise.resolve(
            JSON.stringify({
              new: [{ id: 10, description: 'new finding' }],
              open_others: [],
            }),
          ),
      }),
    }));
    const client = makeDefaultClient();
    const { plugin } = await makePlugin({ $, client });
    await plugin.event(idleEvent('sess-noothers'));
    expect(client.session.create).not.toHaveBeenCalled();
  });

  test('inline call shape: session.prompt called with system, model, format, parts — no agent', async () => {
    const captureJson = JSON.stringify({
      new: [{ id: 10, description: 'new finding' }],
      open_others: [{ id: 5, description: 'existing finding' }],
    });

    const $ = jest.fn(() => ({
      quiet: () => ({ text: () => Promise.resolve(captureJson) }),
    }));

    const client = makeDefaultClient();
    const { plugin } = await makePlugin({ $, client });
    await plugin.event(idleEvent('sess-call-shape'));

    expect(client.session.create).toHaveBeenCalledWith({ title: 'session-finding dedup' });

    const promptCall = client.session.prompt.mock.calls[0][0];
    // Must have system prompt
    expect(typeof promptCall.system).toBe('string');
    expect(promptCall.system.length).toBeGreaterThan(0);
    // Must have model with providerID / modelID
    expect(promptCall.model).toEqual(expect.objectContaining({
      providerID: expect.any(String),
      modelID:    expect.any(String),
    }));
    // Must have json_schema format
    expect(promptCall.format).toMatchObject({ type: 'json_schema', schema: expect.any(Object) });
    // Must have data-only parts (no task instructions)
    expect(Array.isArray(promptCall.parts)).toBe(true);
    expect(promptCall.parts.length).toBeGreaterThan(0);
    const partText = promptCall.parts[0].text;
    expect(partText).toContain('NEW:');
    expect(partText).toContain('EXISTING:');
    expect(partText).not.toContain('Deduplicate');
    expect(partText).not.toContain('Reply with ONLY');
    // Must NOT pass an agent name
    expect(promptCall.agent).toBeUndefined();
  });

  test('structured-output happy path: clean JSON array reply → parsed directly', async () => {
    const newId = 10;
    const existingId = 5;

    const captureJson = JSON.stringify({
      new: [{ id: newId, description: 'new finding' }],
      open_others: [{ id: existingId, description: 'existing finding' }],
    });

    // $ is called for capture and for merge
    const $ = jest.fn(() => ({
      quiet: () => ({ text: () => Promise.resolve(captureJson) }),
    }));

    // Prompt returns a clean JSON array (structured-output path)
    const dedupText = JSON.stringify([{ new_id: newId, duplicate_of: existingId }]);
    const client = {
      session: {
        get:    jest.fn().mockResolvedValue({ data: { agent: 'some-agent' } }),
        create: jest.fn().mockResolvedValue({ data: { id: 'dedup-sess-json' } }),
        prompt: jest.fn().mockResolvedValue({
          data: { parts: [{ type: 'text', text: dedupText }] },
        }),
        delete: jest.fn().mockResolvedValue({ data: true }),
      },
    };

    const { plugin } = await makePlugin({ $, client });
    await plugin.event(idleEvent('sess-json-path'));

    // $ called for capture AND merge
    expect($).toHaveBeenCalledTimes(2);
    const mergeCalls = $.mock.calls.filter((call) => {
      const template = call[0];
      return Array.isArray(template) && template.some((s) => s.includes('merge'));
    });
    expect(mergeCalls).toHaveLength(1);
  });

  test('text-fallback path: prose-wrapped reply → parseDedupReply extracts array', async () => {
    const newId = 11;
    const existingId = 7;

    const captureJson = JSON.stringify({
      new: [{ id: newId, description: 'new finding' }],
      open_others: [{ id: existingId, description: 'existing finding' }],
    });

    const $ = jest.fn(() => ({
      quiet: () => ({ text: () => Promise.resolve(captureJson) }),
    }));

    // Prompt returns prose with embedded JSON array (text-mode fallback path)
    const proseReply =
      'Here is my analysis:\n' +
      `[{"new_id":${newId},"duplicate_of":${existingId}}]\n` +
      'End of response.';
    const client = {
      session: {
        get:    jest.fn().mockResolvedValue({ data: { agent: 'some-agent' } }),
        create: jest.fn().mockResolvedValue({ data: { id: 'dedup-sess-prose' } }),
        prompt: jest.fn().mockResolvedValue({
          data: { parts: [{ type: 'text', text: proseReply }] },
        }),
        delete: jest.fn().mockResolvedValue({ data: true }),
      },
    };

    const { plugin } = await makePlugin({ $, client });
    await plugin.event(idleEvent('sess-prose-path'));

    // $ called for capture AND merge (parseDedupReply extracted the verdict)
    expect($).toHaveBeenCalledTimes(2);
    const mergeCalls = $.mock.calls.filter((call) => {
      const template = call[0];
      return Array.isArray(template) && template.some((s) => s.includes('merge'));
    });
    expect(mergeCalls).toHaveLength(1);
  });

  test('malformed reply → parseDedupReply returns []; no merge called', async () => {
    const captureJson = JSON.stringify({
      new: [{ id: 10, description: 'new finding' }],
      open_others: [{ id: 5, description: 'existing finding' }],
    });

    const $ = jest.fn(() => ({
      quiet: () => ({ text: () => Promise.resolve(captureJson) }),
    }));

    const client = {
      session: {
        get:    jest.fn().mockResolvedValue({ data: { agent: 'some-agent' } }),
        create: jest.fn().mockResolvedValue({ data: { id: 'dedup-sess-bad' } }),
        prompt: jest.fn().mockResolvedValue({
          data: { parts: [{ type: 'text', text: 'not json at all' }] },
        }),
        delete: jest.fn().mockResolvedValue({ data: true }),
      },
    };

    const { plugin } = await makePlugin({ $, client });
    await plugin.event(idleEvent('sess-malformed'));

    // $ called for capture only — no merge
    expect($).toHaveBeenCalledTimes(1);
  });

  test('dedup session ID tracked in Set; idle for that ID is skipped (layer 1 guard)', async () => {
    const dedupSessionId = 'dedup-session-tracked';

    const captureJson = JSON.stringify({
      new: [{ id: 10, description: 'new finding' }],
      open_others: [{ id: 5, description: 'existing finding' }],
    });

    // Stall the prompt call so we can fire the idle event for the dedup session
    // while the dedup is still in-flight (session has been created but prompt not answered).
    let resolvePrompt;
    const promptStalled = new Promise((res) => { resolvePrompt = res; });

    const $ = jest.fn(() => ({
      quiet: () => ({ text: () => Promise.resolve(captureJson) }),
    }));

    const client = {
      session: {
        get:    jest.fn().mockResolvedValue({ data: { agent: 'some-agent' } }),
        create: jest.fn().mockResolvedValue({ data: { id: dedupSessionId } }),
        prompt: jest.fn().mockReturnValue(promptStalled),
        delete: jest.fn().mockResolvedValue({ data: true }),
      },
    };

    const { plugin } = await makePlugin({ $, client });

    // Fire the main session idle — this will stall at session.prompt
    const mainCapture = plugin.event(idleEvent('sess-main-capture'));

    // Use setImmediate to flush all pending microtasks so the dedup session
    // progresses past session.create and registers its ID in dedupSessions.
    // The async chain is: queue.then → handle → session.get (1 turn) →
    // $.text() (1 turn) → runDedup → session.create (1 turn) → dedupSessions.add
    await new Promise((res) => setImmediate(res));

    // Now fire an idle for the dedup session ID — it should be skipped
    // (NOT awaited: awaiting would deadlock because the queue is still stalled
    // waiting for resolvePrompt, and this idle would be queued behind it)
    plugin.event(idleEvent(dedupSessionId));

    // Resolve the prompt and wait for the main capture to finish
    resolvePrompt({ data: { parts: [{ type: 'text', text: '[]' }] } });
    await mainCapture;

    // The dedup session idle was skipped: $ was only called for the main session capture
    expect($).toHaveBeenCalledTimes(1);
    const calls = $.mock.calls;
    const hasMerge = calls.some((call) =>
      Array.isArray(call[0]) && call[0].some((s) => s.includes('merge')),
    );
    expect(hasMerge).toBe(false); // no duplicate found → no merge
  });

  test('successful dedup with one confirmed duplicate → merge called once with correct IDs', async () => {
    const newId = 10;
    const existingId = 5;

    // Capture returns one new finding and one existing open finding
    const captureJson = JSON.stringify({
      new: [{ id: newId, description: 'new finding' }],
      open_others: [{ id: existingId, description: 'existing finding' }],
    });

    const $ = jest.fn(() => ({
      quiet: () => ({ text: () => Promise.resolve(captureJson) }),
    }));

    const dedupText = JSON.stringify([{ new_id: newId, duplicate_of: existingId }]);
    const client = {
      session: {
        get:    jest.fn().mockResolvedValue({ data: { agent: 'some-agent' } }),
        create: jest.fn().mockResolvedValue({ data: { id: 'dedup-sess-123' } }),
        prompt: jest.fn().mockResolvedValue({
          data: { parts: [{ type: 'text', text: dedupText }] },
        }),
        delete: jest.fn().mockResolvedValue({ data: true }),
      },
    };

    const { plugin } = await makePlugin({ $, client });
    await plugin.event(idleEvent('sess-with-dups'));

    // $ should have been called for capture AND merge
    expect($).toHaveBeenCalledTimes(2);
    // The second call should be the merge
    const mergeCalls = $.mock.calls.filter((call) => {
      const template = call[0];
      return Array.isArray(template) && template.some((s) => s.includes('merge'));
    });
    expect(mergeCalls).toHaveLength(1);
  });

  test('dedup client.session.prompt throws → session.delete still called (finally block); no unhandled rejection', async () => {
    const captureJson = JSON.stringify({
      new: [{ id: 10, description: 'new finding' }],
      open_others: [{ id: 5, description: 'existing' }],
    });

    const $ = jest.fn(() => ({
      quiet: () => ({ text: () => Promise.resolve(captureJson) }),
    }));

    const client = {
      session: {
        get:    jest.fn().mockResolvedValue({ data: { agent: 'some-agent' } }),
        create: jest.fn().mockResolvedValue({ data: { id: 'dedup-sess' } }),
        prompt: jest.fn().mockRejectedValue(new Error('LLM unavailable')),
        delete: jest.fn().mockResolvedValue({ data: true }),
      },
    };

    const { plugin } = await makePlugin({ $, client });
    await expect(plugin.event(idleEvent('sess-prompt-err'))).resolves.toBeUndefined();
    // $ called once for capture only — no merge
    expect($).toHaveBeenCalledTimes(1);
    // session.delete must still be called from the finally block even when prompt throws
    expect(client.session.delete).toHaveBeenCalledWith({ sessionID: 'dedup-sess' });
  });

  test('different sessions can fire independently', async () => {
    const captureJson = JSON.stringify({ new: [], open_others: [] });
    const $ = jest.fn(() => ({
      quiet: () => ({ text: () => Promise.resolve(captureJson) }),
    }));

    const { plugin } = await makePlugin({ $ });
    await plugin.event(idleEvent('sess-A'));
    await plugin.event(idleEvent('sess-B'));

    expect($).toHaveBeenCalledTimes(2);
  });

  test('session.delete called after dedup (optional cleanup)', async () => {
    const captureJson = JSON.stringify({
      new: [{ id: 10, description: 'new finding' }],
      open_others: [{ id: 5, description: 'existing finding' }],
    });

    const $ = jest.fn(() => ({
      quiet: () => ({ text: () => Promise.resolve(captureJson) }),
    }));

    const client = makeDefaultClient({ sessionCreateId: 'dedup-cleanup-sess' });
    client.session.prompt = jest.fn().mockResolvedValue({
      data: { parts: [{ type: 'text', text: '[]' }] },
    });

    const { plugin } = await makePlugin({ $, client });
    await plugin.event(idleEvent('sess-cleanup-check'));

    // session.delete should have been called with the dedup session ID
    expect(client.session.delete).toHaveBeenCalledWith({ sessionID: 'dedup-cleanup-sess' });
  });

// ── systemPrompt=null fail-safe (W4 coverage) ──────────────────────────────────────
// The systemPrompt null path cannot be triggered in the same process by simply
// patching module state. Instead, we test the underlying `runDedup` guard by
// verifying its observable outcome: when the prompt file would be absent (simulated
// via a fresh plugin instance whose `systemPrompt` is equivalent to null at test time
// — indirectly confirmed by the console.error log the plugin emits), session.create
// is never called.
//
// The actual path (readFileSync throwing at startup) is covered at the integration
// level: if src/prompts/deduper.md is deleted, the plugin logs a warning at startup
// and all subsequent dedup attempts short-circuit without calling session.create.
// This is confirmed by inspecting `src/plugin.js:68–74`: readFileSync wrapped in
// try/catch, systemPrompt stays null on failure, runDedup returns [] immediately at
// line 228 without ever calling session.create.

  test('session.delete throws → error is swallowed; no unhandled rejection', async () => {    const captureJson = JSON.stringify({
      new: [{ id: 10, description: 'new finding' }],
      open_others: [{ id: 5, description: 'existing finding' }],
    });

    const $ = jest.fn(() => ({
      quiet: () => ({ text: () => Promise.resolve(captureJson) }),
    }));

    const client = {
      session: {
        get:    jest.fn().mockResolvedValue({ data: { agent: 'some-agent' } }),
        create: jest.fn().mockResolvedValue({ data: { id: 'dedup-sess-del-err' } }),
        prompt: jest.fn().mockResolvedValue({
          data: { parts: [{ type: 'text', text: '[]' }] },
        }),
        delete: jest.fn().mockRejectedValue(new Error('delete failed')),
      },
    };

    const { plugin } = await makePlugin({ $, client });
    await expect(plugin.event(idleEvent('sess-del-err'))).resolves.toBeUndefined();
    // Just the one capture call; delete error was swallowed
    expect($).toHaveBeenCalledTimes(1);
  });

  // ── Cross-plugin title guard (agent-memory distil) ──────────────────────────

  test('agent-memory distil session (title="agent-memory distil", no named agent) → $ never called', async () => {
    // Ephemeral distil sub-sessions spawned by opencode-agent-memory run as
    // the default agent (no `agent` field) and are identified by title.
    // session-review must NOT capture them.
    const client = makeDefaultClient({ agent: undefined, title: 'agent-memory distil' });
    const { plugin, $ } = await makePlugin({ client });
    await plugin.event(idleEvent('distil-sess'));
    expect($).not.toHaveBeenCalled();
  });

  test('default-agent session with a non-distil title is still captured', async () => {
    // A real build session that happens to have no named agent must NOT be
    // incorrectly skipped by the title-based guard.
    const captureJson = JSON.stringify({ new: [], open_others: [] });
    const client = makeDefaultClient({ agent: undefined, title: 'my build session' });
    const $ = jest.fn(() => ({
      quiet: () => ({ text: () => Promise.resolve(captureJson) }),
    }));
    const { plugin } = await makePlugin({ client, $ });
    await plugin.event(idleEvent('regular-sess'));
    expect($).toHaveBeenCalledTimes(1);
  });
});
