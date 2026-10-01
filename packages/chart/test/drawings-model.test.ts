/**
 * Drawing model (schema stability, validation), pure hit-testing and the public coordinate API on
 * a session-compressed axis.
 */
import { describe, expect, test } from 'vitest';
import { FumeChart } from '../src/chart.ts';
import { createChartCoordinates } from '../src/coordinates.ts';
import type { DrawingGeometry } from '../src/drawings/geometry.ts';
import { distanceToSegment, hitTestDrawings } from '../src/drawings/hit-test.ts';
import {
  DrawingSchemaError,
  parseDrawingDocument,
  serializeDrawings,
  type Drawing,
} from '../src/drawings/model.ts';
import { demoSeries, FakeEnvironment, fakeContainer, MIN } from './fakes.ts';

const trend: Drawing = {
  id: 'a1',
  type: 'trend-line',
  anchors: [
    { time: 1_773_239_400_000, price: 581.25 },
    { time: 1_773_253_800_000, price: 585.5 },
  ],
  style: { color: '#5b8cff', lineWidth: 2, lineStyle: 'solid' },
  visible: true,
  locked: false,
};
const rect: Drawing = {
  id: 'r1',
  type: 'rectangle',
  anchors: [
    { time: 1_773_239_400_000, price: 580 },
    { time: 1_773_253_800_000, price: 590 },
  ],
  style: { color: '#ff9f43', lineWidth: 1, lineStyle: 'dashed', fillColor: 'rgba(0,0,0,0.1)' },
  visible: false,
  locked: true,
};

describe('serialization: versioned and stable', () => {
  test('the persisted JSON of schema version 1 is exactly this (changing it needs a new version)', () => {
    expect(JSON.stringify(serializeDrawings([trend, rect]))).toBe(
      '{"format":"fume.drawings","version":1,"drawings":[' +
        '{"id":"a1","type":"trend-line","anchors":[{"time":1773239400000,"price":581.25},' +
        '{"time":1773253800000,"price":585.5}],"style":{"color":"#5b8cff","lineWidth":2,' +
        '"lineStyle":"solid"},"visible":true,"locked":false},' +
        '{"id":"r1","type":"rectangle","anchors":[{"time":1773239400000,"price":580},' +
        '{"time":1773253800000,"price":590}],"style":{"color":"#ff9f43","lineWidth":1,' +
        '"lineStyle":"dashed","fillColor":"rgba(0,0,0,0.1)"},"visible":false,"locked":true}]}',
    );
  });

  test('round-trips through JSON; interaction state and unknown fields are not persisted', () => {
    const withExtras = { ...trend, selected: true, hovered: true } as Drawing;
    const json = JSON.stringify(serializeDrawings([withExtras, rect]));
    expect(json).not.toContain('selected');
    expect(parseDrawingDocument(JSON.parse(json))).toEqual([trend, rect]);
  });

  test('rejects another format, an unknown version and invalid drawings (never guesses)', () => {
    const doc = serializeDrawings([trend]);
    const bad = (patch: unknown) => () => parseDrawingDocument(patch);
    expect(bad({ ...doc, format: 'other' })).toThrow(DrawingSchemaError);
    expect(bad({ ...doc, version: 2 })).toThrow(/version 2/);
    expect(bad({ ...doc, drawings: [{ ...trend, type: 'fibonacci' }] })).toThrow(/type/);
    expect(bad({ ...doc, drawings: [{ ...trend, anchors: [trend.anchors[0]] }] })).toThrow(
      /2 points/,
    );
    expect(
      bad({
        ...doc,
        drawings: [{ ...trend, anchors: [{ time: NaN, price: 1 }, trend.anchors[1]] }],
      }),
    ).toThrow(/finite/);
    expect(bad({ ...doc, drawings: [trend, trend] })).toThrow(/Duplicate/);
    expect(
      bad({ ...doc, drawings: [{ ...trend, style: { ...trend.style, lineWidth: 0 } }] }),
    ).toThrow(/lineWidth/);
    expect(bad(null)).toThrow(DrawingSchemaError);
  });
});

describe('hit-testing (screen space, deterministic)', () => {
  const plot = { x: 0, y: 0, width: 800, height: 500 };
  const g = (d: Drawing, shape: DrawingGeometry['shape'], handles: DrawingGeometry['handles']) =>
    ({ drawing: d, shape, handles }) as DrawingGeometry;
  const line = g(trend, { kind: 'segment', a: { x: 100, y: 100 }, b: { x: 300, y: 300 } }, [
    { x: 100, y: 100 },
    { x: 300, y: 300 },
  ]);
  const box = g(
    { ...rect, visible: true, locked: false },
    { kind: 'rect', left: 150, top: 150, right: 400, bottom: 250 },
    [],
  );

  test('distance to a segment clamps to its ends', () => {
    expect(distanceToSegment({ x: 0, y: 10 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(10);
    expect(distanceToSegment({ x: 13, y: 4 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(5);
    expect(distanceToSegment({ x: 3, y: 4 }, { x: 0, y: 0 }, { x: 0, y: 0 })).toBe(5);
  });

  test('body within tolerance (6 px + half the width), miss beyond, empty space is null', () => {
    expect(hitTestDrawings([line], { x: 200, y: 207 }, plot, null)).toEqual({
      kind: 'body',
      id: 'a1',
    });
    expect(hitTestDrawings([line], { x: 200, y: 212 }, plot, null)).toBeNull();
    expect(hitTestDrawings([line], { x: 900, y: 900 }, plot, null)).toBeNull(); // outside plot
  });

  test('handles only for the selected, unlocked drawing; they win over any body', () => {
    expect(hitTestDrawings([line], { x: 303, y: 304 }, plot, null)).toEqual({
      kind: 'body',
      id: 'a1',
    });
    expect(hitTestDrawings([line, box], { x: 303, y: 304 }, plot, 'a1')).toEqual({
      kind: 'handle',
      id: 'a1',
      handle: 1,
    });
    const locked = { ...line, drawing: { ...trend, locked: true } };
    expect(hitTestDrawings([locked], { x: 303, y: 304 }, plot, 'a1')).toEqual({
      kind: 'body',
      id: 'a1',
    });
  });

  test('topmost (last) drawing wins; a filled rectangle is hit inside, an empty one only at edges', () => {
    expect(hitTestDrawings([line, box], { x: 200, y: 200 }, plot, null)).toEqual({
      kind: 'body',
      id: 'r1',
    });
    expect(hitTestDrawings([box, line], { x: 200, y: 200 }, plot, null)).toEqual({
      kind: 'body',
      id: 'a1',
    });
    const hollow = {
      ...box,
      drawing: { ...box.drawing, style: { color: '#fff', lineWidth: 1, lineStyle: 'solid' } },
    } as DrawingGeometry;
    expect(hitTestDrawings([hollow], { x: 300, y: 200 }, plot, null)).toBeNull();
    expect(hitTestDrawings([hollow], { x: 300, y: 152 }, plot, null)).toMatchObject({
      kind: 'body',
    });
  });
});

describe('coordinate API on the session-compressed axis', () => {
  function rendered() {
    const env = new FakeEnvironment();
    const data = demoSeries();
    const chart = new FumeChart(
      fakeContainer(),
      {
        timeScale: data.mapping,
        formatPrice: data.formatPrice,
        formatTime: data.formatTime,
        minPriceStep: 0.01,
      },
      env,
    );
    expect(chart.getCoordinates()).toBeNull(); // nothing rendered yet
    env.resizeCallback!({ cssWidth: 1000, cssHeight: 600 });
    chart.setBars(data.bars);
    env.flushFrames();
    return { chart, data, env, c: chart.getCoordinates()! };
  }

  test('bar open time -> candle center; x -> bar time; price <-> y round-trips', () => {
    const { chart, data, c } = rendered();
    const frame = chart.getLastFrame()!;
    for (const i of [700, 740, 779]) {
      const b = data.bars[i]!;
      const x = c.timeToX(b.start)!;
      expect(x).toBeCloseTo(frame.viewport.slotToX(i), 9);
      expect(c.xToBarTime(x)).toBe(b.start);
      expect(c.xToBarTime(x + c.barSpacing * 0.49)).toBe(b.start);
      expect(c.yToPrice(c.priceToY(b.close))).toBeCloseTo(b.close, 9);
    }
    const inside = data.bars[740]!.start + 2 * MIN; // 2 of 5 minutes into the bar
    expect(c.timeToX(inside)!).toBeCloseTo(
      c.timeToX(data.bars[740]!.start)! + 0.4 * c.barSpacing,
      9,
    );
    expect(c.xToTime(c.timeToX(inside)!)).toBe(inside);
  });

  test('closed time has zero width: the close, the night and the next open share one x', () => {
    const { data, c } = rendered();
    const lastOfDay = data.bars[77]!; // Mar 2 15:55
    const close = lastOfDay.start + 5 * MIN; // 16:00
    const nextOpen = data.bars[78]!.start; // Mar 3 09:30
    expect(c.timeToX(close)).toBeCloseTo(c.timeToX(nextOpen)!, 9);
    expect(c.timeToX(close + 6 * 60 * MIN)).toBeCloseTo(c.timeToX(nextOpen)!, 9);
    // Every x across the plot resolves to real session time (never a closed-period time).
    const { plot } = c;
    for (let x = plot.x; x < plot.x + plot.width; x += 3) {
      const t = c.xToBarTime(x);
      if (t !== null) expect(data.mapping.toSlot(t)).not.toBeNull();
    }
  });

  test('outside the resolved calendar: null, no extrapolation', () => {
    const { c } = rendered();
    expect(c.timeToX(Date.UTC(2026, 1, 1))).toBeNull();
    expect(c.timeToX(Date.UTC(2026, 5, 1))).toBeNull();
    expect(c.slotToTime(-1)).toBeNull();
  });

  test('a new frame gets a new coordinate object; createChartCoordinates needs a price scale', () => {
    const { chart, env, c } = rendered();
    expect(chart.getCoordinates()).toBe(c); // memoized per frame
    env.resizeCallback!({ cssWidth: 900, cssHeight: 600 });
    env.flushFrames();
    expect(chart.getCoordinates()).not.toBe(c);
    const frame = { ...chart.getLastFrame()!, priceScale: null };
    expect(createChartCoordinates(frame, demoSeries().mapping)).toBeNull();
  });
});
