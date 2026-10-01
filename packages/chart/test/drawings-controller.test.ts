/**
 * The drawing tool state machine on its own (no chart, no canvas, no DOM): linear fake coordinates
 * (1 slot = 10 px, 1 price = -1 px), every state transition and what it reports.
 */
import { describe, expect, test } from 'vitest';
import type { ChartCoordinates } from '../src/coordinates.ts';
import { DrawingController } from '../src/drawings/controller.ts';
import type { Drawing, DrawingChange, DrawingTool } from '../src/drawings/model.ts';

const SLOT_MS = 60_000;
const coords: ChartCoordinates = {
  plot: { x: 0, y: 0, width: 1000, height: 1000 },
  barSpacing: 10,
  timeToSlot: (t) => (t >= 0 && t < 100 * SLOT_MS ? t / SLOT_MS : null),
  slotToTime: (s) => (s >= 0 && s < 100 ? Math.round(s * SLOT_MS) : null),
  slotToX: (s) => s * 10,
  xToSlot: (x) => x / 10,
  timeToX: (t) => (t >= 0 && t < 100 * SLOT_MS ? (t / SLOT_MS) * 10 : null),
  xToTime: (x) => (x >= 0 && x < 1000 ? Math.round((x / 10) * SLOT_MS) : null),
  xToBarTime: (x) => (x >= 0 && x < 1000 ? Math.round(x / 10) * SLOT_MS : null),
  priceToY: (p) => 1000 - p,
  yToPrice: (y) => 1000 - y,
};
const P = (x: number, y: number, pointerId = 1) => ({ x, y, pointerId, button: 0 });

function controller() {
  const events: string[] = [];
  const changes: DrawingChange[] = [];
  let n = 0;
  const c = new DrawingController({
    createId: () => `id${++n}`,
    defaultStyle: () => ({ color: '#fff', lineWidth: 2, lineStyle: 'solid' }),
    onDrawingsChange: (_d, change) => changes.push(change),
    onToolChange: (tool: DrawingTool) => events.push(`tool:${tool}`),
    onSelectionChange: (id) => events.push(`select:${id}`),
  });
  return { c, events, changes };
}

describe('DrawingController state machine', () => {
  test('idle -> drawing -> (anchor) -> drawing -> (anchor) -> idle with the new drawing selected', () => {
    const { c, events, changes } = controller();
    expect(c.getState()).toEqual({ kind: 'idle' });
    c.setTool('trend-line');
    expect(c.getState()).toMatchObject({ kind: 'drawing', tool: 'trend-line', anchors: [] });
    expect(c.pointerDown(P(102, 400), coords)).toBe(true);
    expect(c.isCapturing(1)).toBe(true); // the press may become a drag-to-create
    expect(c.pointerUp(P(102, 400), coords, false)).toBe(true);
    expect(c.getState()).toMatchObject({
      kind: 'drawing',
      anchors: [{ time: 10 * SLOT_MS, price: 600 }],
    });
    c.pointerMove(P(300, 300), coords);
    expect(c.preview(coords)?.shape).toEqual({
      kind: 'segment',
      a: { x: 100, y: 400 },
      b: { x: 300, y: 300 },
    });
    c.pointerDown(P(300, 300), coords);
    expect(c.getState()).toEqual({ kind: 'idle' });
    expect(c.getDrawings()[0]!.anchors).toEqual([
      { time: 10 * SLOT_MS, price: 600 },
      { time: 30 * SLOT_MS, price: 700 },
    ]);
    expect(changes).toEqual([{ kind: 'add', id: 'id1', source: 'edit' }]);
    expect(events).toEqual(['tool:trend-line', 'select:id1', 'tool:cursor']);
  });

  test('idle -> dragging-handle -> idle; idle -> dragging-drawing -> idle (update once each)', () => {
    const { c, changes } = controller();
    const d: Drawing = {
      id: 'x',
      type: 'trend-line',
      anchors: [
        { time: 10 * SLOT_MS, price: 600 },
        { time: 30 * SLOT_MS, price: 700 },
      ],
      style: { color: '#fff', lineWidth: 2, lineStyle: 'solid' },
      visible: true,
      locked: false,
    };
    c.setDrawings([d]);
    c.select('x');
    expect(c.pointerDown(P(301, 301), coords)).toBe(true);
    expect(c.getState()).toMatchObject({ kind: 'dragging-handle', handle: 1 });
    c.pointerMove(P(500, 200), coords);
    expect(changes).toEqual([]);
    c.pointerUp(P(500, 200), coords, false);
    expect(c.getDrawings()[0]!.anchors[1]).toEqual({ time: 50 * SLOT_MS, price: 800 });
    expect(changes).toEqual([{ kind: 'update', id: 'x', source: 'edit' }]);

    c.pointerDown(P(200, 350), coords); // on the body (between the ends)
    expect(c.getState()).toMatchObject({ kind: 'dragging-drawing', id: 'x' });
    c.pointerMove(P(227, 340), coords); // +2.7 slots -> 3 bars, +10 price
    c.pointerUp(P(227, 340), coords, false);
    expect(c.getDrawings()[0]!.anchors).toEqual([
      { time: 13 * SLOT_MS, price: 610 },
      { time: 53 * SLOT_MS, price: 810 },
    ]);
    expect(changes).toHaveLength(2);
  });

  test('empty press in cursor mode is not consumed (the chart pans) and clears the selection', () => {
    const { c, events } = controller();
    c.setDrawings([]);
    expect(c.pointerDown(P(500, 500), coords)).toBe(false);
    expect(events).toEqual([]);
  });

  test('after dispose nothing is reported', () => {
    const { c, events } = controller();
    c.dispose();
    c.setTool('rectangle');
    expect(events).toEqual([]);
  });
});
