/**
 * Per-second provider aggregates (1s bar events) in the live aggregator: a feed without individual
 * trades drives the provisional minute with seconds, and the provider's 1m bar finalizes it.
 * Sessions are futures-style (one window crossing midnight, trading day = the day it ends).
 */
import { describe, expect, test } from 'vitest';
import {
  createSessionTimeScale,
  LiveCandleAggregator,
  slotSpecForTimeframe,
  type Bar,
  type MarketEvent,
  type MarketSession,
  type TimeframeId,
} from '../src/index.ts';
import { MIN, TEST_ID } from './helpers.ts';

const SEC = 1_000;
const HOUR = 60 * MIN;
/** Globex-style session for 2026-09-30: 2026-09-29 22:00Z -> 2026-09-30 21:00Z. */
const OPEN = Date.UTC(2026, 8, 29, 22, 0);
const CLOSE = Date.UTC(2026, 8, 30, 21, 0);
const SESSIONS: MarketSession[] = [
  {
    instrumentId: TEST_ID,
    sessionDate: '2026-09-30',
    windows: [{ start: OPEN, end: CLOSE, kind: 'regular' }],
  },
  {
    instrumentId: TEST_ID,
    sessionDate: '2026-10-01',
    windows: [{ start: CLOSE + HOUR, end: CLOSE + 24 * HOUR, kind: 'regular' }],
  },
];

const scale = (tf: TimeframeId) =>
  createSessionTimeScale({
    sessions: SESSIONS,
    sessionMode: 'regular',
    slot: slotSpecForTimeframe(tf),
  });

function bar(
  start: number,
  o: number,
  h: number,
  l: number,
  c: number,
  v: number,
  n?: number,
): Bar {
  return {
    start,
    open: o,
    high: h,
    low: l,
    close: c,
    volume: v,
    ...(n !== undefined ? { tradeCount: n } : {}),
    status: 'provisional',
    revision: 0,
  };
}
const second = (b: Bar): MarketEvent => ({
  kind: 'bar',
  instrumentId: TEST_ID,
  interval: '1s',
  phase: 'provisional',
  bar: b,
});
const minute = (b: Bar): MarketEvent => ({
  kind: 'bar',
  instrumentId: TEST_ID,
  interval: '1m',
  phase: 'final',
  bar: { ...b, status: 'final' },
});

function seeded(): LiveCandleAggregator {
  const agg = new LiveCandleAggregator({ instrumentId: TEST_ID, minuteScale: scale('1m') });
  agg.seedOfficialMinutes([], OPEN);
  return agg;
}

const M = Date.UTC(2026, 8, 30, 17, 30); // a minute inside the session

describe('1s aggregates -> provisional 1m candle', () => {
  test('seconds fold into one provisional minute (open first, close last, extremes, sums)', () => {
    const agg = seeded();
    const changed = agg.apply([
      second(bar(M + 2 * SEC, 100, 101, 99.5, 100.5, 3, 2)),
      second(bar(M + 5 * SEC, 100.5, 102, 100.25, 101.75, 4, 3)),
      second(bar(M + 9 * SEC, 101.75, 101.75, 98, 98.5, 1, 1)),
    ]);
    expect(changed).toEqual([M]);
    expect(agg.effectiveMinute(M)).toEqual(bar(M, 100, 102, 98, 98.5, 8, 6));
    expect(agg.diagnostics().acceptedSecondBars).toBe(3);
  });

  test('arrival order does not matter; missing seconds are not fabricated', () => {
    const a = seeded();
    const b = seeded();
    const s1 = second(bar(M + 1 * SEC, 10, 11, 9, 10, 1));
    const s2 = second(bar(M + 30 * SEC, 10, 12, 10, 12, 2));
    a.apply([s1, s2]);
    b.apply([s2, s1]);
    expect(a.effectiveMinute(M)).toEqual(b.effectiveMinute(M));
    expect(a.effectiveMinute(M)).toEqual(bar(M, 10, 12, 9, 12, 3));
    // No bar for a minute that had no seconds.
    expect(a.effectiveMinute(M + MIN)).toBeNull();
  });

  test('a re-delivered second replaces the stored one (no double counting)', () => {
    const agg = seeded();
    agg.apply([second(bar(M, 5, 5, 5, 5, 2))]);
    agg.apply([second(bar(M, 5, 6, 5, 6, 3))]);
    expect(agg.effectiveMinute(M)).toEqual(bar(M, 5, 6, 5, 6, 3));
    expect(agg.diagnostics().replacedSecondBars).toBe(1);
  });

  test('tradeCount is kept only when every second has one', () => {
    const agg = seeded();
    agg.apply([second(bar(M, 1, 1, 1, 1, 1, 1)), second(bar(M + SEC, 1, 1, 1, 1, 1))]);
    expect(agg.effectiveMinute(M)!.tradeCount).toBeUndefined();
  });

  test('seconds outside every session window are ignored and counted', () => {
    const agg = seeded();
    const inBreak = CLOSE + 10 * MIN; // daily maintenance break
    expect(agg.apply([second(bar(inBreak, 1, 1, 1, 1, 1))])).toEqual([]);
    expect(agg.diagnostics().outsideSessionSeconds).toBe(1);
  });

  test('a misaligned or non-finite second is ignored', () => {
    const agg = seeded();
    expect(agg.apply([second(bar(M + 500, 1, 1, 1, 1, 1))])).toEqual([]);
    expect(agg.apply([second(bar(M, Number.NaN, 1, 1, 1, 1))])).toEqual([]);
  });
});

describe('authoritative minute replacement', () => {
  test('the provider 1m bar replaces the second-built minute and later seconds are ignored', () => {
    const agg = seeded();
    agg.apply([second(bar(M, 100, 101, 100, 101, 2)), second(bar(M + SEC, 101, 103, 101, 102, 5))]);
    const official = bar(M, 100, 104, 99, 103, 20, 12);
    expect(agg.apply([minute(official)])).toEqual([M]);
    expect(agg.effectiveMinute(M)).toEqual({ ...official, status: 'final' });
    expect(agg.apply([second(bar(M + 59 * SEC, 1, 1, 1, 1, 1))])).toEqual([]);
    expect(agg.effectiveMinute(M)!.close).toBe(103);
    expect(agg.diagnostics().secondsAfterOfficial).toBe(1);
  });

  test('a duplicate final minute is stale (first authoritative bar wins at equal revision)', () => {
    const agg = seeded();
    agg.apply([minute(bar(M, 1, 2, 1, 2, 5))]);
    expect(agg.apply([minute(bar(M, 1, 2, 1, 2, 5))])).toEqual([]);
    expect(agg.diagnostics().staleOfficialBars).toBe(1);
  });
});

describe('higher timeframes re-fold from canonical minutes (session-aligned, not UTC)', () => {
  test('1h and 4h buckets follow the session start (22:00Z), not UTC clock hours', () => {
    const agg = seeded();
    // Two minutes in the first hour of the session and one in the second.
    agg.apply([
      minute(bar(OPEN, 10, 11, 9, 10, 1)),
      minute(bar(OPEN + 59 * MIN, 10, 15, 10, 14, 2)),
    ]);
    const changed = agg.apply([second(bar(OPEN + HOUR + 3 * SEC, 14, 16, 13, 15, 4))]);
    const h1 = agg.foldBuckets(scale('1h'), [OPEN, OPEN + 59 * MIN, ...changed]);
    expect(h1.map((b) => b.start)).toEqual([OPEN, OPEN + HOUR]);
    expect(h1[0]).toMatchObject({ open: 10, high: 15, low: 9, close: 14, volume: 3 });
    expect(h1[1]).toMatchObject({ open: 14, close: 15, volume: 4, status: 'provisional' });
    const h4 = agg.foldBuckets(scale('4h'), changed);
    expect(h4).toHaveLength(1);
    expect(h4[0]).toMatchObject({ start: OPEN, open: 10, high: 16, low: 9, close: 15, volume: 7 });
  });

  test('the daily candle spans the whole cross-midnight session', () => {
    const agg = seeded();
    agg.apply([minute(bar(OPEN, 10, 10, 10, 10, 1))]);
    const changed = agg.apply([second(bar(CLOSE - MIN, 20, 21, 19, 21, 2))]);
    const [daily] = agg.foldBuckets(scale('1d'), changed);
    expect(daily).toMatchObject({ start: OPEN, open: 10, high: 21, low: 10, close: 21, volume: 3 });
  });
});
