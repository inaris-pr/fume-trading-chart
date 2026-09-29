import { describe, expect, test } from 'vitest';
import {
  priceDragFactor,
  priceScaleLimits,
  priceWheelFactor,
  scalePriceRange,
} from '../src/price-scale-state.ts';
import { createPriceScale } from '../src/price-scale.ts';

const range = { min: 100, max: 110 };
const limits = priceScaleLimits({ min: 50, max: 150 }, 0.01);

describe('scalePriceRange (anchored)', () => {
  test('factor > 1 compresses (larger range), < 1 stretches (smaller range)', () => {
    const bigger = scalePriceRange(range, 2, 105, limits);
    const smaller = scalePriceRange(range, 0.5, 105, limits);
    expect(bigger.max - bigger.min).toBeCloseTo(20, 12);
    expect(smaller.max - smaller.min).toBeCloseTo(5, 12);
  });

  test('the anchor price keeps its vertical position (same y before and after)', () => {
    const before = createPriceScale(range, 0, 400);
    for (const anchor of [100, 102.5, 105, 109.9]) {
      for (const factor of [0.3, 0.8, 1.7, 4]) {
        const next = scalePriceRange(range, factor, anchor, limits);
        const after = createPriceScale(next, 0, 400);
        expect(after.toY(anchor)).toBeCloseTo(before.toY(anchor), 9);
      }
    }
  });

  test('scaling around the middle moves top and bottom symmetrically (no jumps)', () => {
    const next = scalePriceRange(range, 2, 105, limits);
    expect(next).toEqual({ min: 95, max: 115 });
  });

  test('span is clamped to the limits', () => {
    const tiny = scalePriceRange(range, 1e-12, 105, limits);
    const huge = scalePriceRange(range, 1e12, 105, limits);
    expect(tiny.max - tiny.min).toBeCloseTo(limits.minSpan, 12);
    expect(huge.max - huge.min).toBeCloseTo(limits.maxSpan, 6);
  });

  test('repeated operations stay finite and positive', () => {
    let r = range;
    for (let i = 0; i < 500; i++)
      r = scalePriceRange(r, i % 2 ? 7 : 0.05, r.min + (r.max - r.min) * 0.3, limits);
    for (let i = 0; i < 200; i++) r = scalePriceRange(r, 2, r.max, limits);
    for (let i = 0; i < 200; i++) r = scalePriceRange(r, 0.5, r.min, limits);
    expect(Number.isFinite(r.min) && Number.isFinite(r.max)).toBe(true);
    expect(r.max - r.min).toBeGreaterThanOrEqual(limits.minSpan * (1 - 1e-9));
    expect(r.max - r.min).toBeLessThanOrEqual(limits.maxSpan * (1 + 1e-9));
  });

  test('invalid factor or anchor never produces NaN/Infinity', () => {
    for (const f of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const r = scalePriceRange(range, f, 105, limits);
      expect(r).toEqual(range);
    }
    const r = scalePriceRange(range, 2, Number.NaN, limits);
    expect(Number.isFinite(r.min) && Number.isFinite(r.max)).toBe(true);
  });

  test('an anchor outside the range is clamped to its edge', () => {
    const r = scalePriceRange(range, 2, 1_000, limits);
    expect(r.max).toBeCloseTo(110, 12); // anchored at the top edge
    expect(r.min).toBeCloseTo(90, 12);
  });
});

describe('limits', () => {
  test('never thinner than two ticks, never wider than 20x the data span', () => {
    expect(limits.minSpan).toBeCloseTo(0.02, 12);
    expect(limits.maxSpan).toBeCloseTo(2000, 12);
  });

  test('sane without data or with a degenerate tick', () => {
    const l = priceScaleLimits(null, 0);
    expect(l.minSpan).toBeGreaterThan(0);
    expect(l.maxSpan).toBeGreaterThan(l.minSpan);
  });
});

describe('drag and wheel factors', () => {
  test('drag down compresses, drag up stretches, continuously', () => {
    expect(priceDragFactor(0)).toBe(1);
    expect(priceDragFactor(100)).toBeGreaterThan(1);
    expect(priceDragFactor(-100)).toBeLessThan(1);
    expect(priceDragFactor(50) * priceDragFactor(50)).toBeCloseTo(priceDragFactor(100), 12);
    expect(priceDragFactor(Number.NaN)).toBe(1);
  });

  test('wheel down compresses, up stretches, at most 2x per event', () => {
    expect(priceWheelFactor(100)).toBeGreaterThan(1);
    expect(priceWheelFactor(-100)).toBeLessThan(1);
    expect(priceWheelFactor(1e6)).toBe(2);
    expect(priceWheelFactor(-1e6)).toBe(0.5);
    expect(priceWheelFactor(Number.POSITIVE_INFINITY)).toBe(1);
  });
});
