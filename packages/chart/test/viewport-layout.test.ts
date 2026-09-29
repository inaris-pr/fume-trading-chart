import { describe, expect, test } from 'vitest';
import { createViewport } from '../src/viewport.ts';
import { backingStoreSize, computeLayout } from '../src/layout.ts';

describe('createViewport', () => {
  const vp = createViewport({
    plotLeft: 0,
    plotWidth: 700,
    barSpacing: 7,
    anchorSlot: 779,
    rightOffset: 6,
  });

  test('anchor slot sits rightOffset + 0.5 slots inside the right edge', () => {
    expect(vp.slotToX(779)).toBeCloseTo(700 - 6.5 * 7, 12);
    expect(vp.slotToX(778)).toBeCloseTo(vp.slotToX(779) - 7, 12);
  });

  test('slot <-> x round trip error < 0.5 px (Stage 1 criterion)', () => {
    for (let s = 600; s <= 790; s += 0.37) {
      expect(Math.abs(vp.slotToX(vp.xToSlot(vp.slotToX(s))) - vp.slotToX(s))).toBeLessThan(0.5);
      expect(vp.xToSlot(vp.slotToX(s))).toBeCloseTo(s, 9);
    }
  });

  test('visible slots are the integer slots whose centers are inside the plot', () => {
    const { from, to } = vp.visibleSlots();
    expect(vp.slotToX(from)).toBeGreaterThanOrEqual(0);
    expect(vp.slotToX(from - 1)).toBeLessThan(0);
    expect(vp.slotToX(to)).toBeLessThanOrEqual(700);
    expect(vp.slotToX(to + 1)).toBeGreaterThan(700);
    expect(to).toBe(785); // 6 future slots
    expect(to - from + 1).toBe(100);
  });

  test('rejects non-positive spacing', () => {
    expect(() =>
      createViewport({ plotLeft: 0, plotWidth: 1, barSpacing: 0, anchorSlot: 0, rightOffset: 0 }),
    ).toThrow();
  });
});

describe('computeLayout', () => {
  test('plot + right price axis + bottom time axis tile the canvas', () => {
    const l = computeLayout(1000, 600, 70, 26);
    expect(l.plot).toEqual({ x: 0, y: 0, width: 930, height: 574 });
    expect(l.priceAxis).toEqual({ x: 930, y: 0, width: 70, height: 574 });
    expect(l.timeAxis).toEqual({ x: 0, y: 574, width: 930, height: 26 });
  });

  test('never negative when the canvas is smaller than the axes', () => {
    const l = computeLayout(40, 10, 70, 26);
    expect(l.plot.width).toBe(0);
    expect(l.plot.height).toBe(0);
    expect(l.priceAxis.width).toBe(40);
  });
});

describe('backingStoreSize (devicePixelRatio handling)', () => {
  test.each([
    [1, 800, 600],
    [2, 1600, 1200],
    [3, 2400, 1800],
  ])('DPR %d', (dpr, w, h) => {
    expect(backingStoreSize(800, 600, dpr)).toEqual({ width: w, height: h, pixelRatio: dpr });
  });

  test('fractional DPR rounds the backing store and reports the effective ratio', () => {
    const b = backingStoreSize(801, 601, 1.25);
    expect(b.width).toBe(1001);
    expect(b.height).toBe(751);
    expect(b.pixelRatio).toBeCloseTo(1001 / 801, 12);
  });

  test('exact device-pixel box wins when the browser reports it', () => {
    expect(backingStoreSize(801, 601, 1.25, { width: 1002, height: 752 }).width).toBe(1002);
  });

  test('invalid DPR falls back to 1; zero size is allowed', () => {
    expect(backingStoreSize(10, 10, 0).width).toBe(10);
    expect(backingStoreSize(0, 0, 2)).toEqual({ width: 0, height: 0, pixelRatio: 2 });
  });
});
