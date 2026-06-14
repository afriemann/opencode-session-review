// src/lib/config-rules.js — Effective bash rules resolver.
//
// Fetches and caches the effective bash rules for an agent from
// `opencode debug config`. Rules are memoised by agent name for the lifetime
// of the process (one capture run).
//
// The result is always one of:
//   { available: false }                              — any failure (missing binary, parse error, etc.)
//   { available: true, rules: [{action, pattern}] }  — success
//
// The truncation workaround (write to temp file, read back) is preserved
// from the bash script: opencode's `debug config` output is truncated to
// ~65 kB when its stdout is a pipe or command-substitution. Writing to a
// temp file and reading it back gives the full ~232 kB output.

import { spawn } from 'node:child_process';
import { mkdtempSync, mkdtempSync as _mkdtemp, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Process-lifetime cache: agentName → { available, rules? }
const _cache = new Map();

// Process-lifetime flag: have we attempted to load the debug config?
let _configLoaded = false;
let _configJson = null;

/**
 * Run `opencode debug config`, writing output to a temp file to avoid the
 * ~65 kB pipe-truncation issue, then read and parse the JSON.
 * Sets _configJson on success; leaves it null on any failure.
 */
async function loadDebugConfig() {
  if (_configLoaded) return;
  _configLoaded = true;

  try {
    const tmpDir = mkdtempSync(join(tmpdir(), 'sfc-cfg-'));
    const tmpFile = join(tmpDir, 'config.json');

    await new Promise((resolve) => {
      const child = spawn('opencode', ['debug', 'config'], {
        stdio: ['ignore', 'pipe', 'ignore'],
      });

      const chunks = [];
      child.stdout.on('data', (chunk) => chunks.push(chunk));
      child.stdout.on('end', () => {
        try {
          const raw = Buffer.concat(chunks).toString('utf8');
          if (raw.trim()) {
            writeFileSync(tmpFile, raw, 'utf8');
          }
        } catch {
          // ignore write errors
        }
        resolve();
      });
      child.on('error', () => resolve());
      child.on('close', () => resolve());
    });

    // Read back from the temp file (avoids the pipe truncation)
    let raw;
    try {
      raw = readFileSync(tmpFile, 'utf8');
    } catch {
      return;
    } finally {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }

    if (!raw || !raw.trim()) return;
    const parsed = JSON.parse(raw);
    _configJson = parsed;
  } catch {
    // Any failure: leave _configJson null
  }
}

/**
 * Extract effective bash rules for an agent from the cached config JSON.
 * Merge order: top-level permission.bash first, then agent-specific override
 * appended (last-match-wins, matching opencode's evaluation order).
 *
 * @param {object} cfg   - parsed opencode debug config JSON
 * @param {string} agent - agent name
 * @returns {Array<{action: string, pattern: string}> | null}
 */
function extractRulesFromConfig(cfg, agent) {
  try {
    const topRaw = cfg && cfg.permission && cfg.permission.bash;
    const top = (topRaw && typeof topRaw === 'object' && !Array.isArray(topRaw))
      ? topRaw
      : {};

    const ovRaw =
      cfg &&
      cfg.agent &&
      cfg.agent[agent] &&
      cfg.agent[agent].permission &&
      cfg.agent[agent].permission.bash;
    const ov = (ovRaw && typeof ovRaw === 'object' && !Array.isArray(ovRaw))
      ? ovRaw
      : {};

    const items = [
      ...Object.entries(top),
      ...Object.entries(ov),
    ];

    const rules = [];
    for (const [pat, act] of items) {
      if (typeof pat === 'string' && typeof act === 'string' && pat && act) {
        rules.push({ action: act, pattern: pat });
      }
    }
    return rules.length > 0 ? rules : null;
  } catch {
    return null;
  }
}

/**
 * Return the effective bash rules for an agent, loading and caching the
 * opencode debug config on the first call.
 *
 * @param {string} agentName
 * @returns {Promise<{ available: false } | { available: true, rules: Array<{action: string, pattern: string}> }>}
 */
export async function agentBashRules(agentName) {
  if (_cache.has(agentName)) {
    return _cache.get(agentName);
  }

  await loadDebugConfig();

  let result;
  if (_configJson) {
    const rules = extractRulesFromConfig(_configJson, agentName);
    result = rules ? { available: true, rules } : { available: false };
  } else {
    result = { available: false };
  }

  _cache.set(agentName, result);
  return result;
}
