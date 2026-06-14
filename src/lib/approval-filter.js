// src/lib/approval-filter.js — Approval-toil gates 1–4 (pure JS).
//
// This is a faithful port of the APPROVAL_FILTER_PY heredoc embedded in
// session-finding-capture.sh (lines ~157–255). All gate logic, wildcard
// semantics, and pattern expansion are identical to the Python version.
//
// Gate 5 (ignored fingerprints) requires a DB lookup and lives in
// src/lib/commands/capture.js so that this module stays dependency-free
// and fully unit-testable.
//
// normalise() and classifySeverity() are imported from normalise.js so
// fingerprints computed here and in the capture pass are byte-identical.

import { normalise, classifySeverity } from './normalise.js';

/**
 * Expand tilde and $HOME placeholders in a pattern, mirroring opencode's
 * expand() function and the Python expand_pattern().
 *
 * @param {string} pattern
 * @param {string} home  - value of HOME env var
 * @returns {string}
 */
export function expandPattern(pattern, home) {
  if (pattern === '~') return home;
  if (pattern.startsWith('~/')) return home + pattern.slice(1);
  if (pattern.startsWith('${HOME}/')) return home + pattern.slice(7);
  if (pattern.startsWith('${HOME}')) return home + pattern.slice(7);
  if (pattern.startsWith('$HOME/')) return home + pattern.slice(5);
  if (pattern.startsWith('$HOME')) return home + pattern.slice(5);
  return pattern;
}

/**
 * Convert a glob-style pattern to a RegExp that mirrors opencode's
 * Wildcard.match() semantics, exactly as the Python wildcard_regex() does.
 *
 * Conversion rules (applied in order):
 *   1. Replace \ with /
 *   2. Escape regex special chars: . + ^ $ { } ( ) | [ ] \
 *   3. Replace * with .*
 *   4. Replace ? with .
 *   5. If the result ends with ' .*' (from step 3), replace that suffix
 *      with ' (.*)?' so trailing-arg patterns match commands with or without
 *      arguments (step 5 must run AFTER step 3, not before)
 *   6. Anchor with ^...$, flags: dotAll ('s')
 *
 * @param {string} pattern
 * @returns {RegExp}
 */
export function wildcardRegex(pattern) {
  // Step 1: normalise path separators
  let p = pattern.replace(/\\/g, '/');
  // Step 2: escape regex special chars (same set as Python re.sub)
  p = p.replace(/([.+^${}()|[\]\\])/g, '\\$1');
  // Step 3: * → .*
  p = p.replace(/\*/g, '.*');
  // Step 4: ? → .
  p = p.replace(/\?/g, '.');
  // Step 5: trailing ' .*' (literal, from step 3 conversion) → '( .*)?'
  // Python: pat[:-3] + '( .*)?'  removes the trailing ' .*' (3 chars:
  // space + dot + star) and replaces with '( .*)?' where the space is INSIDE
  // the optional group. This makes 'git commit *' match 'git commit' alone,
  // without requiring a trailing space.
  if (p.endsWith(' .*')) {
    p = p.slice(0, -3) + '( .*)?';
  }
  // Step 6: anchor with dotAll
  return new RegExp('^' + p + '$', 's');
}

/**
 * Last-match-wins resolution of a command against the effective bash rules.
 * Default action when no rule matches is 'ask'.
 *
 * Mirrors the Python gate-1 loop exactly.
 *
 * @param {Array<{action: string, pattern: string}>} rules  - ordered rules (last-match-wins)
 * @param {string} command  - raw bash command string
 * @param {string} home     - value of HOME env var
 * @returns {string}  'allow' | 'deny' | 'ask'
 */
export function resolveLastMatch(rules, command, home) {
  let action = 'ask';
  for (const rule of rules) {
    const rx = wildcardRegex(expandPattern(rule.pattern, home));
    if (rx.test(command)) {
      action = rule.action;
    }
  }
  return action;
}

/**
 * Extract the first effective token from a bash command string, stripping:
 *   1. Leading `cd <anything> && ` (or `;`)
 *   2. Leading `env ` prefix
 *   3. Leading `VAR=val ` pairs (one or more)
 *
 * Returns '' for an empty or whitespace-only command.
 * Mirrors Python first_token() exactly.
 *
 * @param {string} command
 * @returns {string}
 */
export function extractFirstToken(command) {
  let cmd = command;
  // Strip leading `cd <anything> &&` or `cd <anything> ;`
  cmd = cmd.replace(/^\s*cd\s+[^&;]+\s*(&&|;)\s*/g, '');
  // Strip leading `env ` prefix
  cmd = cmd.replace(/^\s*env\s+/, '');
  // Strip leading VAR=val pairs
  cmd = cmd.replace(/^\s*([A-Za-z_][A-Za-z0-9_]*=[^\s]*\s+)+/, '');
  cmd = cmd.trim();
  const parts = cmd.split(/\s+/);
  return parts[0] || '';
}

/**
 * Reduce a deny-shape string to its normalised phrase for substring matching.
 * Strips a trailing ' *', lowercases, and collapses whitespace.
 * Mirrors Python deny_phrase() exactly.
 *
 * @param {string} shape
 * @returns {string}
 */
function denyPhrase(shape) {
  let s = shape.trim();
  if (s.endsWith(' *')) s = s.slice(0, -2);
  return s.replace(/\s+/g, ' ').toLowerCase().trim();
}

/**
 * Check whether a command matches any deny shape (substring containment).
 * The command is whitespace-collapsed and lowercased before checking.
 * Mirrors Python gate-3 logic exactly.
 *
 * @param {string} command
 * @param {string[]} denyShapes
 * @returns {boolean}
 */
export function isDenyShape(command, denyShapes) {
  const collapsed = command.replace(/\s+/g, ' ').toLowerCase().trim();
  for (const shape of denyShapes) {
    const phrase = denyPhrase(shape);
    if (phrase && collapsed.includes(phrase)) return true;
  }
  return false;
}

/**
 * Apply approval-toil gates 1–4 to a list of bash commands.
 *
 * Gate 1: command resolves to 'ask' under the agent's effective bash rules
 *         (last-match-wins; default 'ask').
 * Gate 2: first effective token is in the allowPrefixes set.
 * Gate 3: command does NOT contain any destructive deny phrase (substring).
 * Gate 4: normalised command is NOT classified 'severe'.
 *
 * Survivors are returned as objects with the first token and normalised form.
 * (Gate 5 — ignored fingerprints — is in commands/capture.js, not here.)
 *
 * @param {string[]} commands           - raw bash command strings
 * @param {Array<{action: string, pattern: string}>} rules
 *                                      - effective bash rules, last-match-wins
 * @param {string[]} allowPrefixes      - e.g. ['go', 'gh', 'git', ...]
 * @param {string[]} denyShapes         - e.g. ['git push *', 'terraform apply *', ...]
 * @returns {Array<{firstToken: string, normalised: string}>}
 */
export function filterApprovalToil(commands, rules, allowPrefixes, denyShapes) {
  const home = process.env.HOME || '';
  const allowSet = new Set(allowPrefixes);
  const survivors = [];

  for (const raw of commands) {
    const cmd = raw.trim();
    if (!cmd) continue;

    // Gate 1: must resolve to 'ask' (not 'allow' or 'deny').
    const action = resolveLastMatch(rules, cmd, home);
    if (action !== 'ask') continue;

    // Gate 2: first token must be on the allowlist.
    const tok = extractFirstToken(cmd);
    if (!allowSet.has(tok)) continue;

    // Gate 3: must not contain a destructive deny phrase.
    if (isDenyShape(cmd, denyShapes)) continue;

    // Gate 4: normalised form must not be 'severe'.
    const norm = normalise(cmd);
    if (classifySeverity(norm) === 'severe') continue;

    survivors.push({ firstToken: tok, normalised: norm });
  }

  return survivors;
}
