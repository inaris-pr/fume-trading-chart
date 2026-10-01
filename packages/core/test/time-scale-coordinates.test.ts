/**
 * Continuous slot coordinates for drawings/overlays: time <-> coordinate on the session-compressed
 * axis, closed-period collapse, no extrapolation outside the resolved calendar.
 */
import { describe, expect, test } from 'vitest';
import { resolveWeeklySessions } from '../src/sessions.ts';
import { createSessionTimeScale, EMPTY_TIME_SCALE } from '../src/time-scale.ts';
import { EQUITY_SPEC, FUTURES_SPEC, HOUR, MIN, TEST_ID } from './helpers.ts';

const equity = (slot: { kind: 'intraday'; durationMs: number } | { kind: 'session' }) =>
  createSessionTimeScale({
    sessions: resolveWeeklySessions({
      instrumentId: TEST_ID,
      spec: EQUITY_SPEC,
      from: '2026-03-02',
      to: '2026-03-13',
    }),
    sessionMode: 'regular',
    slot,
  });

const open0 = Date.UTC(2026, 2, 2, 14, 30); // Mon 09:30 EST
const close0 = Date.UTC(2026, 2, 2, 21, 0); // Mon 16:00 EST
const open1 = Date.UTC(2026, 2, 3, 14, 30); // Tue 09:30 EST
const fridayClose = Date.UTC(2026, 2, 6, 21, 0);
const mondayOpen = Date.UTC(2026, 2, 9, 13, 30); // EDT
const lastClose = Date.UTC(2026, 2, 13, 20, 0); // Fri 16:00 EDT

describe('timeToSlotCoordinate (5m, RTH)', () => {
  const map = equity({ kind: 'intraday', durationMs: 5 * MIN });

  test('open time: identical to toSlot (bar starts are integers, inside a slot is linear)', () => {
    for (const t of [open0, open0 + 5 * MIN, open0 + 7 * MIN, open1 + 123_456, mondayOpen]) {
      expect(map.timeToSlotCoordinate(t)).toBe(map.toSlot(t));
    }
    expect(map.timeToSlotCoordinate(open0 + 7 * MIN)).toBeCloseTo(1.4, 12);
  });

  test('closed time collapses onto the first slot after it (zero-width gaps)', () => {
    expect(map.timeToSlotCoordinate(close0)).toBe(78); // 16:00 = next session's first slot
    expect(map.timeToSlotCoordinate(close0 + 3 * HOUR)).toBe(78); // overnight
    expect(map.timeToSlotCoordinate(open1 - MIN)).toBe(78); // 09:29 pre-market (RTH chart)
    expect(map.timeToSlotCoordinate(fridayClose + 30 * HOUR)).toBe(5 * 78); // Saturday
    // Continuous at the gap: approaching the close from inside the session.
    expect(map.timeToSlotCoordinate(close0 - 1)!).toBeCloseTo(78, 3);
  });

  test('outside the resolved calendar: null (never extrapolated)', () => {
    expect(map.timeToSlotCoordinate(open0 - 1)).toBeNull();
    expect(map.timeToSlotCoordinate(lastClose)).toBeNull();
    expect(map.timeToSlotCoordinate(lastClose + 7 * 24 * HOUR)).toBeNull();
    expect(map.timeToSlotCoordinate(Number.NaN)).toBeNull();
  });
});

describe('slotCoordinateToTime', () => {
  const map = equity({ kind: 'intraday', durationMs: 5 * MIN });

  test('integers are bar starts; fractions are real time inside the slot', () => {
    expect(map.slotCoordinateToTime(0)).toBe(open0);
    expect(map.slotCoordinateToTime(78)).toBe(open1);
    expect(map.slotCoordinateToTime(1.4)).toBe(open0 + 7 * MIN);
  });

  test('round-trips with timeToSlotCoordinate for any open time and any coordinate', () => {
    for (let s = 0; s < 10 * 78; s += 0.37) {
      const t = map.slotCoordinateToTime(s)!;
      expect(map.timeToSlotCoordinate(t)!).toBeCloseTo(s, 3);
    }
    for (let t = open0; t < lastClose; t += 17 * MIN + 13_000) {
      const s = map.timeToSlotCoordinate(t)!;
      const back = map.slotCoordinateToTime(s)!;
      // Open time comes back exactly (to the ms); closed time comes back as the next open.
      if (map.toSlot(t) !== null) expect(Math.abs(back - t)).toBeLessThanOrEqual(1);
      else expect(map.toSlot(back)).toBe(Math.round(s));
    }
  });

  test('never returns closed-period time; null outside the slots', () => {
    for (let s = 0; s < 10 * 78; s += 0.25) {
      expect(map.toSlot(map.slotCoordinateToTime(s)!)).not.toBeNull();
    }
    expect(map.slotCoordinateToTime(-0.01)).toBeNull();
    expect(map.slotCoordinateToTime(10 * 78)).toBeNull();
    expect(map.slotCoordinateToTime(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe('the same instant on different timeframes (drawings across timeframe switches)', () => {
  const m1 = equity({ kind: 'intraday', durationMs: MIN });
  const m5 = equity({ kind: 'intraday', durationMs: 5 * MIN });
  const h1 = equity({ kind: 'intraday', durationMs: HOUR });
  const d1 = equity({ kind: 'session' });
  const t = open0 + 97 * MIN; // Mon 11:07

  test('a 1m bar time lands at the proportional place inside the coarser bar', () => {
    expect(m1.timeToSlotCoordinate(t)).toBe(97);
    expect(m5.timeToSlotCoordinate(t)).toBeCloseTo(19.4, 12); // 11:05 bar + 2/5
    expect(h1.timeToSlotCoordinate(t)).toBeCloseTo(1 + 37 / 60, 12); // 10:30 bar + 37/60
    expect(d1.timeToSlotCoordinate(t)).toBeCloseTo(97 / 390, 12);
  });

  test('the clipped last 1h slot (15:30-16:00) is 30 minutes long', () => {
    expect(h1.timeToSlotCoordinate(open0 + 6 * HOUR + 15 * MIN)).toBeCloseTo(6.5, 12);
    expect(h1.slotCoordinateToTime(6.5)).toBe(open0 + 6 * HOUR + 15 * MIN);
  });
});

describe('futures session with a scheduled break', () => {
  const map = createSessionTimeScale({
    sessions: resolveWeeklySessions({
      instrumentId: TEST_ID,
      spec: FUTURES_SPEC,
      from: '2026-03-02',
      to: '2026-03-03',
    }),
    sessionMode: 'regular',
    slot: { kind: 'intraday', durationMs: HOUR },
  });

  test('a time in the 08:00-08:30 CT break sits at the first slot after the break', () => {
    expect(map.timeToSlotCoordinate(Date.UTC(2026, 2, 2, 14, 15))).toBe(15);
    expect(map.slotCoordinateToTime(15)).toBe(Date.UTC(2026, 2, 2, 14, 30));
  });
});

test('EMPTY_TIME_SCALE maps nothing', () => {
  expect(EMPTY_TIME_SCALE.timeToSlotCoordinate(open0)).toBeNull();
  expect(EMPTY_TIME_SCALE.slotCoordinateToTime(0)).toBeNull();
  expect(EMPTY_TIME_SCALE.toSlot(open0)).toBeNull();
});
