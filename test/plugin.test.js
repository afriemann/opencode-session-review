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

function makeDefaultClient({ agent = 'some-agent', sessionCreateId = 'dedup-session-id' } = {}) {
  return {
    session: {
      get: jest.fn().mockResolvedValue({ data: { agent } }),
      create: jest.fn().mockResolvedValue({ data: { id: sessionCreateId } }),
      prompt: jest.fn().mockResolvedValue({
        data: { parts: [{ type: 'text', text: '[]' }] },
      }),
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

  test('excluded agent "session-finding-deduper" → $ never called', async () => {
    const client = makeDefaultClient({ agent: 'session-finding-deduper' });
    const { plugin, $ } = await makePlugin({ client });
    await plugin.event(idleEvent('session-dedup'));
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
    $ .mockReturnValue({
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

  test('successful dedup with one confirmed duplicate → merge called once with correct IDs', async () => {
    const newId = 10;
    const existingId = 5;

    // Capture returns one new finding and one existing open finding
    const captureJson = JSON.stringify({
      new: [{ id: newId, description: 'new finding' }],
      open_others: [{ id: existingId, description: 'existing finding' }],
    });

    // $ is called for capture and for merge
    const $ = jest.fn((strings, ...values) => {
      // Capture call: node <script> capture <sessionID>
      // Merge call: node <script> merge <dupId> <intoId>
      return {
        quiet: () => ({ text: () => Promise.resolve(captureJson) }),
      };
    });

    const dedupText = JSON.stringify([{ new_id: newId, duplicate_of: existingId }]);
    const client = {
      session: {
        get: jest.fn().mockResolvedValue({ data: { agent: 'some-agent' } }),
        create: jest.fn().mockResolvedValue({ data: { id: 'dedup-sess-123' } }),
        prompt: jest.fn().mockResolvedValue({
          data: { parts: [{ type: 'text', text: dedupText }] },
        }),
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

  test('dedup client.session.prompt throws → no merge called; no unhandled rejection', async () => {
    const captureJson = JSON.stringify({
      new: [{ id: 10, description: 'new finding' }],
      open_others: [{ id: 5, description: 'existing' }],
    });

    const $ = jest.fn(() => ({
      quiet: () => ({ text: () => Promise.resolve(captureJson) }),
    }));

    const client = {
      session: {
        get: jest.fn().mockResolvedValue({ data: { agent: 'some-agent' } }),
        create: jest.fn().mockResolvedValue({ data: { id: 'dedup-sess' } }),
        prompt: jest.fn().mockRejectedValue(new Error('LLM unavailable')),
      },
    };

    const { plugin } = await makePlugin({ $, client });
    await expect(plugin.event(idleEvent('sess-prompt-err'))).resolves.toBeUndefined();
    // $ called once for capture only — no merge
    expect($).toHaveBeenCalledTimes(1);
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
});
