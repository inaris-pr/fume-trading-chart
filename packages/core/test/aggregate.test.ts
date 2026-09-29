import { describe, expect, test } from 'vitest';
import { aggregateBars } from '../src/aggregate.ts';
import { resolveWeeklySessions } from '../src/sessions.ts';
import { createSessionTimeScale, slotSpecForTimeframe, type SlotSpec } from '../src/time-scale.ts';
import { generateSyntheticBars } from '../src/fixtures/index.ts';
import type { Bar, MarketSession } from '../src/index.ts';
import { EQUITY_SPEC, FUTURES_SPEC, HOUR, MIN, TEST_ID } from './helpers.ts';

const sessions = resolveWeeklySessions({
  instrumentId: TEST_ID,
  spec: EQUITY_SPEC,
  from: '2026-03-05',
  to: '2026-03-10',
}); // Thu, Fri, Mon, Tue (DST change on Sunday 2026-03-08)

const mapping = (slot: SlotSpec, s: readonly MarketSession[] = sessions) =>
  createSessionTimeScale({ sessions: s, sessionMode: 'regular', slot });

const minuteBars = (count = sessions.length * 390, dropIndices: number[] = []) =>
  generateSyntheticBars({
    seed: 99,
    sessions,
    sessionMode: 'regular',
    durationMs: MIN,
    count,
    startPrice: 100,
    tickSize: 0.01,
    walk: 'multiplicative',
    volatility: 0.001,
    gapVolatility: 0.01,
    dojiProbability: 0.05,
    longWickProbability: 0.02,
    baseVolume: 1000,
    dropIndices,
  });

const bar = (start: number, o: number, h: number, l: number, c: number, v = 1): Bar => ({
  start,
  open: o,
  high: h,
  low: l,
  close: c,
  volume: v,
  status: 'final',
  revision: 0,
});

const open = Date.UTC(2026, 2, 5, 14, 30); // Thu 09:30 EST

/** Reference: brute-force fold of minutes whose start lies in [from, to). */
function fold(minutes: readonly Bar[], from: number, to: number) {
  const inside = minutes.filter((m) => m.start >= from && m.start < to);
  if (inside.length === 0) return null;
  return {
    open: inside[0]!.open,
    high: Math.max(...inside.map((m) => m.high)),
    low: Math.min(...inside.map((m) => m.low)),
    close: inside[inside.length - 1]!.close,
    volume: inside.reduce((n, m) => n + m.volume, 0),
  };
}

describe('aggregateBars: OHLCV rules', () => {
  test('open first, high max, low min, close last, volume summed', () => {
    const m = mapping({ kind: 'intraday', durationMs: 5 * MIN });
    const input = [
      bar(open, 10, 11, 9.5, 10.5, 100),
      bar(open + MIN, 10.5, 12, 10, 11, 200),
      bar(open + 2 * MIN, 11, 11.2, 8, 9, 300),
    ];
    const { bars } = aggregateBars({ bars: input, sourceDurationMs: MIN, target: m });
    expect(bars).toEqual([
      {
        start: open,
        open: 10,
        high: 12,
        low: 8,
        close: 9,
        volume: 600,
        status: 'final',
        revision: 0,
      },
    ]);
  });

  test('tradeCount and vwap only when every input has them', () => {
    const m = mapping({ kind: 'intraday', durationMs: 5 * MIN });
    const withExtras = [
      { ...bar(open, 1, 1, 1, 1, 100), tradeCount: 3, vwap: 10 },
      { ...bar(open + MIN, 1, 1, 1, 1, 300), tradeCount: 5, vwap: 20 },
    ];
    const [a] = aggregateBars({ bars: withExtras, sourceDurationMs: MIN, target: m }).bars;
    expect(a!.tradeCount).toBe(8);
    expect(a!.vwap).toBeCloseTo(17.5, 12);
    const mixed = [withExtras[0]!, bar(open + MIN, 1, 1, 1, 1, 300)];
    const [b] = aggregateBars({ bars: mixed, sourceDurationMs: MIN, target: m }).bars;
    expect(b).not.toHaveProperty('tradeCount');
    expect(b).not.toHaveProperty('vwap');
  });

  test('a provisional input makes the bucket provisional', () => {
    const m = mapping({ kind: 'intraday', durationMs: 5 * MIN });
    const input = [
      bar(open, 1, 1, 1, 1),
      { ...bar(open + MIN, 1, 1, 1, 1), status: 'provisional' as const },
    ];
    expect(aggregateBars({ bars: input, sourceDurationMs: MIN, target: m }).bars[0]!.status).toBe(
      'provisional',
    );
  });
});

describe('aggregateBars: canonical session-aligned buckets from 1m', () => {
  const minutes = minuteBars();

  test.each([
    ['5m', 5, 78],
    ['15m', 15, 26],
    ['1h', 60, 7],
  ] as const)(
    '1m -> %s: %d-minute buckets, %d per session, matching a brute-force fold',
    (_, mins, perSession) => {
      const m = mapping({ kind: 'intraday', durationMs: mins * MIN });
      const { bars, droppedOutsideSession } = aggregateBars({
        bars: minutes,
        sourceDurationMs: MIN,
        target: m,
      });
      expect(droppedOutsideSession).toBe(0);
      expect(bars).toHaveLength(perSession * sessions.length);
      for (const [i, b] of bars.entries()) {
        expect(m.toSlot(b.start)).toBe(i);
        const sessionEnd = sessions
          .find((s) => s.windows.some((w) => b.start >= w.start && b.start < w.end))!
          .windows.find((w) => w.kind === 'regular')!.end;
        const expected = fold(minutes, b.start, Math.min(b.start + mins * MIN, sessionEnd))!;
        expect(b).toMatchObject(expected);
      }
    },
  );

  test('1h buckets are 09:30, 10:30, ... 14:30 and a SHORT 15:30-16:00', () => {
    const m = mapping({ kind: 'intraday', durationMs: HOUR });
    const { bars } = aggregateBars({ bars: minutes, sourceDurationMs: MIN, target: m });
    const firstDay = bars.slice(0, 7);
    expect(firstDay.map((b) => b.start)).toEqual([0, 1, 2, 3, 4, 5, 6].map((i) => open + i * HOUR));
    // The short last bucket holds exactly 30 minutes.
    const last = firstDay[6]!;
    expect(last.volume).toBe(fold(minutes, open + 6 * HOUR, open + 6.5 * HOUR)!.volume);
    expect(
      minutes.filter((x) => x.start >= last.start && x.start < open + 6.5 * HOUR),
    ).toHaveLength(30);
  });

  test('1m -> 1d: one bar per session, never merged across sessions', () => {
    const m = mapping({ kind: 'session' });
    const { bars } = aggregateBars({ bars: minutes, sourceDurationMs: MIN, target: m });
    expect(bars).toHaveLength(sessions.length);
    for (const [i, s] of sessions.entries()) {
      const w = s.windows.find((x) => x.kind === 'regular')!;
      expect(bars[i]!.start).toBe(w.start);
      expect(bars[i]).toMatchObject(fold(minutes, w.start, w.end)!);
    }
    // Session boundary: Thursday's close and Friday's open come from different bars.
    expect(bars[1]!.open).toBe(minutes[390]!.open);
    expect(bars[0]!.close).toBe(minutes[389]!.close);
  });

  test('DST: Monday after the change still starts at 09:30 local (13:30 UTC)', () => {
    const m = mapping({ kind: 'intraday', durationMs: HOUR });
    const { bars } = aggregateBars({ bars: minutes, sourceDurationMs: MIN, target: m });
    expect(bars[14]!.start).toBe(Date.UTC(2026, 2, 9, 13, 30));
  });

  test('5m -> 1h gives the same result as 1m -> 1h (nesting)', () => {
    const m5 = mapping({ kind: 'intraday', durationMs: 5 * MIN });
    const m1h = mapping({ kind: 'intraday', durationMs: HOUR });
    const fives = aggregateBars({ bars: minutes, sourceDurationMs: MIN, target: m5 }).bars;
    const viaFives = aggregateBars({ bars: fives, sourceDurationMs: 5 * MIN, target: m1h }).bars;
    const direct = aggregateBars({ bars: minutes, sourceDurationMs: MIN, target: m1h }).bars;
    expect(
      viaFives.map(({ start, open: o, high, low, close, volume }) => ({
        start,
        o,
        high,
        low,
        close,
        volume,
      })),
    ).toEqual(
      direct.map(({ start, open: o, high, low, close, volume }) => ({
        start,
        o,
        high,
        low,
        close,
        volume,
      })),
    );
  });

  test('deterministic output', () => {
    const m = mapping({ kind: 'intraday', durationMs: 15 * MIN });
    const a = aggregateBars({ bars: minuteBars(), sourceDurationMs: MIN, target: m });
    const b = aggregateBars({ bars: minuteBars(), sourceDurationMs: MIN, target: m });
    expect(a).toEqual(b);
  });
});

describe('aggregateBars: gaps and boundaries', () => {
  test('missing minutes: remaining minutes still aggregate; fully empty buckets produce no bar', () => {
    // Drop 09:30-09:44 of the first session entirely, plus one minute inside 09:45-09:59.
    const drop = [...Array.from({ length: 15 }, (_, i) => i), 20];
    const minutes = minuteBars(390, drop);
    const m = mapping({ kind: 'intraday', durationMs: 15 * MIN });
    const { bars } = aggregateBars({ bars: minutes, sourceDurationMs: MIN, target: m });
    expect(bars).toHaveLength(25);
    expect(bars[0]!.start).toBe(open + 15 * MIN); // no bar invented for 09:30
    expect(m.toSlot(bars[0]!.start)).toBe(1); // the empty slot 0 stays a gap
    expect(bars[0]!.volume).toBe(fold(minutes, open + 15 * MIN, open + 30 * MIN)!.volume);
  });

  test('bars outside the open windows (extended hours in regular mode) are dropped and counted', () => {
    const m = mapping({ kind: 'intraday', durationMs: 5 * MIN });
    const pre = bar(open - 30 * MIN, 1, 1, 1, 1);
    const post = bar(open + 400 * MIN, 1, 1, 1, 1);
    const inside = bar(open, 2, 2, 2, 2);
    const r = aggregateBars({ bars: [pre, inside, post], sourceDurationMs: MIN, target: m });
    expect(r.bars).toHaveLength(1);
    expect(r.droppedOutsideSession).toBe(2);
  });

  test('a source bar straddling a target boundary is a configuration error', () => {
    const m = mapping({ kind: 'intraday', durationMs: HOUR });
    // 15-minute bars anchored at 09:00 would straddle 09:30-aligned hours if placed at 10:15...
    const straddler = bar(open + 50 * MIN, 1, 1, 1, 1); // 10:20-10:35 crosses 10:30
    expect(() =>
      aggregateBars({ bars: [straddler], sourceDurationMs: 15 * MIN, target: m }),
    ).toThrow(/straddles/);
  });

  test('input must be strictly ascending', () => {
    const m = mapping({ kind: 'intraday', durationMs: 5 * MIN });
    expect(() =>
      aggregateBars({
        bars: [bar(open + MIN, 1, 1, 1, 1), bar(open, 1, 1, 1, 1)],
        sourceDurationMs: MIN,
        target: m,
      }),
    ).toThrow(/ascending/);
  });

  test('early-close compatible: a shortened window clips the last hourly bucket', () => {
    // Simulate a 13:00 early close by editing the resolved session (calendar rules come later).
    const early = sessions.map((s, i) =>
      i === 0
        ? {
            ...s,
            windows: s.windows.map((w) =>
              w.kind === 'regular' ? { ...w, end: open + 3.5 * HOUR } : w,
            ),
          }
        : s,
    );
    const m = mapping({ kind: 'intraday', durationMs: HOUR }, early);
    const minutes = minuteBars(210); // 09:30-13:00 of the first session
    const { bars } = aggregateBars({ bars: minutes, sourceDurationMs: MIN, target: m });
    expect(bars.map((b) => (b.start - open) / MIN)).toEqual([0, 60, 120, 180]);
    expect(bars[3]!.volume).toBe(fold(minutes, open + 180 * MIN, open + 210 * MIN)!.volume); // 12:30-13:00
  });

  test('futures-style session: buckets never cross the scheduled break', () => {
    const fut = resolveWeeklySessions({
      instrumentId: TEST_ID,
      spec: FUTURES_SPEC,
      from: '2026-03-02',
      to: '2026-03-02',
    });
    const m = createSessionTimeScale({
      sessions: fut,
      sessionMode: 'regular',
      slot: { kind: 'intraday', durationMs: HOUR },
    });
    const breakStart = fut[0]!.windows[0]!.end; // 08:00 CT
    const before = bar(breakStart - MIN, 1, 2, 0.5, 1.5, 10);
    const after = bar(breakStart + 30 * MIN, 3, 4, 2.5, 3.5, 20);
    const { bars } = aggregateBars({ bars: [before, after], sourceDurationMs: MIN, target: m });
    expect(bars).toHaveLength(2);
    expect(bars[0]!.close).toBe(1.5);
    expect(bars[1]!.open).toBe(3);
  });
});

describe('4H canonical aggregation (session-aligned)', () => {
  const minutes = minuteBars();
  const m4h = mapping(slotSpecForTimeframe('4h'));

  test('two RTH buckets per session: 09:30-13:30 and a SHORT 13:30-16:00', () => {
    const { bars } = aggregateBars({ bars: minutes, sourceDurationMs: MIN, target: m4h });
    expect(bars).toHaveLength(sessions.length * 2);
    expect((bars[0]!.start - open) / MIN).toBe(0);
    expect((bars[1]!.start - open) / MIN).toBe(240);
    expect(bars[0]).toMatchObject(fold(minutes, open, open + 240 * MIN)!);
    expect(bars[1]).toMatchObject(fold(minutes, open + 240 * MIN, open + 390 * MIN)!);
    // The short bucket holds exactly the 150 minutes 13:30-16:00.
    expect(
      minutes.filter((x) => x.start >= bars[1]!.start && x.start < open + 390 * MIN),
    ).toHaveLength(150);
  });

  test('never merges across sessions: each session has its own first bucket at 09:30 local', () => {
    const { bars } = aggregateBars({ bars: minutes, sourceDurationMs: MIN, target: m4h });
    for (const [i, s] of sessions.entries()) {
      const w = s.windows.find((x) => x.kind === 'regular')!;
      expect(bars[2 * i]!.start).toBe(w.start);
      expect(bars[2 * i + 1]!.start).toBe(w.start + 4 * HOUR);
      expect(bars[2 * i + 1]!.close).toBe(minutes[(i + 1) * 390 - 1]!.close);
    }
  });

  test('volume is the sum of the bucket minutes', () => {
    const { bars } = aggregateBars({ bars: minutes, sourceDurationMs: MIN, target: m4h });
    const total = minutes.reduce((n, x) => n + x.volume, 0);
    expect(bars.reduce((n, b) => n + b.volume, 0)).toBe(total);
  });

  test('gaps: an entirely missing afternoon produces no 13:30 bar', () => {
    const afternoon = Array.from({ length: 150 }, (_, i) => 240 + i);
    const gappy = minuteBars(390, afternoon);
    const { bars } = aggregateBars({ bars: gappy, sourceDurationMs: MIN, target: m4h });
    expect(bars).toHaveLength(1);
    expect(bars[0]!.start).toBe(open);
  });

  test('1H -> 4H equals 1m -> 4H (4H nests session-aligned hours)', () => {
    const hours = aggregateBars({
      bars: minutes,
      sourceDurationMs: MIN,
      target: mapping(slotSpecForTimeframe('1h')),
    }).bars;
    // 1h buckets are 60 min except the 30-min 15:30 one, which still fits inside 13:30-16:00.
    const viaHours = aggregateBars({ bars: hours, sourceDurationMs: 30 * MIN, target: m4h }).bars;
    const direct = aggregateBars({ bars: minutes, sourceDurationMs: MIN, target: m4h }).bars;
    expect(viaHours.map((b) => [b.start, b.open, b.high, b.low, b.close, b.volume])).toEqual(
      direct.map((b) => [b.start, b.open, b.high, b.low, b.close, b.volume]),
    );
  });

  test('deterministic', () => {
    const a = aggregateBars({ bars: minuteBars(), sourceDurationMs: MIN, target: m4h });
    const b = aggregateBars({ bars: minuteBars(), sourceDurationMs: MIN, target: m4h });
    expect(a).toEqual(b);
  });
});
