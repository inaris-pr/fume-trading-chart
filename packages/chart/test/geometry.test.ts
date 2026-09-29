import { describe, expect, test } from 'vitest';
import {
  CandleBuffer,
  candleDirection,
  candleWidths,
  computeCandleGeometry,
  emptyCandleGeometry,
  type CandleInput,
} from '../src/geometry.ts';

const geom = (input: CandleInput, spacing = 7, pr = 1) =>
  computeCandleGeometry(input, candleWidths(spacing, pr), emptyCandleGeometry());

describe('candleWidths', () => {
  test('body ~70% of the slot with the wick parity, wick = 1 CSS px', () => {
    expect(candleWidths(7, 1)).toEqual({ body: 3, wick: 1 }); // floor(4.9)=4 -> 3 (odd like wick)
    expect(candleWidths(10, 1)).toEqual({ body: 7, wick: 1 });
    expect(candleWidths(7, 2)).toEqual({ body: 8, wick: 2 }); // floor(9.8)=9 -> 8 (even like wick)
    expect(candleWidths(7, 3)).toEqual({ body: 13, wick: 3 }); // floor(14.7)=14 -> 13
  });

  test('narrow slots collapse the body to the wick width', () => {
    expect(candleWidths(1, 1)).toEqual({ body: 1, wick: 1 });
    expect(candleWidths(0.1, 2)).toEqual({ body: 2, wick: 2 });
  });

  test('wick is exactly centered on the body at every DPR', () => {
    for (const pr of [1, 1.5, 2, 3]) {
      for (let spacing = 1; spacing < 30; spacing += 0.5) {
        const { body, wick } = candleWidths(spacing, pr);
        expect((body - wick) % 2).toBe(0);
      }
    }
  });
});

describe('computeCandleGeometry', () => {
  test('bullish candle: body from close (top) to open (bottom), wick high..low', () => {
    const g = geom({
      xCenter: 100,
      yOpen: 60,
      yHigh: 20,
      yLow: 90,
      yClose: 30,
      open: 10,
      close: 13,
    });
    expect(g).toMatchObject({ bodyX: 99, bodyWidth: 3, bodyY: 30, bodyHeight: 30 });
    expect(g).toMatchObject({ wickX: 100, wickWidth: 1, wickY: 20, wickHeight: 70, direction: 1 });
  });

  test('bearish candle: body from open (top) to close (bottom)', () => {
    const g = geom({
      xCenter: 100,
      yOpen: 30,
      yHigh: 25,
      yLow: 70,
      yClose: 60,
      open: 13,
      close: 10,
    });
    expect(g).toMatchObject({ bodyY: 30, bodyHeight: 30, direction: -1 });
  });

  test('doji (open === close) stays visible with a minimum body height', () => {
    const g = geom({ xCenter: 50, yOpen: 40, yHigh: 30, yLow: 50, yClose: 40, open: 5, close: 5 });
    expect(g.bodyHeight).toBe(1);
    expect(g.direction).toBe(0);
    const hd = geom(
      { xCenter: 50, yOpen: 80, yHigh: 60, yLow: 100, yClose: 80, open: 5, close: 5 },
      7,
      2,
    );
    expect(hd.bodyHeight).toBe(2);
  });

  test('flat bar (high = low = open = close) is still at least 1 px tall', () => {
    const g = geom({ xCenter: 50, yOpen: 40, yHigh: 40, yLow: 40, yClose: 40, open: 5, close: 5 });
    expect(g.bodyHeight).toBeGreaterThanOrEqual(1);
    expect(g.wickHeight).toBeGreaterThanOrEqual(1);
  });

  test('coordinates are snapped to whole device pixels', () => {
    const g = geom({
      xCenter: 100.4,
      yOpen: 60.6,
      yHigh: 20.2,
      yLow: 90.7,
      yClose: 30.4,
      open: 1,
      close: 2,
    });
    for (const v of Object.values(g)) expect(Number.isInteger(v)).toBe(true);
  });

  test('wick always covers the body even if high/low round inside it', () => {
    const g = geom({
      xCenter: 10,
      yOpen: 50,
      yHigh: 50.4,
      yLow: 49.6,
      yClose: 50,
      open: 1,
      close: 1,
    });
    expect(g.wickY).toBeLessThanOrEqual(g.bodyY);
    expect(g.wickY + g.wickHeight).toBeGreaterThanOrEqual(g.bodyY + g.bodyHeight);
  });

  test('candleDirection', () => {
    expect(candleDirection(1, 2)).toBe(1);
    expect(candleDirection(2, 1)).toBe(-1);
    expect(candleDirection(2, 2)).toBe(0);
  });
});

describe('CandleBuffer', () => {
  test('grows on demand, is reused, and stores pushed geometry', () => {
    const buf = new CandleBuffer();
    buf.reset(10);
    const firstArray = buf.bodyX;
    buf.push(geom({ xCenter: 10, yOpen: 5, yHigh: 1, yLow: 9, yClose: 3, open: 1, close: 2 }));
    expect(buf.count).toBe(1);
    expect(buf.bodyY[0]).toBe(3);
    buf.reset(10);
    expect(buf.count).toBe(0);
    expect(buf.bodyX).toBe(firstArray); // no reallocation
    buf.reset(10_000);
    expect(buf.bodyX.length).toBeGreaterThanOrEqual(10_000);
  });
});
