// test/normalise.test.js
// Tests for normalise(), classifySeverity(), and fingerprintOf() from src/lib/normalise.js

import { normalise, classifySeverity, fingerprintOf } from '../src/lib/normalise.js';

describe('normalise()', () => {
  test('home path /home/alice/foo → contains /~/foo', () => {
    expect(normalise('/home/alice/foo')).toBe('/~/foo');
  });

  test('/users/Bob/x → contains /~/x', () => {
    expect(normalise('/users/Bob/x')).toBe('/~/x');
  });

  test('/tmp/abc123 → /tmp/*', () => {
    expect(normalise('/tmp/abc123')).toBe('/tmp/*');
  });

  test('/tmp/some/deep/path → /tmp/*', () => {
    // The regex replaces /tmp/<non-space>* so it collapses to /tmp/*
    expect(normalise('/tmp/some/deep/path')).toBe('/tmp/*');
  });

  test('long hex ID deadbeef12345678 → #', () => {
    expect(normalise('id deadbeef12345678 here')).toBe('id # here');
  });

  test('short hex (< 8 chars) NOT replaced', () => {
    // 7 hex chars — must NOT be replaced
    const result = normalise('value abcdef1 ok');
    expect(result).toContain('abcdef');
    // It should not contain a bare # where the hex was (it stays as-is,
    // though the digit run normalisation will replace any decimal digits)
    expect(result).not.toMatch(/^# /);
  });

  test('URL https://example.com/foo?x=1 → <url>', () => {
    expect(normalise('see https://example.com/foo?x=1 for details')).toBe(
      'see <url> for details',
    );
  });

  test('digit runs replaced: "error 404 on line 23"', () => {
    expect(normalise('error 404 on line 23')).toBe('error # on line #');
  });

  test('multiple spaces → single space, trimmed', () => {
    expect(normalise('  foo   bar   ')).toBe('foo bar');
  });

  test('empty string → "(empty)"', () => {
    expect(normalise('')).toBe('(empty)');
  });

  test('string that normalises to blank → "(empty)"', () => {
    // A string of only whitespace normalises to empty after trim
    expect(normalise('   ')).toBe('(empty)');
  });

  test('non-string input is coerced to string', () => {
    expect(() => normalise(42)).not.toThrow();
    expect(normalise(42)).toBe('#');
  });

  test('lowercase applied', () => {
    expect(normalise('ERROR')).toBe('error');
  });

  test('hex replacement is word-bounded (longer hex IDs)', () => {
    const input = 'commit abc12345678901234567890 done';
    const result = normalise(input);
    // The long hex token is replaced with #
    expect(result).toBe('commit # done');
  });
});

describe('classifySeverity()', () => {
  test('"rm -rf /tmp" → "severe"', () => {
    expect(classifySeverity('rm -rf /tmp')).toBe('severe');
  });

  test('"force push to origin" → "severe"', () => {
    expect(classifySeverity('force push to origin')).toBe('severe');
  });

  test('"force-push to origin" → "severe"', () => {
    expect(classifySeverity('force-push to origin')).toBe('severe');
  });

  test('"contains token abc" → "severe"', () => {
    expect(classifySeverity('contains token abc')).toBe('severe');
  });

  test('"contains password" → "severe"', () => {
    expect(classifySeverity('user password is set')).toBe('severe');
  });

  test('"secret key" → "severe"', () => {
    expect(classifySeverity('secret key leak')).toBe('severe');
  });

  test('"credential stored" → "severe"', () => {
    expect(classifySeverity('credential stored in config')).toBe('severe');
  });

  test('"private key found" → "severe"', () => {
    expect(classifySeverity('private key found')).toBe('severe');
  });

  test('"drop table users" → "severe"', () => {
    expect(classifySeverity('drop table users')).toBe('severe');
  });

  test('"truncate table orders" → "severe"', () => {
    expect(classifySeverity('truncate table orders')).toBe('severe');
  });

  test('"normal error message" → "normal"', () => {
    expect(classifySeverity('normal error message')).toBe('normal');
  });

  test('empty string → "normal"', () => {
    expect(classifySeverity('')).toBe('normal');
  });

  test('"no matching phrase here" → "normal"', () => {
    expect(classifySeverity('no matching phrase here')).toBe('normal');
  });
});

describe('fingerprintOf()', () => {
  test('returns a 40-character hex string', () => {
    const fp = fingerprintOf('tool-error', 'my-agent', 'bash', 'some error');
    expect(fp).toMatch(/^[0-9a-f]{40}$/);
  });

  test('same inputs → same output (stable)', () => {
    const fp1 = fingerprintOf('tool-error', 'agent-a', 'bash', 'error msg');
    const fp2 = fingerprintOf('tool-error', 'agent-a', 'bash', 'error msg');
    expect(fp1).toBe(fp2);
  });

  test('different signal types → different fingerprint', () => {
    const fp1 = fingerprintOf('tool-error', 'agent', 'bash', 'msg');
    const fp2 = fingerprintOf('permission-reject', 'agent', 'bash', 'msg');
    const fp3 = fingerprintOf('approval-toil', 'agent', 'bash', 'msg');
    expect(fp1).not.toBe(fp2);
    expect(fp1).not.toBe(fp3);
    expect(fp2).not.toBe(fp3);
  });

  test('different agents → different fingerprint', () => {
    const fp1 = fingerprintOf('tool-error', 'agent-a', 'bash', 'msg');
    const fp2 = fingerprintOf('tool-error', 'agent-b', 'bash', 'msg');
    expect(fp1).not.toBe(fp2);
  });

  test('different tools → different fingerprint', () => {
    const fp1 = fingerprintOf('tool-error', 'agent', 'bash', 'msg');
    const fp2 = fingerprintOf('tool-error', 'agent', 'read', 'msg');
    expect(fp1).not.toBe(fp2);
  });

  test('different norm text → different fingerprint', () => {
    const fp1 = fingerprintOf('tool-error', 'agent', 'bash', 'error a');
    const fp2 = fingerprintOf('tool-error', 'agent', 'bash', 'error b');
    expect(fp1).not.toBe(fp2);
  });
});
