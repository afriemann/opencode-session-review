// test/dedup-prompt.test.js
// Tests for buildDedupPrompt() and parseDedupReply() from src/lib/dedup-prompt.js

import { buildDedupPrompt, parseDedupReply } from '../src/lib/dedup-prompt.js';

describe('buildDedupPrompt()', () => {
  const freshFindings = [
    { id: 10, signal_type: 'tool-error', agent: 'dev', tool: 'bash', description: 'error a' },
  ];
  const existingFindings = [
    { id: 5, signal_type: 'tool-error', agent: 'dev', tool: 'bash', description: 'error b' },
    { id: 6, signal_type: 'approval-toil', agent: 'dev', tool: 'bash', description: 'toil c' },
  ];

  test('result is a string', () => {
    expect(typeof buildDedupPrompt(freshFindings, existingFindings)).toBe('string');
  });

  test('contains "NEW" section header', () => {
    const prompt = buildDedupPrompt(freshFindings, existingFindings);
    expect(prompt).toContain('NEW');
  });

  test('contains "EXISTING" section header', () => {
    const prompt = buildDedupPrompt(freshFindings, existingFindings);
    expect(prompt).toContain('EXISTING');
  });

  test('contains serialised JSON of fresh findings', () => {
    const prompt = buildDedupPrompt(freshFindings, existingFindings);
    expect(prompt).toContain(JSON.stringify(freshFindings));
  });

  test('contains serialised JSON of existing findings', () => {
    const prompt = buildDedupPrompt(freshFindings, existingFindings);
    expect(prompt).toContain(JSON.stringify(existingFindings));
  });

  test('instructs reply format (JSON array)', () => {
    const prompt = buildDedupPrompt(freshFindings, existingFindings);
    expect(prompt).toContain('new_id');
    expect(prompt).toContain('duplicate_of');
  });

  test('works with empty arrays', () => {
    expect(() => buildDedupPrompt([], [])).not.toThrow();
    const prompt = buildDedupPrompt([], []);
    expect(typeof prompt).toBe('string');
  });
});

describe('parseDedupReply()', () => {
  test('clean JSON array → returns the parsed array', () => {
    const input = '[{"new_id":10,"duplicate_of":5}]';
    const result = parseDedupReply(input);
    expect(result).toEqual([{ new_id: 10, duplicate_of: 5 }]);
  });

  test('JSON embedded in prose → extracts and returns just the array', () => {
    const input =
      'Based on my analysis, here is the verdict:\n' +
      '[{"new_id":10,"duplicate_of":5},{"new_id":11,"duplicate_of":null}]\n' +
      'I hope this helps!';
    const result = parseDedupReply(input);
    expect(result).toEqual([
      { new_id: 10, duplicate_of: 5 },
      { new_id: 11, duplicate_of: null },
    ]);
  });

  test('malformed text → returns []', () => {
    expect(parseDedupReply('this is not json at all')).toEqual([]);
    expect(parseDedupReply('{not an array}')).toEqual([]);
    expect(parseDedupReply('[broken json {')).toEqual([]);
  });

  test('empty string → returns []', () => {
    expect(parseDedupReply('')).toEqual([]);
  });

  test('null input → returns []', () => {
    expect(parseDedupReply(null)).toEqual([]);
  });

  test('non-string input → returns []', () => {
    expect(parseDedupReply(42)).toEqual([]);
    expect(parseDedupReply(undefined)).toEqual([]);
  });

  test('stray "[see above]" bracket pair (not an object array) → returns []', () => {
    // This must not match: [see above] is not [{...}]
    expect(parseDedupReply('please [see above] for context')).toEqual([]);
  });

  test('array of non-objects → parseDedupReply returns the parsed content (array is valid JSON)', () => {
    // parseDedupReply only checks that the result is an array; content validation
    // happens in plugin.js. A plain array like [1,2,3] does NOT match the regex
    // (regex requires [{...}]) so it returns [].
    expect(parseDedupReply('[1, 2, 3]')).toEqual([]);
  });

  test('multiple findings in reply', () => {
    const input = '[{"new_id":1,"duplicate_of":null},{"new_id":2,"duplicate_of":5}]';
    const result = parseDedupReply(input);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ new_id: 1, duplicate_of: null });
    expect(result[1]).toEqual({ new_id: 2, duplicate_of: 5 });
  });

  test('single-object array → correctly parsed', () => {
    const input = '[{"new_id":7,"duplicate_of":3}]';
    expect(parseDedupReply(input)).toEqual([{ new_id: 7, duplicate_of: 3 }]);
  });
});
