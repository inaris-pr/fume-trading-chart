import { describe, expect, test } from 'vitest';
import { aggregateBars } from '../src/aggregate.ts';
import {
  buildCanonicalBars,
  canonicalBucketEnd,
  canonicalSlotsBefore,
  nestsExactly,
  selectBaseInterval,
} from '../src/history.ts';
import { resolveWeeklySessions } from '../src/sessions.ts';
import { createSessionTimeScale, slotSpecForTimeframe } from '../src/time-scale.ts';
import { generateSyntheticBars } from '../src/fixtures/index.ts';
import type { Bar, MarketSession } from '../src/index.ts';
import { EQUITY_SPEC, HOUR, MIN, TEST_ID } from './helpers.ts';

const sessions = resolveWeeklySessions({
  instrumentId: TEST_ID,
  spec: EQUITY_SPEC,
  from: '2026-03-05',
  to: '2026-03-10',
}); // Thu, Fri, Mon, Tue (DST change on Sunday 2026-03-08)

/** Friday closes early at 13:00 local (a calendar-driven early close). */
const earlyClose: MarketSession[] = sessions.map((s) =>
  s.sessionDate === '2026-03-06'
    ? {
        ...s,
        windows: s.windows.map((w) =>
          w.kind === 'regular' ? { ...w, end: w.start + 3.5 * HOUR } : w,
        ),
      }
    : s,
);

const minuteBars = (s: readonly MarketSession[]) =>
  generateSyntheticBars({
    seed: 7,
    sessions: s,
    sessionMode: 'regular',
    durationMs: MIN,
    count: 390 * s.length,
    startPrice: 250,
    tickSize: 0.01,
    walk: 'multiplicative',
    volatility: 0.001,
    gapVolatility: 0.01,
    dojiProbability: 0.05,
    longWickProbability: 0.02,
    baseVolume: 1000,
    dropIndices: [3, 50, 51, 400],
  }).filter((b) => canonicalBucketEnd(b.start, '1m', s, 'regular') !== null);

/** Epoch-aligned coarser base bars built from minutes (what a provider's 15Min endpoint serves). */
function baseFrom(minutes: readonly Bar[], baseMinutes: number): Bar[] {
  const out: Bar[] = [];
  for (const m of minutes) {
    const start = Math.floor(m.start / (baseMinutes * MIN)) * baseMinutes * MIN;
    const last = out[out.length - 1];
    if (last && last.start === start) {
      last.high = Math.max(last.high, m.high);
      last.low = Math.min(last.low, m.low);
      last.close = m.close;
      last.volume += m.volume;
    } else out.push({ ...m, start });
  }
  return out;
}

const after = Date.UTC(2030, 0, 1);
const thuOpen = Date.UTC(2026, 2, 5, 14, 30);

describe('base-interval selection', () => {
  test('15m nests into every RTH timeframe (09:30 and 16:00 are 15-minute boundaries)', () => {
    for (const tf of ['15m', '1h', '4h', '1d'] as const) {
      expect(nestsExactly(15, tf, sessions, 'regular'), tf).toBe(true);
      expect(selectBaseInterval([1, 5, 15], tf, sessions, 'regular'), tf).toBe(15);
    }
    expect(selectBaseInterval([1, 5, 15], '5m', sessions, 'regular')).toBe(5);
    expect(selectBaseInterval([1, 5, 15], '1m', sessions, 'regular')).toBe(1);
  });

  test('an early close at 13:00 still nests 15m; a 13:10 close forces a finer base', () => {
    expect(selectBaseInterval([1, 5, 15], '1h', earlyClose, 'regular')).toBe(15);
    const odd = earlyClose.map((s) =>
      s.sessionDate === '2026-03-06'
        ? {
            ...s,
            windows: s.windows.map((w) =>
              w.kind === 'regular' ? { ...w, end: w.end + 10 * MIN } : w,
            ),
          }
        : s,
    );
    expect(nestsExactly(15, '1h', odd, 'regular')).toBe(false);
    expect(selectBaseInterval([1, 5, 15], '1h', odd, 'regular')).toBe(5);
    expect(selectBaseInterval([1, 15], '1h', odd, 'regular')).toBe(1);
  });

  test('a base that does not divide the timeframe is rejected; 1m is the fallback', () => {
    expect(nestsExactly(10, '15m', sessions, 'regular')).toBe(false);
    expect(selectBaseInterval([1, 10], '15m', sessions, 'regular')).toBe(1);
    expect(() => selectBaseInterval([5, 15], '1h', sessions, 'regular')).toThrow(/1-minute/);
  });

  test('only verified intervals are used: a provider declaring [1] always gets 1m', () => {
    for (const tf of ['1m', '5m', '15m', '1h', '4h', '1d'] as const)
      expect(selectBaseInterval([1], tf, sessions, 'regular')).toBe(1);
  });
});

describe('canonical bucket ends', () => {
  test('1h: short 15:30-16:00 final bucket; 4h: 13:30-16:00; 1d: session end', () => {
    const close = thuOpen + 6.5 * HOUR;
    expect(canonicalBucketEnd(thuOpen, '1h', sessions, 'regular')).toBe(thuOpen + HOUR);
    expect(canonicalBucketEnd(thuOpen + 6 * HOUR, '1h', sessions, 'regular')).toBe(close);
    expect(canonicalBucketEnd(thuOpen + 4 * HOUR, '4h', sessions, 'regular')).toBe(close);
    expect(canonicalBucketEnd(thuOpen, '1d', sessions, 'regular')).toBe(close);
    expect(canonicalBucketEnd(thuOpen - MIN, '1h', sessions, 'regular')).toBeNull();
  });

  test('early close clips the last 1h and 4h buckets at 13:00', () => {
    const friOpen = Date.UTC(2026, 2, 6, 14, 30);
    const close = friOpen + 3.5 * HOUR;
    expect(canonicalBucketEnd(friOpen + 3 * HOUR, '1h', earlyClose, 'regular')).toBe(close);
    expect(canonicalBucketEnd(friOpen, '4h', earlyClose, 'regular')).toBe(close);
  });

  test('canonical slot counts per session', () => {
    const thu = sessions[0]!;
    const before = Number.MAX_SAFE_INTEGER;
    expect(canonicalSlotsBefore(thu, '1m', 'regular', before)).toBe(390);
    expect(canonicalSlotsBefore(thu, '15m', 'regular', before)).toBe(26);
    expect(canonicalSlotsBefore(thu, '1h', 'regular', before)).toBe(7);
    expect(canonicalSlotsBefore(thu, '4h', 'regular', before)).toBe(2);
    expect(canonicalSlotsBefore(thu, '1d', 'regular', before)).toBe(1);
    expect(canonicalSlotsBefore(thu, '1h', 'regular', thuOpen + 90 * MIN)).toBe(2);
    expect(canonicalSlotsBefore(thu, '1d', 'regular', thuOpen)).toBe(0);
    expect(canonicalSlotsBefore(earlyClose[1]!, '1h', 'regular', before)).toBe(4);
  });
});

describe('canonical history from base bars', () => {
  for (const [label, s] of [
    ['normal week (DST change)', sessions],
    ['with an early close', earlyClose],
  ] as const) {
    test(`${label}: canonical 1h/4h/1d from 15m base equal those from 1m base (OHLCV exact)`, () => {
      const minutes = minuteBars(s);
      const fifteen = baseFrom(minutes, 15);
      for (const tf of ['15m', '1h', '4h', '1d'] as const) {
        const fromMinutes = buildCanonicalBars({
          baseBars: minutes,
          baseIntervalMinutes: 1,
          sessions: s,
          timeframe: tf,
          mode: 'regular',
          asOf: after,
        }).bars;
        const fromFifteen = buildCanonicalBars({
          baseBars: fifteen,
          baseIntervalMinutes: 15,
          sessions: s,
          timeframe: tf,
          mode: 'regular',
          asOf: after,
        }).bars;
        expect(fromFifteen, tf).toEqual(fromMinutes);
      }
    });
  }

  test('uses the shared aggregateBars (identical output when everything has ended)', () => {
    const minutes = minuteBars(sessions);
    const target = createSessionTimeScale({
      sessions,
      sessionMode: 'regular',
      slot: slotSpecForTimeframe('1h'),
    });
    const direct = aggregateBars({ bars: minutes, sourceDurationMs: MIN, target }).bars;
    const built = buildCanonicalBars({
      baseBars: minutes,
      baseIntervalMinutes: 1,
      sessions,
      timeframe: '1h',
      mode: 'regular',
      asOf: after,
    }).bars;
    expect(built).toEqual(direct);
    expect(
      built
        .filter((b) => b.start >= thuOpen && b.start < thuOpen + 6.5 * HOUR)
        .map((b) => (b.start - thuOpen) / HOUR),
    ).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  test('a bucket that has not ended is provisional even if every base bar is final', () => {
    const minutes = minuteBars(sessions).filter((b) => b.start < thuOpen + 95 * MIN);
    const asOf = thuOpen + 95 * MIN; // 11:05: 09:30 and 10:30 buckets... 10:30 has not ended
    const bars = buildCanonicalBars({
      baseBars: minutes,
      baseIntervalMinutes: 1,
      sessions,
      timeframe: '1h',
      mode: 'regular',
      asOf,
    }).bars;
    expect(bars.map((b) => b.status)).toEqual(['final', 'provisional']);
    expect(bars[1]!.start).toBe(thuOpen + HOUR);
    // Exactly at the bucket end it is final.
    const atEnd = buildCanonicalBars({
      baseBars: minutes.filter((b) => b.start < thuOpen + HOUR),
      baseIntervalMinutes: 1,
      sessions,
      timeframe: '1h',
      mode: 'regular',
      asOf: thuOpen + HOUR,
    }).bars;
    expect(atEnd.map((b) => b.status)).toEqual(['final']);
  });

  test('a provisional base bar keeps its ended bucket provisional; nothing is fabricated', () => {
    const minutes = minuteBars(sessions).filter((b) => b.start < thuOpen + 60 * MIN);
    minutes[minutes.length - 1] = { ...minutes[minutes.length - 1]!, status: 'provisional' };
    const bars = buildCanonicalBars({
      baseBars: minutes,
      baseIntervalMinutes: 1,
      sessions,
      timeframe: '1d',
      mode: 'regular',
      asOf: after,
    }).bars;
    expect(bars).toHaveLength(1);
    expect(bars[0]!.status).toBe('provisional');
    expect(bars[0]!.volume).toBe(minutes.reduce((n, b) => n + b.volume, 0));
  });

  test('base bars outside regular windows are dropped and counted', () => {
    const pre: Bar = { ...minuteBars(sessions)[0]!, start: thuOpen - 15 * MIN };
    const base = [pre, ...baseFrom(minuteBars(sessions), 15)];
    const result = buildCanonicalBars({
      baseBars: base,
      baseIntervalMinutes: 15,
      sessions,
      timeframe: '1h',
      mode: 'regular',
      asOf: after,
    });
    expect(result.droppedOutsideSession).toBe(1);
  });

  test('a base bar straddling a canonical boundary throws', () => {
    const odd = { ...minuteBars(sessions)[0]!, start: thuOpen + 50 * MIN };
    expect(() =>
      buildCanonicalBars({
        baseBars: [odd],
        baseIntervalMinutes: 15,
        sessions,
        timeframe: '1h',
        mode: 'regular',
        asOf: after,
      }),
    ).toThrow(/straddles/);
  });
});
