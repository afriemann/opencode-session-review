// src/lib/dedup-prompt.js — Dedup data-payload builder and reply parser.
//
// buildDedupPrompt: builds the data-only `body.parts` text for the inline
//   dedup model call. Task instructions live in body.system (src/prompts/deduper.md)
//   and the output contract is enforced by body.format (json_schema); this
//   function only serialises the untrusted input arrays.
// parseDedupReply:  extracts the JSON verdict from a text-mode LLM reply,
//                   tolerating stray prose (fail-safe: returns [] on malformed
//                   input). Used as the fallback when json_schema is not
//                   honoured by the provider.

/**
 * Build the data-only parts payload for the inline dedup model call.
 * Emits only the NEW and EXISTING finding arrays; task instructions are in
 * body.system and the JSON-array output contract is in body.format.
 *
 * @param {object[]} freshFindings    - newly captured finding objects
 * @param {object[]} existingFindings - existing open finding objects to compare against
 * @returns {string}
 */
export function buildDedupPrompt(freshFindings, existingFindings) {
  return (
    `NEW:\n${JSON.stringify(freshFindings)}\n\n` +
    `EXISTING:\n${JSON.stringify(existingFindings)}`
  );
}

/**
 * Parse the LLM dedup reply text to extract a JSON array of verdicts.
 * Tolerates stray prose by looking for the first `[{...}]` pattern.
 * Used as the fail-safe text-mode fallback when json_schema is not honoured.
 *
 * @param {string} replyText
 * @returns {Array<{new_id: number, duplicate_of: number | null}>}
 */
export function parseDedupReply(replyText) {
  if (!replyText || typeof replyText !== 'string') return [];
  // Extract the first JSON array-of-objects, tolerating stray prose.
  // Anchored on `[ ... { ... } ... ]` to avoid latching onto a stray bracket
  // pair (e.g. "[see above]") that is not the verdict array.
  // Note: intentionally requires at least one {} object; a bare '[]' from
  // text mode takes the !match path and also returns [], which is the correct
  // "no duplicates" result.
  const match = replyText.match(/\[\s*\{[\s\S]*\}\s*\]/);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[0]);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
