import { describe, expect, test } from 'vitest';
import { resolveWeeklySessions } from '../src/sessions.ts';
import { createSessionTimeScale } from '../src/time-scale.ts';
import { EQUITY_SPEC, FUTURES_SPEC, HOUR, MIN, TEST_ID } from './helpers.ts';

const equitySessions = (from: string, to: string) =>
  resolveWeeklySessions({ instrumentId: TEST_ID, spec: EQUITY_SPEC, from, to });

describe('intraday 5m mapping, regular mode', () => {
  const sessions = equitySessions('2026-03-02', '2026-03-13');
  const map = createSessionTimeScale({
    sessions,
    sessionMode: 'regular',
    slot: { kind: 'intraday', durationMs: 5 * MIN },
  });
  const open0 = Date.UTC(2026, 2, 2, 14, 30); // Mon 09:30 EST
  const open1 = Date.UTC(2026, 2, 3, 14, 30); // Tue 09:30 EST
  const openAfterDst = Date.UTC(2026, 2, 9, 13, 30); // Mon 09:30 EDT

  test('78 slots per RTH session; bucket starts map to integer slots', () => {
    expect(map.toSlot(open0)).toBe(0);
    expect(map.toSlot(open0 + 5 * MIN)).toBe(1);
    expect(map.toSlot(open0 + 385 * MIN)).toBe(77); // 15:55
    expect(map.toSlot(open1)).toBe(78);
    expect(map.toSlot(openAfterDst)).toBe(5 * 78);
  });

  test('times inside a slot are fractional', () => {
    expect(map.toSlot(open0 + 2.5 * MIN)).toBeCloseTo(0.5, 12);
  });

  test('closed time (overnight, weekend, pre-market in regular mode) maps to null', () => {
    expect(map.toSlot(open0 - MIN)).toBeNull(); // 09:29
    expect(map.toSlot(open0 + 390 * MIN)).toBeNull(); // 16:00 is the exclusive end
    expect(map.toSlot(Date.UTC(2026, 2, 7, 17, 0))).toBeNull(); // Saturday
  });

  test('slotStart is the inverse of toSlot for every slot', () => {
    for (let slot = 0; slot < 10 * 78; slot++) {
      expect(map.toSlot(map.slotStart(slot))).toBe(slot);
    }
    expect(map.slotStart(78)).toBe(open1);
  });

  test('slotStart extrapolates outside the resolved sessions', () => {
    expect(map.slotStart(-1)).toBe(open0 - 5 * MIN);
    const lastSlotStart = map.slotStart(10 * 78 - 1);
    expect(map.slotStart(10 * 78 + 2)).toBe(lastSlotStart + 15 * MIN);
  });

  test('boundaries report the most significant calendar change', () => {
    const b = map.boundaries(0, 10 * 78);
    expect(b).toHaveLength(10);
    expect(b[0]).toEqual({ slot: 0, kind: 'day' });
    expect(b[1]).toEqual({ slot: 78, kind: 'day' });
    expect(b[5]).toEqual({ slot: 5 * 78, kind: 'week' }); // Monday 2026-03-09
    expect(map.boundaries(1, 77)).toEqual([]);
    expect(map.boundaries(78, 78)).toEqual([{ slot: 78, kind: 'day' }]);
  });

  test('month and year boundaries', () => {
    const s = equitySessions('2026-12-30', '2027-02-02');
    const m = createSessionTimeScale({
      sessions: s,
      sessionMode: 'regular',
      slot: { kind: 'intraday', durationMs: HOUR },
    });
    const kinds = m.boundaries(0, 1e9).map((x) => x.kind);
    expect(kinds[0]).toBe('day'); // 2026-12-30 (first)
    expect(kinds[2]).toBe('year'); // 2027-01-01 (Friday, weekly schedule has no holidays)
    expect(kinds).toContain('month'); // 2027-02-01
  });
});

describe('session-aligned 1h slots (owner decision Q5)', () => {
  const sessions = equitySessions('2026-03-02', '2026-03-03');
  const map = createSessionTimeScale({
    sessions,
    sessionMode: 'regular',
    slot: { kind: 'intraday', durationMs: HOUR },
  });
  const open = Date.UTC(2026, 2, 2, 14, 30);

  test('7 slots per RTH session: 09:30, 10:30, ... 14:30, 15:30 (short)', () => {
    const starts = Array.from({ length: 7 }, (_, i) => map.slotStart(i));
    expect(starts).toEqual([0, 1, 2, 3, 4, 5, 6].map((i) => open + i * HOUR));
    expect(map.slotStart(7)).toBe(Date.UTC(2026, 2, 3, 14, 30));
  });

  test('the clipped last slot is 30 minutes long: 15:45 is halfway through slot 6', () => {
    expect(map.toSlot(open + 6 * HOUR + 15 * MIN)).toBeCloseTo(6.5, 12);
    expect(map.toSlot(open + 6.5 * HOUR)).toBeNull(); // 16:00
  });
});

describe('extended mode', () => {
  test('pre, regular and post windows are all open; 16 hours of 1h slots', () => {
    const sessions = equitySessions('2026-03-02', '2026-03-02');
    const map = createSessionTimeScale({
      sessions,
      sessionMode: 'extended',
      slot: { kind: 'intraday', durationMs: HOUR },
    });
    // pre 04:00-09:30 => 6 slots (last one 09:00-09:30), regular 7, post 4.
    expect(map.boundaries(0, 100).map((b) => b.kind)).toEqual(['day', 'session', 'session']);
    expect(map.boundaries(0, 100).map((b) => b.slot)).toEqual([0, 6, 13]);
    expect(map.toSlot(Date.UTC(2026, 2, 2, 9, 0))).toBe(0); // 04:00 EST
  });
});

describe('daily (session) slots', () => {
  test('one slot per session; fraction across the session', () => {
    const sessions = equitySessions('2026-03-02', '2026-03-13');
    const map = createSessionTimeScale({
      sessions,
      sessionMode: 'regular',
      slot: { kind: 'session' },
    });
    expect(map.toSlot(Date.UTC(2026, 2, 2, 14, 30))).toBe(0);
    expect(map.toSlot(Date.UTC(2026, 2, 9, 13, 30))).toBe(5);
    expect(map.toSlot(Date.UTC(2026, 2, 2, 17, 45))).toBeCloseTo(0.5, 12);
    expect(map.slotStart(5)).toBe(Date.UTC(2026, 2, 9, 13, 30));
    expect(map.boundaries(0, 9).map((b) => b.kind)).toEqual([
      'day',
      'day',
      'day',
      'day',
      'day',
      'week',
      'day',
      'day',
      'day',
      'day',
    ]);
  });
});

describe('futures-style session with a scheduled break', () => {
  const sessions = resolveWeeklySessions({
    instrumentId: TEST_ID,
    spec: FUTURES_SPEC,
    from: '2026-03-02',
    to: '2026-03-03',
  });
  const map = createSessionTimeScale({
    sessions,
    sessionMode: 'regular',
    slot: { kind: 'intraday', durationMs: HOUR },
  });

  test('overnight window 15 slots, break compressed, day window 8 slots (last clipped)', () => {
    // Sun 17:00 -> Mon 08:00 CT = 15h; Mon 08:30 -> 16:00 = 7.5h => 8 slots.
    expect(map.boundaries(0, 100)).toEqual([
      { slot: 0, kind: 'day' },
      { slot: 15, kind: 'session' },
      { slot: 23, kind: 'day' },
      { slot: 38, kind: 'session' },
    ]);
    expect(map.toSlot(Date.UTC(2026, 2, 2, 14, 15))).toBeNull(); // 08:15 CT, in the break
    expect(map.toSlot(Date.UTC(2026, 2, 2, 14, 30))).toBe(15); // 08:30 CT
  });

  test('bucket after midnight stays in the same session', () => {
    expect(map.toSlot(Date.UTC(2026, 2, 2, 6, 0))).toBe(7); // Mon 00:00 CT
  });
});

test('rejects a non-positive intraday duration', () => {
  expect(() =>
    createSessionTimeScale({
      sessions: [],
      sessionMode: 'regular',
      slot: { kind: 'intraday', durationMs: 0 },
    }),
  ).toThrow();
});
