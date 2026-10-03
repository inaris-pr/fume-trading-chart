/**
 * Built-in formulas against hand-computed fixtures and an independent naive reference, warm-up
 * behavior, and the incremental runtime (append, provisional updates, corrections, prepend) being
 * exactly equal to a full calculation.
 */
import { describe, expect, test } from 'vitest';
import {
  calculateIndicator,
  EMA,
  IndicatorSeries,
  RSI,
  SMA,
  SMA_RESYNC,
  VOLUME,
  type IndicatorBar,
  type IndicatorDefinition,
} from '../src/index.ts';

const bar = (close: number, volume = 100, open = close): IndicatorBar => ({
  open,
  high: Math.max(open, close),
  low: Math.min(open, close),
  close,
  volume,
});
const closes = (...values: number[]) => values.map((c) => bar(c));

/** Deterministic pseudo-random walk (LCG), so fixtures never change. */
function walk(count: number, seed = 7): IndicatorBar[] {
  let s = seed;
  let price = 100;
  const out: IndicatorBar[] = [];
  for (let i = 0; i < count; i++) {
    s = (s * 1664525 + 1013904223) % 4294967296;
    const open = price;
    price = Math.max(1, price + (s / 4294967296 - 0.5) * 2);
    out.push({
      open,
      high: Math.max(open, price) + 0.25,
      low: Math.min(open, price) - 0.25,
      close: price,
      volume: 1000 + (s % 5000),
    });
  }
  return out;
}

describe('fixtures (hand-computed)', () => {
  test('SMA(3) of 1..5: no value for the first two bars, then 2, 3, 4', () => {
    expect(calculateIndicator(SMA, { period: 3 }, closes(1, 2, 3, 4, 5)).value!).toEqual([
      null,
      null,
      2,
      3,
      4,
    ]);
  });

  test('EMA(3): alpha 0.5, seeded with the SMA of the first 3 closes', () => {
    expect(calculateIndicator(EMA, { period: 3 }, closes(1, 2, 3, 4, 5)).value!).toEqual([
      null,
      null,
      2,
      3,
      4,
    ]);
    // 2, then 2 + 0.5 * (10 - 2) = 6, then 6 + 0.5 * (0 - 6) = 3
    expect(calculateIndicator(EMA, { period: 3 }, closes(1, 2, 3, 10, 0)).value!).toEqual([
      null,
      null,
      2,
      6,
      3,
    ]);
  });

  test('RSI(2), Wilder: seed 50, then 75 and 87.5', () => {
    // changes: +1, -1, +1, +1 -> seed at i=2: gain .5 loss .5; then (.5+1)/2=.75 / .25; .875 / .125
    expect(calculateIndicator(RSI, { period: 2 }, closes(1, 2, 1, 2, 3)).value!).toEqual([
      null,
      null,
      50,
      75,
      87.5,
    ]);
  });

  test('RSI: completely flat prices are 50 (at the seed and at every later bar)', () => {
    expect(calculateIndicator(RSI, { period: 3 }, closes(5, 5, 5, 5, 5, 5)).value!).toEqual([
      null,
      null,
      null,
      50,
      50,
      50,
    ]);
  });

  test('RSI: only gains are 100', () => {
    expect(
      calculateIndicator(RSI, { period: 3 }, closes(1, 2, 3, 4, 5, 6)).value!.slice(3),
    ).toEqual([100, 100, 100]);
  });

  test('RSI: only losses are 0', () => {
    expect(
      calculateIndicator(RSI, { period: 3 }, closes(9, 8, 7, 6, 5, 4)).value!.slice(3),
    ).toEqual([0, 0, 0]);
  });

  test('RSI: flat data turning into gains and losses stays finite and deterministic', () => {
    // changes: 0, 0, 0, +1, 0, -1. Seed (i=3): both averages 0 -> 50. i=4: gain 1/3, loss 0 -> 100.
    // i=5: gain 2/9, loss 0 -> 100. i=6: gain 4/27, loss 1/3 -> 100 - 100 / (1 + 4/9) = 400/13.
    const bars = closes(5, 5, 5, 5, 6, 6, 5);
    const values = calculateIndicator(RSI, { period: 3 }, bars).value!;
    expect(values.slice(0, 6)).toEqual([null, null, null, 50, 100, 100]);
    expect(values[6]).toBeCloseTo(400 / 13, 10);
    // Flat, then a loss first: 50, then 0.
    expect(calculateIndicator(RSI, { period: 3 }, closes(5, 5, 5, 5, 4)).value!.slice(3)).toEqual([
      50, 0,
    ]);
    // Deterministic: the same input gives the same values, bit for bit.
    expect(calculateIndicator(RSI, { period: 3 }, bars).value!).toEqual(values);
    for (const v of values) if (v !== null) expect(Number.isFinite(v)).toBe(true);
  });

  test('RSI: smoothed averages that both return to zero are 50 again (recursive step)', () => {
    // Period 1 keeps no history, so a flat bar after movement has both averages at exactly zero.
    expect(calculateIndicator(RSI, { period: 1 }, closes(1, 2, 2, 1, 1)).value!).toEqual([
      null,
      100,
      50,
      0,
      50,
    ]);
  });

  test('RSI is always within 0..100', () => {
    for (const v of calculateIndicator(RSI, { period: 14 }, walk(500)).value!)
      if (v !== null) expect(v >= 0 && v <= 100).toBe(true);
  });

  test('Volume is the displayed bar volume, unchanged', () => {
    const bars = [bar(1, 10), bar(2, 0), bar(3, 12345.5)];
    expect(calculateIndicator(VOLUME, {}, bars).volume!).toEqual([10, 0, 12345.5]);
  });
});

describe('against a naive reference on 3000 bars', () => {
  const bars = walk(3000);
  const naiveSma = (n: number) =>
    bars.map((_, i) =>
      i < n - 1 ? null : bars.slice(i - n + 1, i + 1).reduce((s, b) => s + b.close, 0) / n,
    );

  test('SMA matches the windowed average everywhere (resync keeps drift negligible)', () => {
    for (const n of [1, 5, 20, 200]) {
      const got = calculateIndicator(SMA, { period: n }, bars).value!;
      const want = naiveSma(n);
      got.forEach((v, i) => {
        if (want[i] === null) expect(v).toBeNull();
        else expect(v).toBeCloseTo(want[i]!, 9);
      });
    }
    expect(SMA_RESYNC).toBeGreaterThan(0);
  });

  test('no NaN or Infinity is ever returned; warm-up is null, not invented', () => {
    for (const d of [SMA, EMA, RSI, VOLUME]) {
      const params = d.params.length ? { period: 50 } : {};
      const out = calculateIndicator(d, params, bars);
      for (const values of Object.values(out))
        for (const v of values) if (v !== null) expect(Number.isFinite(v)).toBe(true);
    }
    expect(calculateIndicator(SMA, { period: 50 }, bars).value!.slice(0, 49)).toEqual(
      Array(49).fill(null),
    );
    expect(calculateIndicator(RSI, { period: 50 }, bars).value!.slice(0, 50)).toEqual(
      Array(50).fill(null),
    );
    // Fewer bars than the period: nothing at all.
    expect(calculateIndicator(EMA, { period: 50 }, bars.slice(0, 10)).value!).toEqual(
      Array(10).fill(null),
    );
  });
});

describe('incremental runtime equals a full calculation (exactly)', () => {
  const definitions: [IndicatorDefinition, Record<string, number>][] = [
    [SMA, { period: 20 }],
    [EMA, { period: 20 }],
    [RSI, { period: 14 }],
    [VOLUME, {}],
  ];
  const same = (series: IndicatorSeries, bars: readonly IndicatorBar[], d: IndicatorDefinition) => {
    const full = new IndicatorSeries(d, series.params);
    full.update(bars);
    for (let k = 0; k < d.outputs.length; k++)
      for (let i = 0; i < bars.length; i++) expect(series.value(k, i)).toBe(full.value(k, i));
  };

  test.each(definitions)('%s: live appends with a provisional last bar', (d, params) => {
    const all = walk(1200, 11);
    const bars: IndicatorBar[] = [];
    const s = new IndicatorSeries(d, params);
    for (let i = 0; i < all.length; i++) {
      // A provisional bar that changes twice before it is final.
      bars.push(bar(all[i]!.close - 0.5, 10, all[i]!.open));
      s.invalidateFrom(bars.length - 1);
      s.update(bars);
      bars[i] = all[i]!;
      s.invalidateFrom(i);
      expect(s.update(bars)).toBe(i); // only the last position is recomputed
    }
    same(s, bars, d);
  });

  test.each(definitions)(
    '%s: a corrected old bar invalidates the suffix (recursive chains included)',
    (d, params) => {
      const bars = walk(800, 3);
      const s = new IndicatorSeries(d, params);
      s.update(bars);
      bars[400] = bar(bars[400]!.close + 7, 99);
      s.invalidateFrom(400);
      expect(s.update(bars)).toBe(400);
      same(s, bars, d);
      // Without invalidation nothing is recomputed (the caller must report changes).
      expect(s.update(bars)).toBe(bars.length);
    },
  );

  test.each([1, 3, 14])(
    'RSI(%i) over flat stretches (zero averages): appends and a correction equal a full calculation',
    (period) => {
      // flat -> gains -> flat -> losses -> flat -> mixed, so every zero case occurs.
      const flat = (count: number, price: number) => Array.from({ length: count }, () => price);
      const all = closes(
        ...flat(40, 100),
        ...Array.from({ length: 20 }, (_, i) => 101 + i),
        ...flat(40, 120),
        ...Array.from({ length: 20 }, (_, i) => 119 - i),
        ...flat(40, 100),
        ...walk(60, 13).map((b) => b.close),
      );
      const bars: IndicatorBar[] = [];
      const s = new IndicatorSeries(RSI, { period });
      for (let i = 0; i < all.length; i++) {
        bars.push(bar(all[i]!.close + 0.75)); // provisional, then final
        s.invalidateFrom(i);
        s.update(bars);
        bars[i] = all[i]!;
        s.invalidateFrom(i);
        expect(s.update(bars)).toBe(i);
      }
      same(s, bars, RSI);
      expect(s.value(0, 39)).toBe(50); // still inside the first flat stretch
      // A correction inside a flat stretch recomputes the suffix to the same values as a full run.
      bars[30] = bar(101);
      s.invalidateFrom(30);
      expect(s.update(bars)).toBe(30);
      same(s, bars, RSI);
      for (let i = 0; i < bars.length; i++) {
        const v = s.value(0, i);
        if (v !== null) expect(v >= 0 && v <= 100).toBe(true);
      }
    },
  );

  test.each(definitions)('%s: prepended history recomputes everything (reset)', (d, params) => {
    const all = walk(1000, 5);
    const s = new IndicatorSeries(d, params);
    s.update(all.slice(600));
    s.reset();
    expect(s.update(all)).toBe(0);
    same(s, all, d);
  });

  test('values near the old left edge can change when older history arrives (documented)', () => {
    const all = walk(400, 9);
    const recent = calculateIndicator(EMA, { period: 20 }, all.slice(200)).value!;
    const longer = calculateIndicator(EMA, { period: 20 }, all).value!.slice(200);
    expect(recent[19]).not.toBe(longer[19]); // new seed context
    expect(Math.abs(recent[199]! - longer[199]!)).toBeLessThan(1e-6); // converges later
  });
});
