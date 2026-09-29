import { describe, expect, test } from 'vitest';
import {
  createRng,
  generateSyntheticBars,
  type SyntheticBarsOptions,
} from '../src/fixtures/index.ts';
import { resolveWeeklySessions } from '../src/sessions.ts';
import { createSessionTimeScale } from '../src/time-scale.ts';
import type { Bar } from '../src/index.ts';
import { EQUITY_SPEC, MIN, TEST_ID } from './helpers.ts';

const sessions = resolveWeeklySessions({
  instrumentId: TEST_ID,
  spec: EQUITY_SPEC,
  from: '2026-03-02',
  to: '2026-03-31',
});

const SPY_LIKE: SyntheticBarsOptions = {
  seed: 20260302,
  sessions,
  sessionMode: 'regular',
  durationMs: 5 * MIN,
  count: 780,
  startPrice: 574.25,
  tickSize: 0.01,
  walk: 'multiplicative',
  volatility: 0.0008,
  gapVolatility: 0.0045,
  dojiProbability: 0.05,
  longWickProbability: 0.03,
  baseVolume: 42_000,
};

/** Order-sensitive checksum of every numeric field. */
function checksum(bars: readonly Bar[]): number {
  let h = 0;
  for (const b of bars) {
    for (const v of [b.start, b.open, b.high, b.low, b.close, b.volume]) {
      h = (Math.imul(h, 31) + Math.round(v * 100)) | 0;
    }
  }
  return h;
}

describe('seeded RNG', () => {
  test('same seed, same sequence; different seed, different sequence', () => {
    const a = createRng(42);
    const b = createRng(42);
    const c = createRng(43);
    const seqA = Array.from({ length: 5 }, () => a.next());
    expect(Array.from({ length: 5 }, () => b.next())).toEqual(seqA);
    expect(Array.from({ length: 5 }, () => c.next())).not.toEqual(seqA);
    expect(seqA.every((x) => x >= 0 && x < 1)).toBe(true);
  });
});

describe('generateSyntheticBars', () => {
  const bars = generateSyntheticBars(SPY_LIKE);

  test('is deterministic across runs', () => {
    expect(generateSyntheticBars(SPY_LIKE)).toEqual(bars);
  });

  test('golden checksum (fails if the generator changes; update deliberately)', () => {
    expect(bars).toHaveLength(780);
    expect(bars[0]!.start).toBe(Date.UTC(2026, 2, 2, 14, 30));
    expect(bars[0]!.open).toBe(574.25);
    expect(checksum(bars)).toMatchInlineSnapshot(`1703114227`);
  });

  test('a shorter count is an exact prefix', () => {
    expect(generateSyntheticBars({ ...SPY_LIKE, count: 100 })).toEqual(bars.slice(0, 100));
  });

  test('OHLC invariants and tick grid', () => {
    for (const b of bars) {
      expect(b.high).toBeGreaterThanOrEqual(Math.max(b.open, b.close));
      expect(b.low).toBeLessThanOrEqual(Math.min(b.open, b.close));
      expect(b.low).toBeGreaterThan(0);
      for (const p of [b.open, b.high, b.low, b.close]) {
        expect(Math.abs(p * 100 - Math.round(p * 100))).toBeLessThan(1e-6);
      }
      expect(Number.isInteger(b.volume) && b.volume > 0).toBe(true);
      expect(b.status).toBe('final');
    }
  });

  test('every bar sits on a session-aligned 5m bucket', () => {
    const map = createSessionTimeScale({
      sessions,
      sessionMode: 'regular',
      slot: { kind: 'intraday', durationMs: 5 * MIN },
    });
    bars.forEach((b, i) => expect(map.toSlot(b.start)).toBe(i));
  });

  test('contains the variety the chart must handle', () => {
    const up = bars.filter((b) => b.close > b.open).length;
    const down = bars.filter((b) => b.close < b.open).length;
    const doji = bars.filter((b) => b.close === b.open).length;
    const bodies = bars.map((b) => Math.abs(b.close - b.open)).sort((a, b) => a - b);
    const medianBody = bodies[Math.floor(bodies.length / 2)]!;
    const longWicks = bars.filter(
      (b) =>
        b.high - Math.max(b.open, b.close) > 4 * medianBody ||
        Math.min(b.open, b.close) - b.low > 4 * medianBody,
    ).length;
    const sessionGaps = bars.filter(
      (b, i) => i > 0 && i % 78 === 0 && b.open !== bars[i - 1]!.close,
    ).length;
    const volumes = bars.map((b) => b.volume);
    expect(up).toBeGreaterThan(200);
    expect(down).toBeGreaterThan(200);
    expect(doji).toBeGreaterThan(10);
    expect(longWicks).toBeGreaterThan(5);
    expect(sessionGaps).toBeGreaterThanOrEqual(8);
    expect(Math.max(...volumes) / Math.min(...volumes)).toBeGreaterThan(5);
  });

  test('dropIndices removes bars without shifting the rest', () => {
    const dropped = generateSyntheticBars({ ...SPY_LIKE, dropIndices: [700] });
    expect(dropped).toHaveLength(779);
    expect(dropped[699]).toEqual(bars[699]);
    expect(dropped[700]).toEqual(bars[701]);
  });

  test('additive walk can cross zero', () => {
    const neg = generateSyntheticBars({
      ...SPY_LIKE,
      startPrice: 2,
      walk: 'additive',
      volatility: 0.02,
      gapVolatility: 0.05,
      drift: -0.01,
    });
    expect(neg.some((b) => b.close > 0)).toBe(true);
    expect(neg.some((b) => b.close < 0)).toBe(true);
  });
});
