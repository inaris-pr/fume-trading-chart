import { describe, expect, test } from 'vitest';
import {
  choosePriceStep,
  computePriceRange,
  createPriceScale,
  niceStep,
  padRange,
  priceTicks,
} from '../src/price-scale.ts';
import { bar } from './fakes.ts';

describe('createPriceScale', () => {
  const scale = createPriceScale({ min: 100, max: 200 }, 10, 510);

  test('max maps to top, min to bottom, linear in between', () => {
    expect(scale.toY(200)).toBe(10);
    expect(scale.toY(100)).toBe(510);
    expect(scale.toY(150)).toBe(260);
  });

  test('prices outside the range extrapolate (clipped by the painter, not the math)', () => {
    expect(scale.toY(250)).toBe(-240);
  });

  test('toPrice inverts toY within sub-pixel tolerance', () => {
    for (let p = 100; p <= 200; p += 3.37) {
      expect(scale.toPrice(scale.toY(p))).toBeCloseTo(p, 9);
      expect(Math.abs(scale.toY(scale.toPrice(scale.toY(p))) - scale.toY(p))).toBeLessThan(0.5);
    }
  });

  test('negative ranges and ranges crossing zero', () => {
    const neg = createPriceScale({ min: -5, max: 5 }, 0, 100);
    expect(neg.toY(0)).toBe(50);
    expect(neg.toY(-5)).toBe(100);
    expect(neg.toPrice(75)).toBe(-2.5);
  });

  test('very small ranges keep precision', () => {
    const tiny = createPriceScale({ min: 0.0141, max: 0.0143 }, 0, 400);
    expect(tiny.toY(0.0142)).toBeCloseTo(200, 6);
  });

  test('refuses zero span or zero height', () => {
    expect(() => createPriceScale({ min: 1, max: 1 }, 0, 100)).toThrow();
    expect(() => createPriceScale({ min: 1, max: 2 }, 50, 50)).toThrow();
  });
});

describe('computePriceRange', () => {
  const bars = [bar(0, 10, 12, 9, 11), bar(1, 11, 15, 10, 14), bar(2, 14, 14, 3, 5)];
  const opts = { paddingRatio: 0.1, minPriceStep: 0.01 };

  test('uses lows and highs of the visible bars only, then pads', () => {
    const r = computePriceRange(bars, 0, 2, opts)!;
    expect(r.min).toBeCloseTo(9 - 0.6, 12);
    expect(r.max).toBeCloseTo(15 + 0.6, 12);
  });

  test('empty range => null', () => {
    expect(computePriceRange(bars, 3, 3, opts)).toBeNull();
    expect(computePriceRange([], 0, 10, opts)).toBeNull();
  });

  test('all prices equal: widened to a minimum span around the price', () => {
    const flat = [bar(0, 574.25, 574.25, 574.25, 574.25)];
    const r = computePriceRange(flat, 0, 1, { paddingRatio: 0, minPriceStep: 0.01 })!;
    expect(r.max - r.min).toBeCloseTo(0.04, 12);
    expect((r.max + r.min) / 2).toBeCloseTo(574.25, 12);
  });

  test('padRange keeps a positive span for zero prices', () => {
    const r = padRange({ min: 0, max: 0 }, { paddingRatio: 0.1, minPriceStep: 0 });
    expect(r.max - r.min).toBeGreaterThan(0);
  });
});

describe('niceStep / priceTicks', () => {
  test('nice multipliers 1, 2, 2.5, 5 x 10^n', () => {
    expect(niceStep(0.9, 0)).toBe(1);
    expect(niceStep(1.1, 0)).toBe(2);
    expect(niceStep(2.2, 0)).toBe(2.5);
    expect(niceStep(3, 0)).toBe(5);
    expect(niceStep(7, 0)).toBe(10);
    expect(niceStep(0.03, 0)).toBeCloseTo(0.05, 12);
  });

  test('never below, and always a multiple of, the instrument tick', () => {
    expect(niceStep(0.001, 0.01)).toBe(0.01);
    // Treasury-style 1/32 tick: 0.25 is 8 ticks, a valid multiple.
    expect(niceStep(0.2, 1 / 32)).toBe(0.25);
    // 1/4 tick: 2.5 is a multiple (10 ticks); 0.1 is not, so it rounds up to 0.25.
    expect(niceStep(0.07, 0.25)).toBe(0.25);
  });

  test('ticks are integer multiples of the step inside the range', () => {
    expect(priceTicks({ min: 99.5, max: 102.5 }, 1)).toEqual([100, 101, 102]);
    expect(priceTicks({ min: -1.2, max: 1.2 }, 0.5)).toEqual([-1, -0.5, 0, 0.5, 1]);
    const t = priceTicks({ min: 0.05, max: 0.45 }, 0.1);
    expect(t).toHaveLength(4);
    expect(t[2]).toBeCloseTo(0.3, 15);
  });

  test('choosePriceStep targets the requested pixel spacing', () => {
    const step = choosePriceStep({ min: 550, max: 580 }, 600, 50, 0.01);
    const lines = 30 / step;
    expect(lines).toBeGreaterThanOrEqual(6);
    expect(lines).toBeLessThanOrEqual(12);
  });
});
