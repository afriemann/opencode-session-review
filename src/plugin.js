// src/plugin.js — Phase 1 of the per-session review pipeline.
//
// On every `session.idle` event, run the deterministic capture script against
// the just-finished session to accumulate recurring-failure signals in the
// local findings ledger. A session that goes idle, is resumed, and goes idle
// again is re-captured on each idle; the capture script's per-session watermark
// and throttle make re-capture correct (resumed-portion signals are captured,
// already-counted signals are not double-counted). When the script reports
// genuinely new findings AND there are existing open findings to compare
// against, ask the cheap `session-finding-deduper` agent whether any new
// finding is a semantic duplicate of an existing one, then merge duplicates via
// the script.
//
// Safety properties:
//   * Report-only: this plugin never edits agent/skill definitions or files.
//     It only writes to the local findings ledger (via the capture script).
//   * Recursion guard: excluded-agent sessions (agent-engineer, the deduper
//     itself) are skipped — first cheaply here, and authoritatively by the
//     script, which returns {"new":[]} for them so no dedup session spawns.
//   * No double-count on re-capture: correctness is enforced by the capture
//     script (watermark + throttle), not by suppressing repeat idle events. The
//     in-flight guard below only collapses duplicate idles for a session whose
//     capture has not yet finished; it never blocks a later, post-completion idle.
//   * Fail-safe: every step is wrapped so a failure degrades to "no capture"
//     for that session and never throws into opencode.
//
// The capture script is the SOLE writer of the ledger; this plugin only
// orchestrates and requests merges.

import { buildDedupPrompt, parseDedupReply } from './lib/dedup-prompt.js';

// Resolve src/capture.js relative to this file (src/plugin.js → src/capture.js).
const SCRIPT = new URL('./capture.js', import.meta.url).pathname;
const DEDUP_AGENT = "session-finding-deduper";
// Cheaply skip excluded agents before spending a subprocess; the script
// re-checks authoritatively against the session store.
const EXCLUDED_AGENTS = new Set(["agent-engineer", DEDUP_AGENT]);
// Upper bound on the in-flight session set. At this many distinct sessions
// queued at once, a further idle is dropped (and re-fires on the session's next
// idle) rather than evicting an active marker. Entries clear as each capture
// settles, so under normal operation this cap is never approached.
const MAX_IN_FLIGHT = 5000;

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
  // Serialise all capture work into a single chain. Concurrent session.idle
  // events would otherwise run overlapping captures whose open_others snapshots
  // are stale relative to each other; chaining keeps each capture+dedup atomic
  // with respect to the others.
  let queue = Promise.resolve();

  const log = (msg, err) =>
    console.error(`[session-review-capture] ${msg}${err ? `: ${err}` : ""}`);

  const handle = async (sessionID) => {
    // Cheap pre-guard: skip excluded agents without spawning a subprocess.
    try {
      const got = await client.session.get({ path: { id: sessionID } });
      const agent = got && got.data && got.data.agent;
      if (agent && EXCLUDED_AGENTS.has(agent)) return;
    } catch {
      // Non-fatal: fall through to the script, which guards authoritatively.
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

    // 2. Semantic dedup via the cheap agent.
    let decisions;
    try {
      decisions = await runDedup(client, fresh, others, log);
    } catch (err) {
      log("dedup agent step failed", err);
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
      if (!event || event.type !== "session.idle") return;
      const sessionID = event.properties && event.properties.sessionID;
      // Skip only if a capture for THIS session is already queued/running;
      // a fresh idle after the prior capture completed is allowed to re-fire.
      if (!sessionID || inFlight.has(sessionID)) return;
      // Saturation safety: if too many distinct sessions are already queued,
      // drop THIS idle rather than evicting an in-flight marker. Evicting an
      // active marker would let a duplicate idle for that session re-enqueue a
      // second capture and could flap the guard when the original settled.
      // Dropping the new idle loses nothing: the capture script's watermark
      // means the next idle for this session re-captures everything past it.
      // Entries clear as captures settle, so this is a rare backpressure cap.
      if (inFlight.size >= MAX_IN_FLIGHT) {
        log(`in-flight cap reached (${MAX_IN_FLIGHT}); deferring idle for ${sessionID}`);
        return;
      }
      inFlight.add(sessionID);

      // Chain onto the queue so captures never overlap. The .catch keeps one
      // failure from breaking the chain for later sessions; the .finally always
      // clears the in-flight marker (so a later idle can re-fire) and must stay
      // AFTER .catch so the settled promise never rejects into `await mine`.
      // Await only THIS session's link (`mine`), not the whole chain tail, so a
      // burst of idle sessions does not make each handler block on every other
      // session's capture + dedup round-trip.
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

// Spawn a short-lived deduper session, ask for a JSON verdict, and parse it.
async function runDedup(client, fresh, others, log) {
  const prompt = buildDedupPrompt(fresh, others);

  const created = await client.session.create({
    body: { title: "session-finding dedup" },
  });
  const dedupSessionID = created && created.data && created.data.id;
  if (!dedupSessionID) {
    log("could not create dedup session");
    return [];
  }

  const res = await client.session.prompt({
    path: { id: dedupSessionID },
    body: {
      agent: DEDUP_AGENT,
      parts: [{ type: "text", text: prompt }],
    },
  });

  const parts = (res && res.data && res.data.parts) || [];
  const text = parts
    .filter((p) => p && p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n");

  return parseDedupReply(text);
}

export default SessionReviewCapture;
