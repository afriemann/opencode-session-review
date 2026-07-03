// src/plugin.js — Phase 1 of the per-session review pipeline.
//
// On every `session.idle` event, run the deterministic capture script against
// the just-finished session to accumulate recurring-failure signals in the
// local findings ledger. A session that goes idle, is resumed, and goes idle
// again is re-captured on each idle; the capture script's per-session watermark
// and throttle make re-capture correct (resumed-portion signals are captured,
// already-counted signals are not double-counted). When the script reports
// genuinely new findings AND there are existing open findings to compare
// against, run an inline model call to decide whether any new finding is a
// semantic duplicate of an existing one, then merge duplicates via the script.
//
// Safety properties:
//   * Report-only: this plugin never edits agent/skill definitions or files.
//     It only writes to the local findings ledger (via the capture script).
//   * Recursion guard (two layers):
//       Layer 1 (in-memory Set, fast path): dedup session IDs tracked in
//         `dedupSessions`; event handler skips them immediately.
//       Layer 2 (title-marker, durable): capture script skips sessions whose
//         title is "session-finding dedup", covering the edge case where the
//         plugin process restarts after creating the dedup session but before
//         its idle event.
//     `agent-engineer` remains excluded by name in the capture script.
//   * No double-count on re-capture: correctness is enforced by the capture
//     script (watermark + throttle), not by suppressing repeat idle events.
//   * Fail-safe: every step is wrapped so a failure degrades to "no capture"
//     for that session and never throws into opencode.
//
// The capture script is the SOLE writer of the ledger; this plugin only
// orchestrates and requests merges.
//
// Inline dedup model call:
//   Instructions: src/prompts/deduper.md (loaded at startup, body.system).
//   Model:        DEDUP_MODEL env var (default github-copilot/gpt-5-mini).
//   Format:       json_schema (Appendix B schema) with retryCount 2.
//                 If the provider does not honour json_schema, the reply may
//                 contain prose; parseDedupReply() extracts the array anyway.
//   Parts:        data-only NEW + EXISTING arrays from buildDedupPrompt().

import { readFileSync } from 'node:fs';
import { buildDedupPrompt, parseDedupReply } from './lib/dedup-prompt.js';

// Resolve src/capture.js and src/prompts/deduper.md relative to this file.
const SCRIPT = new URL('./capture.js', import.meta.url).pathname;
const DEDUP_PROMPT_PATH = new URL('./prompts/deduper.md', import.meta.url).pathname;

// Model for the inline dedup call. Format: "providerID/modelID".
// Default preserves the formerly-used github-copilot/gpt-5-mini binding.
const DEDUP_MODEL = process.env.DEDUP_MODEL || 'github-copilot/gpt-5-mini';

// Cheaply skip excluded agents before spending a subprocess; the script
// re-checks authoritatively against the session store.
const EXCLUDED_AGENTS = new Set(['agent-engineer']);

// Session titles that identify ephemeral sub-sessions from other plugins.
// These sessions run as the default agent (no named agent field), so
// EXCLUDED_AGENTS cannot catch them — a title check is the only option.
// The layer-2 capture-script guard (SKIP_TITLES in src/capture.js) must
// list these same titles for defence-in-depth.
//
//   'session-finding dedup'  = this plugin's own dedup sub-sessions.
//                              Primarily caught by dedupSessions Set (layer 1),
//                              but defence-in-depth via title check too.
//   'agent-memory distil'    = opencode-agent-memory ephemeral distil sessions.
//                              Must match EPHEMERAL_TITLE in that plugin's
//                              src/plugin.js.
const SKIP_TITLES_FAST = new Set(['session-finding dedup', 'agent-memory distil']);

// Upper bound on the in-flight session set. At this many distinct sessions
// queued at once, a further idle is dropped (and re-fires on the session's next
// idle) rather than evicting an active marker. Entries clear as each capture
// settles, so under normal operation this cap is never approached.
const MAX_IN_FLIGHT = 5000;

// Verdict JSON schema for body.format (Appendix B of inline-deduper-spec.md).
// Passed to the model as a json_schema format constraint.
//
// Structured-output support confirmation (github-copilot/gpt-5-mini):
//   The @opencode-ai/sdk type definitions confirm that format: json_schema is
//   accepted at the API level (OutputFormatJsonSchema in SessionPromptData.body).
//   Whether github-copilot/gpt-5-mini honours it at runtime could not be
//   confirmed without a live test. The implementation always sends json_schema;
//   if the provider returns prose instead, parseDedupReply() tolerates it and
//   extracts the array.  If the provider returns an error, runDedup() catches it
//   and degrades to "no merge" (fail-safe).
const VERDICT_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      new_id:       { type: 'integer' },
      duplicate_of: { type: ['integer', 'null'] },
    },
    required: ['new_id', 'duplicate_of'],
    additionalProperties: false,
  },
};

// Load the dedup system prompt once at startup (synchronous — small config file).
// If the file is missing or unreadable, log a warning and degrade gracefully:
// the dedup step is skipped when systemPrompt is null.
let systemPrompt = null;
try {
  systemPrompt = readFileSync(DEDUP_PROMPT_PATH, 'utf8');
} catch (err) {
  console.error(`[session-review-capture] could not load dedup prompt: ${err}`);
}

// Parse "providerID/modelID" from a combined model string.
// Falls back gracefully if the string is missing or has no slash.
function parseModel(modelStr) {
  if (!modelStr || typeof modelStr !== 'string') return null;
  const slash = modelStr.indexOf('/');
  if (slash <= 0 || slash === modelStr.length - 1) return null;
  return {
    providerID: modelStr.slice(0, slash),
    modelID:    modelStr.slice(slash + 1),
  };
}

export const SessionReviewCapture = async ({ client, $ }) => {
  // In-flight guard: a session is added here when its capture is queued and
  // removed when that capture finishes. This collapses duplicate idle events
  // that arrive while a capture for the SAME session is still pending/running,
  // so they do not spawn redundant subprocesses. It deliberately does NOT
  // suppress a LATER idle for the same session: a session that goes idle, is
  // resumed, and goes idle again is re-captured. Re-capture is made correct
  // (no double-counting, resumed-portion signals captured) by the capture
  // script's per-session watermark + throttle, not by this guard.
  const inFlight = new Set();

  // Recursion guard layer 1 (in-memory, fast path): IDs of ephemeral dedup
  // sessions spawned by this plugin. These are skipped in the event handler
  // so the plugin never captures its own dedup sub-sessions. IDs accumulate
  // for the process lifetime (bounded by the number of captures; negligible).
  const dedupSessions = new Set();

  // Serialise all capture work into a single chain. Concurrent session.idle
  // events would otherwise run overlapping captures whose open_others snapshots
  // are stale relative to each other; chaining keeps each capture+dedup atomic
  // with respect to the others.
  let queue = Promise.resolve();

  const log = (msg, err) =>
    console.error(`[session-review-capture] ${msg}${err ? `: ${err}` : ''}`);

  const handle = async (sessionID) => {
    // Cheap pre-guard: skip excluded agents and known ephemeral sub-sessions
    // before spending a subprocess.
    try {
      const got = await client.session.get({ sessionID });
      const agent = got && got.data && got.data.agent;
      if (agent && EXCLUDED_AGENTS.has(agent)) return;
      // Skip ephemeral sub-sessions identified by title. These sessions run as
      // the default agent (no `agent` field), so EXCLUDED_AGENTS cannot catch
      // them. On API failure the try/catch falls through, and the authoritative
      // layer-2 title guard in the capture script provides the safety net.
      const title = got && got.data && got.data.title;
      if (title && SKIP_TITLES_FAST.has(title)) return;
    } catch {
      // Non-fatal: fall through to the script, which guards authoritatively
      // against excluded named agents. Title-based exclusions (e.g.,
      // agent-memory distil sessions) only fire on the happy path above.
    }

    // 1. Deterministic capture (free, no LLM).
    let captureOut;
    try {
      captureOut = await $`node ${SCRIPT} capture ${sessionID}`.quiet().text();
    } catch (err) {
      log(`capture failed for ${sessionID}`, err);
      return;
    }

    let result;
    try {
      result = JSON.parse(captureOut.trim());
    } catch (err) {
      log(`unparseable capture output for ${sessionID}`, err);
      return;
    }

    const fresh = Array.isArray(result.new) ? result.new : [];
    const others = Array.isArray(result.open_others) ? result.open_others : [];
    // Nothing new, or nothing to compare against -> deterministic result
    // already persisted; no LLM needed.
    if (fresh.length === 0 || others.length === 0) return;

    // 2. Semantic dedup via inline model call.
    let decisions;
    try {
      decisions = await runDedup(client, fresh, others, log, dedupSessions);
    } catch (err) {
      log('dedup step failed', err);
      return; // ledger is already consistent; skip merging.
    }
    if (!Array.isArray(decisions)) return;

    // 3. Merge confirmed duplicates (script is the sole writer).
    for (const d of decisions) {
      const newId = Number(d && d.new_id);
      const into = Number(d && d.duplicate_of);
      // duplicate_of: null coerces to 0, which is a valid integer; require a
      // positive row id on both sides so "not a duplicate" never triggers a
      // bogus `merge X 0`.
      if (!Number.isInteger(newId) || newId <= 0) continue;
      if (!Number.isInteger(into) || into <= 0) continue;
      if (newId === into) continue;
      try {
        await $`node ${SCRIPT} merge ${String(newId)} ${String(into)}`.quiet();
      } catch (err) {
        log(`merge ${newId}->${into} failed`, err);
      }
    }
  };

  return {
    event: async ({ event }) => {
      if (!event || event.type !== 'session.idle') return;
      const sessionID = event.properties && event.properties.sessionID;
      // Layer 1 recursion guard: skip dedup sessions spawned by this plugin.
      // Skip also if a capture for THIS session is already queued/running.
      if (!sessionID || inFlight.has(sessionID) || dedupSessions.has(sessionID)) return;
      // Saturation safety: if too many distinct sessions are already queued,
      // drop THIS idle rather than evicting an in-flight marker.
      if (inFlight.size >= MAX_IN_FLIGHT) {
        log(`in-flight cap reached (${MAX_IN_FLIGHT}); deferring idle for ${sessionID}`);
        return;
      }
      inFlight.add(sessionID);

      // Chain onto the queue so captures never overlap.
      const mine = (queue = queue
        .then(() => handle(sessionID))
        .catch((err) => {
          log(`unhandled error for ${sessionID}`, err);
        })
        .finally(() => {
          inFlight.delete(sessionID);
        }));
      await mine;
    },
  };
};

// Spawn a short-lived dedup session, send an inline model call with the
// system prompt and data-only parts, and return the parsed verdict array.
async function runDedup(client, fresh, others, log, dedupSessions) {
  // Dedup prompt must be loaded before we can proceed.
  if (!systemPrompt) {
    log('dedup system prompt not loaded; skipping dedup');
    return [];
  }

  const created = await client.session.create({ title: 'session-finding dedup' });
  const dedupSessionID = created && created.data && created.data.id;
  if (!dedupSessionID) {
    log('could not create dedup session');
    return [];
  }

  // Register the dedup session ID immediately (layer 1 recursion guard).
  dedupSessions.add(dedupSessionID);

  try {
    const model = parseModel(DEDUP_MODEL);

    const res = await client.session.prompt({
      sessionID: dedupSessionID,
      system:    systemPrompt,
      ...(model ? { model } : {}),
      format:    { type: 'json_schema', schema: VERDICT_SCHEMA, retryCount: 2 },
      parts:     [{ type: 'text', text: buildDedupPrompt(fresh, others) }],
    });

    const parts = (res && res.data && res.data.parts) || [];
    const text = parts
      .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text)
      .join('\n');

    // Try direct JSON.parse first (structured-output happy path), then fall
    // back to parseDedupReply for text-mode or prose-wrapped responses.
    let parsed;
    try {
      parsed = JSON.parse(text.trim());
      if (!Array.isArray(parsed)) throw new Error('not an array');
    } catch {
      parsed = parseDedupReply(text);
    }
    return parsed;
  } finally {
    // Optional cleanup: delete the ephemeral session to reduce clutter.
    // This is a nicety and is NOT relied on as a recursion guard (it races
    // the idle event). Errors are swallowed — cleanup failure is non-fatal.
    //
    // session.idle for ephemeral sessions: it is unknown whether a session
    // created via session.create + session.prompt emits session.idle. The
    // in-memory dedupSessions set (layer 1) and the title-marker skip in the
    // capture script (layer 2) guard against it regardless.
    try {
      await client.session.delete({ sessionID: dedupSessionID });
    } catch {
      // Non-fatal: deletion is best-effort cleanup only.
    }
  }
}

export default SessionReviewCapture;
