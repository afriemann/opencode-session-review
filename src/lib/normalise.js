// src/lib/normalise.js — Signal normalisation, severity classification, and
// SHA-1 fingerprinting.
//
// These three pure functions are the single source of truth for fingerprint
// computation. Both the capture pass and the approval-filter import from here
// so that normalised forms and fingerprints are always byte-identical.

import { createHash } from 'node:crypto';

/**
 * Normalise free text into a stable, volatile-token-stripped signature.
 *
 * Ported exactly from the bash `normalise()` and the Python `normalise()`
 * heredoc (both apply the same transformations in the same order):
 *   1. lowercase
 *   2. strip home/user paths → /~
 *   3. strip /tmp/ paths → /tmp/*
 *   4. replace hex IDs (8+ hex digits, word-bounded) → #
 *   5. replace URLs → <url>
 *   6. replace digit runs → #
 *   7. collapse whitespace
 *   8. trim
 *   9. empty result → '(empty)'
 *
 * @param {string} text
 * @returns {string}
 */
export function normalise(text) {
  if (typeof text !== 'string') text = String(text);
  let s = text.toLowerCase();
  s = s.replace(/\/(home|users)\/[^/ ]+/g, '/~');
  s = s.replace(/\/tmp\/[^ ]*/g, '/tmp/*');
  s = s.replace(/\b[0-9a-f]{8,}\b/g, '#');
  s = s.replace(/https?:\/\/[^ ]+/g, '<url>');
  s = s.replace(/[0-9]+/g, '#');
  s = s.replace(/\s+/g, ' ');
  s = s.trim();
  return s || '(empty)';
}

/**
 * Classify severity from a normalised signal description.
 * Returns 'severe' if the text contains any destructive or security-sensitive
 * phrase; 'normal' otherwise.
 *
 * Ported exactly from bash `classify_severity()` and Python `is_severe()`.
 *
 * @param {string} norm - already-normalised text
 * @returns {'severe' | 'normal'}
 */
export function classifySeverity(norm) {
  const severe = [
    'rm -rf',
    'force push',
    'force-push',
    'drop table',
    'truncate table',
    'secret',
    'password',
    'credential',
    'private key',
    'token',
  ];
  for (const phrase of severe) {
    if (norm.includes(phrase)) return 'severe';
  }
  return 'normal';
}

/**
 * Compute the SHA-1 fingerprint for a signal.
 *
 * Formula: sha1(signalType + '::' + agent + '::' + tool + '::' + norm)
 *
 * Uses node:crypto createHash('sha1').update(..., 'utf8').digest('hex'),
 * which produces byte-identical output to:
 *   printf '%s::%s::%s::%s' type agent tool norm | sha1sum | cut -d' ' -f1
 *
 * @param {string} signalType  e.g. 'tool-error', 'permission-reject', 'approval-toil'
 * @param {string} agent       agent name
 * @param {string} tool        tool name
 * @param {string} norm        normalised description (from normalise())
 * @returns {string}           40-hex-char SHA-1 digest
 */
export function fingerprintOf(signalType, agent, tool, norm) {
  const input = `${signalType}::${agent}::${tool}::${norm}`;
  return createHash('sha1').update(input, 'utf8').digest('hex');
}
