// src/lib/dedup-prompt.js — Dedup prompt builder and reply parser.
//
// Extracted from the inline runDedup() in session-review-capture.js (plugin.js)
// to make it independently unit-testable.
//
// buildDedupPrompt: constructs the prompt string sent to the dedup agent.
// parseDedupReply:  extracts the JSON verdict from the LLM reply text,
//                   tolerating stray prose (fail-safe: returns [] on malformed input).

/**
 * Build the dedup prompt to send to the session-finding-deduper agent.
 * Ported exactly from runDedup() in session-review-capture.js lines 169–177.
 *
 * @param {object[]} freshFindings    - newly captured finding objects
 * @param {object[]} existingFindings - existing open finding objects to compare against
 * @returns {string}
 */
export function buildDedupPrompt(freshFindings, existingFindings) {
  return (
    'Deduplicate session-finding records. For each NEW finding decide whether ' +
    'it describes the SAME underlying root cause as one EXISTING finding.\n\n' +
    `NEW (just captured):\n${JSON.stringify(freshFindings)}\n\n` +
    `EXISTING open findings:\n${JSON.stringify(existingFindings)}\n\n` +
    'Reply with ONLY a JSON array, no prose: ' +
    '[{"new_id":<id>,"duplicate_of":<existing id or null>}]. ' +
    'Use null when the NEW finding is genuinely distinct.'
  );
}

/**
 * Parse the LLM dedup reply text to extract a JSON array of verdicts.
 * Tolerates stray prose by looking for the first `[{...}]` pattern.
 * Ported exactly from runDedup() in session-review-capture.js lines 203–212.
 *
 * @param {string} replyText
 * @returns {Array<{new_id: number, duplicate_of: number | null}>}
 */
export function parseDedupReply(replyText) {
  if (!replyText || typeof replyText !== 'string') return [];
  // Extract the first JSON array-of-objects, tolerating stray prose.
  // Anchored on `[ ... { ... } ... ]` to avoid latching onto a stray bracket
  // pair (e.g. "[see above]") that is not the verdict array.
  const match = replyText.match(/\[\s*\{[\s\S]*\}\s*\]/);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[0]);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
