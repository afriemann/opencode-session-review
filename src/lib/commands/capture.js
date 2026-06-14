// src/lib/commands/capture.js — Main capture orchestrator.
//
// Ports cmd_capture() from session-finding-capture.sh. Orchestrates one full
// capture pass for a single session: reads watermark, checks throttle,
// extracts signals, applies gates, upserts, advances watermark, emits JSON.
//
// The JSON result { new: [...], open_others: [...] } (or with `skipped`) is
// parsed by the plugin to decide whether to run the dedup agent.

import { openDatabases } from '../db.js';
import { ensureSchema } from '../schema.js';
import { normalise, classifySeverity, fingerprintOf } from '../normalise.js';
import { filterApprovalToil } from '../approval-filter.js';
import { readWatermark, advanceWatermark } from '../watermark.js';
import { upsertSignal } from '../upsert.js';
import {
  extractToolErrors,
  extractPermissionRejects,
  extractBashCommands,
  getSessionAgent,
} from '../signals.js';
import { agentBashRules } from '../config-rules.js';

/**
 * Run one capture pass for a session.
 *
 * @param {string} sessionId
 * @param {object} opts
 * @param {string}   opts.openCodeDb            - path to opencode session store
 * @param {string}   opts.findingsDb            - path to findings ledger
 * @param {number}   opts.captureMinIntervalMs  - throttle interval in ms (0 = disabled)
 * @param {string[]} opts.excludedAgents        - agent names to skip
 * @param {string[]} opts.approvalAllowPrefixes - first-token allowlist
 * @param {string[]} opts.approvalDenyShapes    - destructive phrase denylist
 * @returns {Promise<{ new: object[], open_others: object[], skipped?: string }>}
 */
export async function cmdCapture(sessionId, opts) {
  const {
    openCodeDb,
    findingsDb,
    captureMinIntervalMs,
    excludedAgents,
    approvalAllowPrefixes,
    approvalDenyShapes,
  } = opts;

  const { ledger, sessionStore } = openDatabases({
    ledgerPath: findingsDb,
    sessionStorePath: openCodeDb,
  });

  ensureSchema(ledger);

  // Recursion guard: never analyse an excluded agent's own session.
  const agent = getSessionAgent(sessionStore, sessionId);
  if (!agent) {
    throw new Error(`session not found in store: ${sessionId}`);
  }
  if (excludedAgents.includes(agent)) {
    return { new: [], open_others: [], skipped: 'excluded-agent' };
  }

  const now = Date.now();

  // Read the capture bookmark for this session.
  const { lastPartMs: wmPartMs, lastCaptureMs: wmCapture } = readWatermark(
    ledger,
    sessionId
  );

  // Throttle: skip if a non-throttled capture ran too recently.
  if (captureMinIntervalMs > 0 && wmCapture > 0) {
    if (now - wmCapture < captureMinIntervalMs) {
      return { new: [], open_others: [], skipped: 'throttled' };
    }
  }

  const upper = now;
  const newIds = [];

  // ── Tool errors + permission rejects ─────────────────────────────────────
  const errorSignals = [
    ...extractToolErrors(sessionStore, sessionId, wmPartMs, upper),
    ...extractPermissionRejects(sessionStore, sessionId, wmPartMs, upper),
  ];

  for (const sig of errorSignals) {
    const norm = normalise(sig.rawText);
    const sev = classifySeverity(norm);
    const fp = fingerprintOf(sig.signalType, agent, sig.tool, norm);
    const desc = `${sig.signalType} [${sig.tool || '?'}] @${agent || '?'}: ${norm.slice(0, 140)}`;
    const { isNew, id } = upsertSignal(ledger, {
      signalType: sig.signalType,
      agent,
      tool: sig.tool,
      description: desc,
      severity: sev,
      fingerprint: fp,
      sessionId,
      nowMs: now,
    });
    if (isNew) newIds.push(id);
  }

  // ── Approval-toil pass (bash only) ────────────────────────────────────────
  // Only paid when the session actually ran bash commands.
  const bashCmds = extractBashCommands(sessionStore, sessionId, wmPartMs, upper);

  if (bashCmds.length > 0) {
    const rulesResult = await agentBashRules(agent);

    if (rulesResult.available) {
      const survivors = filterApprovalToil(
        bashCmds,
        rulesResult.rules,
        approvalAllowPrefixes,
        approvalDenyShapes
      );

      // Gate 5: ignored fingerprints (DB check)
      const isIgnoredFp = ledger.prepare(
        'SELECT COUNT(*) AS n FROM ignored_fingerprints WHERE fingerprint = ?'
      );

      for (const { firstToken, normalised: norm } of survivors) {
        const fp = fingerprintOf('approval-toil', agent, 'bash', norm);

        // Gate 5: skip if the fingerprint is in ignored_fingerprints.
        const { n } = isIgnoredFp.get(fp);
        if (n > 0) continue;

        const sev = classifySeverity(norm);
        const cand = `${firstToken} *`;
        const desc = `approval-toil [bash:${cand}] @${agent || '?'}: ${norm.slice(0, 120)}`;
        const { isNew, id } = upsertSignal(ledger, {
          signalType: 'approval-toil',
          agent,
          tool: 'bash',
          description: desc,
          severity: sev,
          fingerprint: fp,
          sessionId,
          nowMs: now,
        });
        if (isNew) newIds.push(id);
      }
    }
  }

  // Advance watermark (even if no signals found).
  advanceWatermark(ledger, sessionId, upper, now);

  // Build output JSON: new findings + open_others (capped at 50, excluding new).
  if (newIds.length === 0) {
    return { new: [], open_others: [] };
  }

  const placeholders = newIds.map(() => '?').join(', ');

  const newFindings = ledger
    .prepare(
      `SELECT id, signal_type, agent, tool, description, severity
         FROM findings
        WHERE id IN (${placeholders})`
    )
    .all(...newIds);

  const openOthers = ledger
    .prepare(
      `SELECT id, signal_type, agent, tool, description, severity
         FROM findings
        WHERE status = 'open'
          AND id NOT IN (${placeholders})
        ORDER BY occurrence_count DESC
        LIMIT 50`
    )
    .all(...newIds);

  return { new: newFindings, open_others: openOthers };
}
