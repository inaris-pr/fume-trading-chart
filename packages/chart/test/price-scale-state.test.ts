import { describe, expect, test } from 'vitest';
import {
  clampPriceRangeCenter,
  priceDragFactor,
  priceScaleLimits,
  priceWheelFactor,
  scalePriceRange,
  translatePriceRange,
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

describe('translatePriceRange (vertical pan, span preserved)', () => {
  const H = 400;

  test('drag down moves the window up by dy * span / height; span unchanged', () => {
    const r = translatePriceRange({ min: 100, max: 110 }, 40, H);
    expect(r.min).toBeCloseTo(101, 12);
    expect(r.max - r.min).toBeCloseTo(10, 12);
    const up = translatePriceRange({ min: 100, max: 110 }, -40, H);
    expect(up.min).toBeCloseTo(99, 12);
  });

  test('a price keeps following the pointer: its y moves by exactly dy', () => {
    const before = createPriceScale({ min: 100, max: 110 }, 0, H);
    const after = createPriceScale(translatePriceRange({ min: 100, max: 110 }, 37, H), 0, H);
    expect(after.toY(104.2)).toBeCloseTo(before.toY(104.2) + 37, 9);
  });

  test('negative, sub-penny, huge and tiny ranges keep a positive, finite, unchanged span', () => {
    for (const range of [
      { min: -5.5, max: -1.25 },
      { min: 0.0141, max: 0.0143 },
      { min: 1e9, max: 1e9 + 1e6 },
      { min: 1e-8, max: 3e-8 },
    ]) {
      const span = range.max - range.min;
      for (const dy of [-1e4, -3, 0.5, 250, 1e5]) {
        const r = translatePriceRange(range, dy, H);
        expect(Number.isFinite(r.min) && Number.isFinite(r.max)).toBe(true);
        expect(r.max - r.min).toBeCloseTo(
          span,
          Math.max(0, 12 - Math.ceil(Math.log10(Math.abs(r.max) + 1))),
        );
      }
    }
  });

  test('computed from the start range + total dy: no compounding across many moves', () => {
    const start = { min: 100, max: 110 };
    let stepwise = start;
    for (let i = 0; i < 1000; i++) stepwise = translatePriceRange(stepwise, 0.37, H);
    const direct = translatePriceRange(start, 370, H);
    expect(direct.min).toBeCloseTo(100 + 370 * (10 / H), 9);
    expect(direct.max - direct.min).toBeCloseTo(10, 9);
    expect(Math.abs(stepwise.min - direct.min)).toBeLessThan(1e-9); // same answer either way
  });

  test('invalid inputs return the range unchanged', () => {
    const r = { min: 1, max: 2 };
    expect(translatePriceRange(r, Number.NaN, H)).toBe(r);
    expect(translatePriceRange(r, 10, 0)).toBe(r);
    expect(translatePriceRange({ min: 1, max: 1 }, 10, H)).toEqual({ min: 1, max: 1 });
  });

  test('clampPriceRangeCenter keeps the window within reach of the data, span unchanged', () => {
    const data = { min: 100, max: 120 };
    const far = clampPriceRangeCenter({ min: 10_000, max: 10_010 }, data);
    expect(far.max - far.min).toBeCloseTo(10, 9);
    expect((far.min + far.max) / 2).toBeCloseTo(120 + 10 * 10, 9);
    const near = { min: 105, max: 115 };
    expect(clampPriceRangeCenter(near, data)).toBe(near);
    expect(clampPriceRangeCenter(near, null)).toBe(near);
  });
});
