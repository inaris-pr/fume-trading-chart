/**
 * Drawings through the real chart (fake browser, DPR 2): the trend-line vertical slice (create,
 * select, drag handle, drag line, delete, Escape), horizontal line and rectangle, and that the
 * market anchors survive zoom, pan, resize, price scaling, live data, paging and timeframe switches
 * while the screen geometry follows. Painted geometry is read from the drawing layer's recording
 * context (device px).
 */
import { describe, expect, test } from 'vitest';
import {
  createSessionTimeScale,
  resolveWeeklySessions,
  type Bar,
  type InstrumentId,
} from '@fume/core';
import { FumeChart } from '../src/chart.ts';
import type { Drawing, DrawingChange, DrawingTool } from '../src/drawings/model.ts';
import { bar, demoSeries, FakeEnvironment, fakeContainer, MIN, pointer } from './fakes.ts';

const PR = 2;

function setup() {
  const env = new FakeEnvironment();
  env.dpr = PR;
  const data = demoSeries(); // 780 5m RTH bars, Mar 2..13; calendar resolved to Mar 20
  const changes: { drawings: readonly Drawing[]; change: DrawingChange }[] = [];
  const tools: DrawingTool[] = [];
  const selections: (string | null)[] = [];
  let ids = 0;
  const chart = new FumeChart(
    fakeContainer(),
    {
      timeScale: data.mapping,
      formatPrice: data.formatPrice,
      formatTime: data.formatTime,
      minPriceStep: 0.01,
      createDrawingId: () => `d${++ids}`,
      onDrawingsChange: (drawings, change) => changes.push({ drawings, change }),
      onDrawingToolChange: (tool) => tools.push(tool),
      onDrawingSelectionChange: (id) => selections.push(id),
    },
    env,
  );
  env.resizeCallback!({ cssWidth: 1000, cssHeight: 600 });
  chart.setBars(data.bars);
  env.flushFrames();
  const main = env.canvases[0]!;
  const overlay = env.canvases[1]!;
  const layer = env.canvases[2]!;
  const flush = () => env.flushFrames();
  const coords = () => chart.getCoordinates()!;
  const at = (time: number, price: number) => ({
    x: coords().timeToX(time)!,
    y: coords().priceToY(price),
  });
  const down = (p: { x: number; y: number }, extra = {}) =>
    overlay.dispatch('pointerdown', pointer(p.x, p.y, extra));
  const move = (p: { x: number; y: number }, extra = {}) =>
    overlay.dispatch('pointermove', pointer(p.x, p.y, extra));
  const up = (p: { x: number; y: number }, extra = {}) =>
    overlay.dispatch('pointerup', pointer(p.x, p.y, extra));
  const click = (p: { x: number; y: number }) => {
    down(p);
    up(p);
    flush();
  };
  const drag = (from: { x: number; y: number }, to: { x: number; y: number }) => {
    down(from);
    move({ x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 });
    move(to);
    up(to);
    flush();
  };
  const key = (k: string) => {
    const prevented = overlay.dispatch('keydown', { key: k });
    flush();
    return prevented;
  };
  /** Repaints and returns what the drawing layer stroked (device px). */
  const strokes = () => {
    layer.ctx.reset();
    chart.renderAll();
    return layer.ctx.strokes;
  };
  const bars = data.bars;
  /** Two visible bar anchors with prices inside the visible range. */
  const A = { time: bars[740]!.start, price: bars[740]!.close };
  const B = { time: bars[770]!.start, price: bars[770]!.close };
  const trendLine = () => {
    chart.setDrawingTool('trend-line');
    click(at(A.time, A.price));
    move(at(B.time, B.price));
    click(at(B.time, B.price));
    return chart.getDrawings()[0]!;
  };
  return {
    env,
    data,
    bars,
    chart,
    main,
    overlay,
    layer,
    flush,
    coords,
    at,
    down,
    move,
    up,
    click,
    drag,
    key,
    strokes,
    changes,
    tools,
    selections,
    A,
    B,
    trendLine,
  };
}

const segment = (s: { points: { x: number; y: number }[] }) => s.points.map((p) => [p.x, p.y]);

/** The device-px segment the chart must paint for anchors a -> b with the current coordinates. */
function expectedSegment(t: ReturnType<typeof setup>, a: Drawing['anchors'][number], b = a) {
  const pa = t.at(a.time, a.price);
  const pb = t.at(b.time, b.price);
  return [
    [pa.x * PR, pa.y * PR],
    [pb.x * PR, pb.y * PR],
  ];
}

function expectLineAt(t: ReturnType<typeof setup>, d: Drawing) {
  const s = t.strokes().find((x) => x.points.length === 2 && x.arcs.length === 0)!;
  const [e0, e1] = expectedSegment(t, d.anchors[0]!, d.anchors[1]!);
  expect(s.points[0]!.x).toBeCloseTo(e0![0]!, 6);
  expect(s.points[0]!.y).toBeCloseTo(e0![1]!, 6);
  expect(s.points[1]!.x).toBeCloseTo(e1![0]!, 6);
  expect(s.points[1]!.y).toBeCloseTo(e1![1]!, 6);
  return s;
}

describe('trend line: the vertical slice', () => {
  test('tool -> click -> click creates a line anchored to bar times and exact prices', () => {
    const t = setup();
    const d = t.trendLine();
    expect(d).toMatchObject({ id: 'd1', type: 'trend-line', visible: true, locked: false });
    expect(d.anchors[0]!.time).toBe(t.A.time); // snapped to the bar's open time
    expect(d.anchors[1]!.time).toBe(t.B.time);
    expect(d.anchors[0]!.price).toBeCloseTo(t.A.price, 6);
    expect(d.anchors[1]!.price).toBeCloseTo(t.B.price, 6);
    // One add event, the tool returns to the cursor, the new line is selected.
    expect(t.changes).toHaveLength(1);
    expect(t.changes[0]!.change).toEqual({ kind: 'add', id: 'd1', source: 'edit' });
    expect(t.changes[0]!.drawings).toBe(t.chart.getDrawings());
    expect(t.tools).toEqual(['trend-line', 'cursor']);
    expect(t.chart.getDrawingTool()).toBe('cursor');
    expect(t.chart.getSelectedDrawingId()).toBe('d1');
    expectLineAt(t, d);
  });

  test('a point between bars snaps to the nearest bar time', () => {
    const t = setup();
    const p = t.at(t.A.time, t.A.price);
    const spacing = t.coords().barSpacing;
    t.chart.setDrawingTool('trend-line');
    t.click({ x: p.x + spacing * 0.4, y: p.y });
    t.click({ x: t.at(t.B.time, 0).x - spacing * 0.45, y: p.y });
    const d = t.chart.getDrawings()[0]!;
    expect(d.anchors.map((a) => a.time)).toEqual([t.A.time, t.B.time]);
  });

  test('press-drag-release also creates a line (drag-to-create)', () => {
    const t = setup();
    t.chart.setDrawingTool('trend-line');
    t.drag(t.at(t.A.time, t.A.price), t.at(t.B.time, t.B.price));
    expect(t.chart.getDrawings()).toHaveLength(1);
    expect(t.chart.getDrawings()[0]!.anchors.map((a) => a.time)).toEqual([t.A.time, t.B.time]);
  });

  test('the unfinished line previews to the pointer; Escape cancels it and returns to the cursor', () => {
    const t = setup();
    t.chart.setDrawingTool('trend-line');
    t.click(t.at(t.A.time, t.A.price));
    expect(t.overlay.focused).toBe(true); // the chart took focus for keyboard shortcuts
    t.move(t.at(t.B.time, t.B.price));
    t.flush();
    const preview = t.strokes();
    expect(preview.some((s) => s.points.length === 2)).toBe(true); // preview segment
    expect(t.chart.getDrawingInteractionState().kind).toBe('drawing');
    expect(t.key('Escape')).toBe(true);
    expect(t.chart.getDrawings()).toEqual([]);
    expect(t.chart.getDrawingTool()).toBe('cursor');
    expect(t.strokes()).toEqual([]);
    expect(t.changes).toEqual([]);
  });

  test('click selects (with a tolerance), shows two handles; empty space deselects', () => {
    const t = setup();
    t.trendLine();
    t.click({ x: 5, y: 5 }); // empty space: deselect (and a zero-length pan)
    expect(t.chart.getSelectedDrawingId()).toBeNull();
    expect(t.strokes().filter((s) => s.arcs.length > 0)).toHaveLength(0);

    const pa = t.at(t.A.time, t.A.price);
    const pb = t.at(t.B.time, t.B.price);
    const mid = { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 + 4 }; // 4 px off the line
    t.click(mid);
    expect(t.chart.getSelectedDrawingId()).toBe('d1');
    const handles = t.strokes().filter((s) => s.arcs.length > 0);
    expect(handles.map((h) => [h.arcs[0]!.x, h.arcs[0]!.y])).toEqual([
      [pa.x * PR, pa.y * PR],
      [pb.x * PR, pb.y * PR],
    ]);
    // Far from the line: a miss (deselects).
    t.click({ x: mid.x, y: mid.y + 40 });
    expect(t.chart.getSelectedDrawingId()).toBeNull();
    expect(t.selections).toEqual(['d1', null, 'd1', null]);
    expect(t.changes).toHaveLength(1); // selection is not a drawing change
  });

  test('dragging an endpoint moves that anchor; one update event at the end, none per move', () => {
    const t = setup();
    const d = t.trendLine();
    const view = { ...t.chart.getView() };
    const target = { time: t.bars[760]!.start, price: t.bars[760]!.high };
    t.down(t.at(t.B.time, t.B.price));
    t.move(t.at(t.bars[765]!.start, t.B.price));
    t.move(t.at(target.time, target.price));
    t.flush();
    expect(t.chart.getDrawingInteractionState().kind).toBe('dragging-handle');
    expect(t.changes).toHaveLength(1); // still only the add
    t.up(t.at(target.time, target.price));
    t.flush();
    const moved = t.chart.getDrawings()[0]!;
    expect(moved.anchors[0]).toEqual(d.anchors[0]);
    expect(moved.anchors[1]!.time).toBe(target.time);
    expect(moved.anchors[1]!.price).toBeCloseTo(target.price, 6);
    expect(t.changes).toHaveLength(2);
    expect(t.changes[1]!.change).toEqual({ kind: 'update', id: 'd1', source: 'edit' });
    expect(t.chart.getView()).toEqual(view); // the chart did not pan
    expectLineAt(t, moved);
  });

  test('dragging the line moves both anchors by whole bars and the same price delta', () => {
    const t = setup();
    const d = t.trendLine();
    const pa = t.at(t.A.time, t.A.price);
    const pb = t.at(t.B.time, t.B.price);
    const grab = { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 };
    const spacing = t.coords().barSpacing;
    const dy = 30;
    t.drag(grab, { x: grab.x + 3 * spacing + spacing * 0.3, y: grab.y + dy });
    const moved = t.chart.getDrawings()[0]!;
    expect(moved.anchors.map((a) => a.time)).toEqual([t.bars[743]!.start, t.bars[773]!.start]);
    const priceDelta = t.coords().yToPrice(grab.y + dy) - t.coords().yToPrice(grab.y);
    moved.anchors.forEach((a, i) =>
      expect(a.price).toBeCloseTo(d.anchors[i]!.price + priceDelta, 6),
    );
    expect(t.changes.map((c) => c.change.kind)).toEqual(['add', 'update']);
    expectLineAt(t, moved);
  });

  test('a move across the overnight gap lands on real session time', () => {
    const t = setup();
    // Line inside the last session (bars 702.., Mar 13) dragged 10 bars left of its first bar's
    // session open: the anchor lands in the previous session, not in the closed night.
    t.chart.setDrawings([
      line('x', bars0[703]!.start, bars0[703]!.close, bars0[770]!.start, bars0[770]!.close),
    ]);
    t.flush();
    const pa = t.at(bars0[703]!.start, bars0[703]!.close);
    const grab = { x: pa.x + 1, y: pa.y };
    const spacing = t.coords().barSpacing;
    t.drag(grab, { x: grab.x - 10 * spacing, y: grab.y });
    const moved = t.chart.getDrawings()[0]!;
    expect(moved.anchors[0]!.time).toBe(bars0[693]!.start); // Mar 12, 15:25
    expect(t.data.mapping.toSlot(moved.anchors[0]!.time)).not.toBeNull();
  });

  test('Delete and Backspace remove the selected drawing; locked drawings stay', () => {
    const t = setup();
    t.trendLine();
    expect(t.key('Delete')).toBe(true); // prevented: handled by the chart
    expect(t.chart.getDrawings()).toEqual([]);
    expect(t.changes.at(-1)!.change).toEqual({ kind: 'remove', id: 'd1', source: 'edit' });
    expect(t.chart.getSelectedDrawingId()).toBeNull();
    expect(t.key('Backspace')).toBe(false); // nothing selected: not handled

    t.trendLine();
    t.key('Backspace');
    expect(t.chart.getDrawings()).toEqual([]);

    const locked = { ...line('L', t.A.time, t.A.price, t.B.time, t.B.price), locked: true };
    t.chart.setDrawings([locked]);
    t.chart.selectDrawing('L');
    t.flush();
    expect(t.key('Delete')).toBe(false);
    expect(t.chart.getDrawings()).toEqual([locked]);
    // Locked: selectable, but neither the line nor a handle can be dragged.
    const pa = t.at(t.A.time, t.A.price);
    t.drag(pa, { x: pa.x + 50, y: pa.y + 50 });
    expect(t.chart.getDrawings()).toEqual([locked]);
    expect(t.strokes().filter((s) => s.arcs.length > 0)).toHaveLength(0); // no handles
  });

  test('Escape during a drag (or pointercancel) restores the drawing without an event', () => {
    const t = setup();
    const d = t.trendLine();
    const pb = t.at(t.B.time, t.B.price);
    t.down(pb);
    t.move({ x: pb.x - 60, y: pb.y + 20 });
    t.key('Escape');
    t.up({ x: pb.x - 60, y: pb.y + 20 });
    expect(t.chart.getDrawings()[0]).toEqual(d);
    t.down(pb);
    t.move({ x: pb.x - 60, y: pb.y + 20 });
    t.overlay.dispatch('pointercancel', pointer(pb.x - 60, pb.y + 20));
    expect(t.chart.getDrawings()[0]).toEqual(d);
    expect(t.changes).toHaveLength(1);
  });

  test('a second pointer cannot pan while a drawing drag is in progress', () => {
    const t = setup();
    t.trendLine();
    const view = { ...t.chart.getView() };
    t.down(t.at(t.B.time, t.B.price));
    t.down({ x: 100, y: 100 }, { pointerId: 2 });
    t.move({ x: 300, y: 100 }, { pointerId: 2 });
    t.up({ x: 300, y: 100 }, { pointerId: 2 });
    expect(t.chart.getView()).toEqual(view);
    expect(t.chart.isPanning()).toBe(false);
  });
});

describe('market anchors survive view and data changes; geometry follows', () => {
  test('zoom: same anchors, re-projected geometry, hit-testing at the new place', () => {
    const t = setup();
    const d = t.trendLine();
    const before = t.at(t.B.time, t.B.price);
    t.overlay.dispatch('wheel', {
      offsetX: 300,
      offsetY: 300,
      deltaX: 0,
      deltaY: 300, // zoom out: both ends stay on screen
      deltaMode: 0,
      ctrlKey: false,
    });
    t.flush();
    expect(t.chart.getDrawings()[0]).toBe(d);
    expect(t.at(t.B.time, t.B.price).x).not.toBeCloseTo(before.x, 1);
    expectLineAt(t, d);
    t.click({ x: 5, y: 5 }); // deselect
    t.click(t.at(t.B.time, t.B.price));
    expect(t.chart.getSelectedDrawingId()).toBe('d1');
  });

  test('pan: the line moves exactly with the candles', () => {
    const t = setup();
    const d = t.trendLine();
    t.click({ x: 5, y: 5 });
    const before = t.at(t.A.time, t.A.price);
    t.drag({ x: 300, y: 500 }, { x: 420, y: 500 }); // empty space: pans
    const after = t.at(t.A.time, t.A.price);
    expect(after.x - before.x).toBeCloseTo(120, 6);
    expect(t.chart.getDrawings()[0]).toBe(d);
    expectLineAt(t, d);
  });

  test('resize: geometry is recomputed for the new plot; anchors unchanged', () => {
    const t = setup();
    const d = t.trendLine();
    t.env.resizeCallback!({ cssWidth: 700, cssHeight: 420 });
    t.flush();
    expect(t.chart.getLastFrame()!.layout.width).toBe(700);
    expect(t.chart.getDrawings()[0]).toBe(d);
    expectLineAt(t, d);
    expect(t.layer.width).toBe(700 * PR);
  });

  test('price-axis scaling (stretch/compress): y follows the new price range; hit-testing works', () => {
    const t = setup();
    const d = t.trendLine();
    const plot = t.chart.getLastFrame()!.layout.plot;
    const before = t.at(t.A.time, t.A.price).y;
    t.overlay.dispatch('wheel', {
      offsetX: plot.width + 10,
      offsetY: 200,
      deltaX: 0,
      deltaY: 400,
      deltaMode: 0,
      ctrlKey: false,
    });
    t.flush();
    expect(t.chart.getPriceScaleMode()).toBe('manual');
    expect(t.at(t.A.time, t.A.price).y).not.toBeCloseTo(before, 1);
    expect(t.chart.getDrawings()[0]).toBe(d);
    expectLineAt(t, d);
    t.click({ x: 5, y: 5 });
    t.click(t.at(t.A.time, t.A.price));
    expect(t.chart.getSelectedDrawingId()).toBe('d1');
  });

  test('live bars: the view advances, the line moves with its bars, no drawing event', () => {
    const t = setup();
    const d = t.trendLine();
    const before = t.at(t.B.time, t.B.price).x;
    const last = t.bars.at(-1)!;
    // The next real slot is the next session's open (16:00 would be closed time).
    const next = t.data.mapping.slotStart(t.data.mapping.toSlot(last.start)! + 1);
    t.chart.upsertBars([bar(next, last.close, last.close, last.close, last.close)]);
    t.flush();
    const spacing = t.coords().barSpacing;
    expect(t.at(t.B.time, t.B.price).x).toBeCloseTo(before - spacing, 6); // following: shifted
    expect(t.chart.getDrawings()[0]).toBe(d);
    expect(t.changes).toHaveLength(1);
    expectLineAt(t, d);
  });

  test('history paging with a wider calendar keeps the line where it was', () => {
    const t = setup();
    const recent = t.bars.slice(390); // Mar 9..13 loaded
    t.chart.setBars(recent);
    t.flush();
    const d = line(
      'p',
      recent[350]!.start,
      recent[350]!.close,
      recent[380]!.start,
      recent[380]!.close,
    );
    t.chart.setDrawings([d]);
    t.flush();
    const before = t.at(d.anchors[0]!.time, d.anchors[0]!.price);
    t.chart.prependBars(t.bars.slice(0, 390));
    t.flush();
    const after = t.at(d.anchors[0]!.time, d.anchors[0]!.price);
    expect(after.x).toBeCloseTo(before.x, 6);
    expectLineAt(t, d);
  });

  test('timeframe switch: anchors stay real times; on 15m a 5m bar time sits inside its 15m bar', () => {
    const t = setup();
    const day = Date.UTC(2026, 2, 12, 13, 30); // Thu 09:30 EDT
    const a = { time: day + 65 * MIN, price: 600 }; // 10:35 (inside the 10:30 15m bar, 1/3)
    const b = { time: day + 215 * MIN, price: 605 }; // 13:05 (inside the 13:00 15m bar, 1/3)
    const d = line('tf', a.time, a.price, b.time, b.price);
    t.chart.setDrawings([d]);
    const m15 = createSessionTimeScale({
      sessions: demoCalendar,
      sessionMode: 'regular',
      slot: { kind: 'intraday', durationMs: 15 * MIN },
    });
    t.chart.setData({
      bars: to15m(t.bars, m15),
      timeScale: m15,
      formatPrice: t.data.formatPrice,
      formatTime: t.data.formatTime,
      minPriceStep: 0.01,
    });
    t.flush();
    expect(t.chart.getDrawings()[0]).toBe(d); // never converted to bar indices
    const c = t.coords();
    const slotA = m15.toSlot(day + 60 * MIN)!; // the 10:30 15m bar
    expect(c.timeToX(a.time)).toBeCloseTo(c.slotToX(slotA + 1 / 3), 6);
    expectLineAt(t, d);
  });

  test('anchors outside the resolved calendar: the drawing is not painted or hit (no fabricated time)', () => {
    const t = setup();
    const outside = Date.UTC(2026, 1, 20, 15, 0); // Feb 20, before the calendar starts
    t.chart.setDrawings([line('o', outside, 590, t.B.time, t.B.price)]);
    t.flush();
    expect(t.coords().timeToX(outside)).toBeNull();
    expect(t.strokes()).toEqual([]);
    t.click(t.at(t.B.time, t.B.price));
    expect(t.chart.getSelectedDrawingId()).toBeNull();
  });
});

describe('layers, events and lifecycle', () => {
  test('hover and drawing edits repaint only the drawing layer, never the candle layer', () => {
    const t = setup();
    t.trendLine();
    t.click({ x: 5, y: 5 });
    t.main.ctx.reset();
    t.layer.ctx.reset();
    const pa = t.at(t.A.time, t.A.price);
    t.move(pa); // hover the line
    t.flush();
    expect(t.layer.ctx.clears).toBe(1);
    expect(t.layer.ctx.strokes[0]!.width).toBe(2 * PR + PR); // hovered: thicker
    expect(t.overlay.style.cursor).toBe('grab'); // movable body
    expect(t.main.ctx.clears + t.main.ctx.rects.length).toBe(0);
    t.move({ x: 5, y: 5 });
    t.flush();
    expect(t.overlay.style.cursor).toBe('crosshair');
    expect(t.main.ctx.clears + t.main.ctx.rects.length).toBe(0);
  });

  test('setDrawings replaces without an event; a vanished selection is cleared', () => {
    const t = setup();
    t.trendLine();
    const other = line('x', t.A.time, t.A.price + 1, t.B.time, t.B.price + 1);
    const next = [other];
    t.chart.setDrawings(next);
    expect(t.chart.getDrawings()).toBe(next);
    expect(t.changes).toHaveLength(1); // only the user's add
    expect(t.chart.getSelectedDrawingId()).toBeNull();
    expect(t.selections.at(-1)).toBeNull();
  });

  test('right-button and outside-the-plot presses never create drawings', () => {
    const t = setup();
    t.chart.setDrawingTool('trend-line');
    t.down(t.at(t.A.time, t.A.price), { button: 2 });
    const plot = t.chart.getLastFrame()!.layout.plot;
    t.click({ x: plot.width + 20, y: 100 }); // price axis
    expect(t.chart.getDrawingInteractionState()).toMatchObject({ kind: 'drawing', anchors: [] });
  });

  test('destroy removes all three layers and listeners; no callbacks afterwards', () => {
    const t = setup();
    t.trendLine();
    t.chart.destroy();
    expect(t.env.canvases.every((c) => c.removed && c.listenerCount() === 0)).toBe(true);
    expect(t.env.activeObservers).toBe(0);
    expect(t.env.frames.size).toBe(0);
    t.chart.setDrawingTool('rectangle');
    t.chart.setDrawings([]);
    expect(t.tools).toEqual(['trend-line', 'cursor']);
  });
});

describe('horizontal line and rectangle', () => {
  test('horizontal line: one click; spans the plot; dragging changes its price', () => {
    const t = setup();
    t.chart.setDrawingTool('horizontal-line');
    t.click(t.at(t.A.time, 600));
    const d = t.chart.getDrawings()[0]!;
    expect(d).toMatchObject({ type: 'horizontal-line' });
    expect(d.anchors[0]!.price).toBeCloseTo(600, 6);
    const plot = t.chart.getLastFrame()!.layout.plot;
    const s = t.strokes().find((x) => x.arcs.length === 0)!;
    expect(s.points.map((p) => p.x)).toEqual([0, plot.width * PR]);
    const y = t.coords().priceToY(600);
    t.drag({ x: 50, y }, { x: 80, y: y - 25 });
    expect(t.chart.getDrawings()[0]!.anchors[0]!.price).toBeCloseTo(t.coords().yToPrice(y - 25), 6);
  });

  test('rectangle: two corners, filled body hit inside, a corner handle reshapes it', () => {
    const t = setup();
    t.chart.setDrawingTool('rectangle');
    t.click(t.at(t.A.time, 598));
    t.click(t.at(t.B.time, 604));
    const d = t.chart.getDrawings()[0]!;
    expect(d.type).toBe('rectangle');
    expect(d.style.fillColor).toBeDefined();
    expect(t.layer.ctx.fills.length + t.layer.ctx.rects.length).toBeGreaterThan(0);
    t.click({ x: 5, y: 5 });
    t.click(t.at(t.bars[755]!.start, 601)); // inside the filled body
    expect(t.chart.getSelectedDrawingId()).toBe(d.id);
    // Corner 1 = (time of anchor 1, price of anchor 0).
    t.drag(t.at(t.B.time, 598), t.at(t.bars[775]!.start, 597));
    const r = t.chart.getDrawings()[0]!;
    expect(r.anchors[1]!.time).toBe(t.bars[775]!.start);
    expect(r.anchors[0]!.price).toBeCloseTo(597, 6);
    expect(r.anchors[0]!.time).toBe(t.A.time);
    expect(r.anchors[1]!.price).toBeCloseTo(604, 6);
  });
});

// -------------------------------------------------------------------------------------------------

const bars0 = demoSeries().bars;

function line(id: string, t0: number, p0: number, t1: number, p1: number): Drawing {
  return {
    id,
    type: 'trend-line',
    anchors: [
      { time: t0, price: p0 },
      { time: t1, price: p1 },
    ],
    style: { color: '#5b8cff', lineWidth: 2, lineStyle: 'solid' },
    visible: true,
    locked: false,
  };
}

/** The demo calendar (as in demoSeries: RTH, Mar 2..20) for another timeframe's mapping. */
const demoCalendar = resolveWeeklySessions({
  instrumentId: 'eq:TEST' as InstrumentId,
  spec: {
    timezone: 'America/New_York',
    regular: ([1, 2, 3, 4, 5] as const).map((startDay) => ({
      startDay,
      start: '09:30',
      end: '16:00',
    })),
    extended: [],
    calendarId: 'TEST',
  },
  from: '2026-03-02',
  to: '2026-03-20',
});

/** 15m candles from 5m bars (three per bucket), keyed by the 15m bucket start. */
function to15m(source: readonly Bar[], m15: ReturnType<typeof createSessionTimeScale>): Bar[] {
  const out: Bar[] = [];
  for (const b of source) {
    const start = m15.slotStart(Math.floor(m15.toSlot(b.start)!));
    const cur = out.at(-1);
    if (cur && cur.start === start) {
      out[out.length - 1] = {
        ...cur,
        high: Math.max(cur.high, b.high),
        low: Math.min(cur.low, b.low),
        close: b.close,
      };
    } else out.push({ ...b, start });
  }
  return out;
}
