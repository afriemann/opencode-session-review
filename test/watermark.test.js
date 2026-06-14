// test/watermark.test.js
// Tests for readWatermark() and advanceWatermark() from src/lib/watermark.js

import { DatabaseSync } from 'node:sqlite';
import { ensureSchema } from '../src/lib/schema.js';
import { readWatermark, advanceWatermark } from '../src/lib/watermark.js';

function makeLedger() {
  const db = new DatabaseSync(':memory:');
  ensureSchema(db);
  return db;
}

describe('readWatermark()', () => {
  test('first read (no row) → { lastPartMs: 0, lastCaptureMs: 0 }', () => {
    const ledger = makeLedger();
    const wm = readWatermark(ledger, 'session-xyz');
    expect(wm).toEqual({ lastPartMs: 0, lastCaptureMs: 0 });
  });

  test('returns correct values after advance', () => {
    const ledger = makeLedger();
    advanceWatermark(ledger, 'session-abc', 5000, 6000);
    const wm = readWatermark(ledger, 'session-abc');
    expect(wm.lastPartMs).toBe(5000);
    expect(wm.lastCaptureMs).toBe(6000);
  });
});

describe('advanceWatermark()', () => {
  test('advance then read back → values match', () => {
    const ledger = makeLedger();
    advanceWatermark(ledger, 'sess-1', 1234, 5678);
    const wm = readWatermark(ledger, 'sess-1');
    expect(wm.lastPartMs).toBe(1234);
    expect(wm.lastCaptureMs).toBe(5678);
  });

  test('MAX semantics: advance with smaller upper does not go backwards on lastPartMs', () => {
    const ledger = makeLedger();
    advanceWatermark(ledger, 'sess-2', 9000, 10000);
    // Advance with a smaller upper — lastPartMs must stay at 9000
    advanceWatermark(ledger, 'sess-2', 5000, 11000);
    const wm = readWatermark(ledger, 'sess-2');
    expect(wm.lastPartMs).toBe(9000);
  });

  test('lastCaptureMs is updated on every advance regardless of upper', () => {
    const ledger = makeLedger();
    advanceWatermark(ledger, 'sess-3', 9000, 10000);
    // Second advance with smaller upper but newer now
    advanceWatermark(ledger, 'sess-3', 1000, 20000);
    const wm = readWatermark(ledger, 'sess-3');
    expect(wm.lastCaptureMs).toBe(20000);
  });

  test('subsequent advance with larger upper → lastPartMs advances', () => {
    const ledger = makeLedger();
    advanceWatermark(ledger, 'sess-4', 5000, 6000);
    advanceWatermark(ledger, 'sess-4', 9000, 10000);
    const wm = readWatermark(ledger, 'sess-4');
    expect(wm.lastPartMs).toBe(9000);
    expect(wm.lastCaptureMs).toBe(10000);
  });

  test('first advance is idempotent-safe (insert path)', () => {
    const ledger = makeLedger();
    advanceWatermark(ledger, 'sess-new', 100, 200);
    const wm = readWatermark(ledger, 'sess-new');
    expect(wm.lastPartMs).toBe(100);
    expect(wm.lastCaptureMs).toBe(200);
  });
});
