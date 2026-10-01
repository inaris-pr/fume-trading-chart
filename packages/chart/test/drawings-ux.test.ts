/**
 * Stage 8 drawing UX through the real chart (fake browser, DPR 2): style editing, lock,
 * visibility, duplicate, undo/redo, keyboard shortcuts, selection precedence, drag threshold,
 * repaint isolation and lifecycle. Geometry/paint is read from the drawing layer's recording
 * context (device px).
 */
import { describe, expect, test } from 'vitest';
import { FumeChart } from '../src/chart.ts';
import type { DrawingHistoryState } from '../src/drawings/history.ts';
import {
  parseDrawingDocument,
  serializeDrawings,
  type Drawing,
  type DrawingChange,
} from '../src/drawings/model.ts';
import { demoSeries, FakeEnvironment, fakeContainer, pointer } from './fakes.ts';

const PR = 2;

function setup() {
  const env = new FakeEnvironment();
  env.dpr = PR;
  const data = demoSeries();
  const changes: { drawings: readonly Drawing[]; change: DrawingChange }[] = [];
  const history: DrawingHistoryState[] = [];
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
      onDrawingHistoryChange: (s) => history.push(s),
      onDrawingSelectionChange: (id) => selections.push(id),
    },
    env,
  );
  env.resizeCallback!({ cssWidth: 1000, cssHeight: 600 });
  chart.setBars(data.bars);
  env.flushFrames();
  const [main, overlay, layer] = [env.canvases[0]!, env.canvases[1]!, env.canvases[2]!];
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
  const drag = (from: { x: number; y: number }, to: { x: number; y: number }, steps = 4) => {
    down(from);
    for (let i = 1; i <= steps; i++)
      move({
        x: from.x + ((to.x - from.x) * i) / steps,
        y: from.y + ((to.y - from.y) * i) / steps,
      });
    up(to);
    flush();
  };
  const key = (k: string, mods: Record<string, unknown> = {}) => {
    const prevented = overlay.dispatch('keydown', { key: k, ...mods });
    flush();
    return prevented;
  };
  const strokes = () => {
    layer.ctx.reset();
    chart.renderAll();
    return layer.ctx;
  };
  const bars = data.bars;
  const A = { time: bars[740]!.start, price: bars[740]!.close };
  const B = { time: bars[770]!.start, price: bars[770]!.close };
  const trendLine = () => {
    chart.setDrawingTool('trend-line');
    click(at(A.time, A.price));
    click(at(B.time, B.price));
    return chart.getDrawings().at(-1)!;
  };
  const rectangle = (p0 = 598, p1 = 604) => {
    chart.setDrawingTool('rectangle');
    click(at(A.time, p0));
    click(at(B.time, p1));
    return chart.getDrawings().at(-1)!;
  };
  const mid = () => {
    const pa = at(A.time, A.price);
    const pb = at(B.time, B.price);
    return { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 };
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
    history,
    selections,
    A,
    B,
    trendLine,
    rectangle,
    mid,
  };
}

const lineStrokes = (ctx: ReturnType<ReturnType<typeof setup>['strokes']>) =>
  ctx.strokes.filter((s) => s.arcs.length === 0);

describe('style editing', () => {
  test('color, width and line style apply at once, as one update; anchors untouched', () => {
    const t = setup();
    const d = t.trendLine();
    expect(t.chart.editDrawing(d.id, { style: { color: '#e2484d' } })).toBe(true);
    expect(t.chart.editDrawing(d.id, { style: { lineWidth: 4, lineStyle: 'dashed' } })).toBe(true);
    const edited = t.chart.getDrawings()[0]!;
    expect(edited.anchors).toBe(d.anchors);
    expect(edited.style).toEqual({ color: '#e2484d', lineWidth: 4, lineStyle: 'dashed' });
    expect(t.changes.map((c) => c.change)).toEqual([
      { kind: 'add', id: 'd1', source: 'edit' },
      { kind: 'update', id: 'd1', source: 'edit' },
      { kind: 'update', id: 'd1', source: 'edit' },
    ]);
    const s = lineStrokes(t.strokes())[0]!;
    expect(s.style).toBe('#e2484d');
    expect(s.width).toBe(4 * PR);
    expect(s.dash.length).toBe(2);
    t.chart.editDrawing(d.id, { style: { lineStyle: 'dotted' } });
    const dotted = lineStrokes(t.strokes())[0]!;
    expect(dotted.dash[0]).toBe(dotted.width); // dots as long as the line is wide
  });

  test('rectangle fill color + opacity (rgba) and removing the fill; serializable as v1', () => {
    const t = setup();
    const r = t.rectangle();
    t.chart.editDrawing(r.id, { style: { fillColor: 'rgba(226, 72, 77, 0.35)' } });
    const ctx = t.strokes();
    expect(ctx.rects.some((x) => x.style === 'rgba(226, 72, 77, 0.35)')).toBe(true);
    t.chart.editDrawing(r.id, { style: { fillColor: null } });
    expect(t.chart.getDrawings()[0]!.style.fillColor).toBeUndefined();
    // Without a fill the inside is not a hit (edges still are).
    t.click({ x: 5, y: 5 });
    t.click(t.at(t.bars[755]!.start, 601));
    expect(t.chart.getSelectedDrawingId()).toBeNull();
    const json = JSON.parse(JSON.stringify(serializeDrawings(t.chart.getDrawings())));
    expect(json.version).toBe(1);
    expect(parseDrawingDocument(json)).toEqual(t.chart.getDrawings());
  });

  test('invalid or empty patches are refused without an event or history step', () => {
    const t = setup();
    const d = t.trendLine();
    const before = t.chart.getDrawingHistory();
    expect(t.chart.editDrawing(d.id, { style: { lineWidth: 0 } })).toBe(false);
    expect(t.chart.editDrawing(d.id, { style: { color: '' } })).toBe(false);
    expect(t.chart.editDrawing(d.id, { style: { color: d.style.color } })).toBe(false); // no-op
    expect(t.chart.editDrawing('nope', { locked: true })).toBe(false);
    expect(t.changes).toHaveLength(1);
    expect(t.chart.getDrawingHistory()).toEqual(before);
  });

  test('style edits and hover repaint only the drawing layer, never the candles', () => {
    const t = setup();
    const d = t.trendLine();
    t.main.ctx.reset();
    t.chart.editDrawing(d.id, { style: { color: '#26b27a', lineWidth: 3 } });
    t.move(t.mid());
    t.flush();
    expect(t.main.ctx.clears + t.main.ctx.rects.length).toBe(0);
    expect(t.layer.ctx.clears).toBeGreaterThan(0);
  });
});

describe('lock', () => {
  test('locked: selectable, no handles, no drag (the chart pans instead), no Delete; unlockable', () => {
    const t = setup();
    const d = t.trendLine();
    t.chart.editDrawing(d.id, { locked: true });
    const ctx = t.strokes();
    expect(ctx.strokes.filter((s) => s.arcs.length > 0)).toHaveLength(0); // no edit handles
    expect(ctx.fills.filter((f) => f.arcs.length > 0)).toHaveLength(2); // locked markers
    t.click({ x: 5, y: 5 });
    t.move(t.mid());
    t.flush();
    expect(t.overlay.style.cursor).toBe('pointer');
    const view = { ...t.chart.getView() };
    t.drag(t.mid(), { x: t.mid().x + 80, y: t.mid().y + 40 });
    expect(t.chart.getSelectedDrawingId()).toBe(d.id); // selected by the press
    expect(t.chart.getDrawings()[0]!.anchors).toEqual(d.anchors); // not moved
    expect(t.chart.getView().rightOffset).not.toBe(view.rightOffset); // the chart panned
    // Handles cannot be grabbed either (none are offered).
    const pb = t.at(t.B.time, t.B.price);
    t.drag(pb, { x: pb.x - 60, y: pb.y });
    expect(t.chart.getDrawings()[0]!.anchors).toEqual(d.anchors);
    t.chart.selectDrawing(d.id);
    expect(t.key('Delete')).toBe(false);
    expect(t.chart.deleteDrawing()).toBe(false);
    expect(t.chart.getDrawings()).toHaveLength(1);
    // Style still editable; unlocking makes it movable again.
    expect(t.chart.editDrawing(d.id, { style: { color: '#ffffff' } })).toBe(true);
    t.chart.editDrawing(d.id, { locked: false });
    t.chart.selectDrawing(d.id);
    t.flush();
    t.drag(t.mid(), { x: t.mid().x + 60, y: t.mid().y });
    expect(t.chart.getDrawings()[0]!.anchors).not.toEqual(d.anchors);
  });
});

describe('visibility', () => {
  test('hidden: not painted, not hit, kept with anchors/style, deselected; show restores', () => {
    const t = setup();
    const d = t.trendLine();
    t.chart.editDrawing(d.id, { style: { color: '#f5a623' } });
    expect(t.chart.editDrawing(d.id, { visible: false })).toBe(true);
    expect(t.chart.getSelectedDrawingId()).toBeNull(); // hiding the selection deselects it
    expect(t.strokes().strokes).toEqual([]);
    t.click(t.mid());
    expect(t.chart.getSelectedDrawingId()).toBeNull(); // no hit
    t.chart.selectDrawing(d.id);
    expect(t.chart.getSelectedDrawingId()).toBeNull(); // hidden drawings cannot be selected
    const hidden = t.chart.getDrawings()[0]!;
    expect(hidden).toMatchObject({ visible: false, anchors: d.anchors });
    expect(hidden.style.color).toBe('#f5a623');
    t.chart.editDrawing(d.id, { visible: true });
    expect(lineStrokes(t.strokes())[0]!.style).toBe('#f5a623');
    t.click(t.mid());
    expect(t.chart.getSelectedDrawingId()).toBe(d.id);
  });
});

describe('duplicate', () => {
  test('new id, same type/style, 5 bars later and 4% of the visible range lower, selected, on top', () => {
    const t = setup();
    const d = t.trendLine();
    t.chart.editDrawing(d.id, { style: { color: '#b36bff' }, locked: true });
    const c = t.coords();
    const range = c.yToPrice(c.plot.y) - c.yToPrice(c.plot.y + c.plot.height);
    const id = t.chart.duplicateDrawing(d.id);
    expect(id).toBe('d2');
    const copy = t.chart.getDrawings()[1]!;
    expect(copy).toMatchObject({ id: 'd2', type: 'trend-line', visible: true, locked: false });
    expect(copy.style.color).toBe('#b36bff');
    expect(copy.anchors.map((a) => a.time)).toEqual([t.bars[745]!.start, t.bars[775]!.start]);
    copy.anchors.forEach((a, i) =>
      expect(a.price).toBeCloseTo(d.anchors[i]!.price - 0.04 * range, 9),
    );
    expect(t.chart.getSelectedDrawingId()).toBe('d2');
    expect(t.changes.at(-1)!.change).toEqual({ kind: 'add', id: 'd2', source: 'edit' });
  });

  test('the offset is session-aware: a copy near the session close continues in the next session', () => {
    const t = setup();
    // Both anchors on the last two bars of Mar 12 (15:50 and 15:55): +5 bars crosses the night.
    t.chart.setDrawings([
      line('n', t.bars[700]!.start, 600, t.bars[701]!.start, 601), // Mar 12 15:50, 15:55
    ]);
    t.flush();
    t.chart.duplicateDrawing('n');
    const copy = t.chart.getDrawings()[1]!;
    expect(copy.anchors.map((a) => a.time)).toEqual([t.bars[705]!.start, t.bars[706]!.start]);
    for (const a of copy.anchors) expect(t.data.mapping.toSlot(a.time)).not.toBeNull();
  });

  test('Ctrl+D duplicates the selection; a horizontal line copy moves in price', () => {
    const t = setup();
    t.chart.setDrawingTool('horizontal-line');
    t.click(t.at(t.A.time, 600));
    expect(t.key('d', { ctrlKey: true })).toBe(true); // prevented (no browser bookmark)
    const [orig, copy] = t.chart.getDrawings();
    expect(copy!.anchors[0]!.price).toBeLessThan(orig!.anchors[0]!.price);
  });
});

describe('undo / redo', () => {
  test('create, delete, style, lock and visibility each undo and redo exactly', () => {
    const t = setup();
    const d = t.trendLine();
    t.chart.undoDrawing();
    expect(t.chart.getDrawings()).toEqual([]);
    expect(t.changes.at(-1)!.change).toEqual({ kind: 'remove', id: 'd1', source: 'undo' });
    t.chart.redoDrawing();
    expect(t.chart.getDrawings()).toEqual([d]);
    expect(t.changes.at(-1)!.change).toEqual({ kind: 'add', id: 'd1', source: 'redo' });
    expect(t.chart.getSelectedDrawingId()).toBe('d1');

    t.chart.editDrawing('d1', { style: { color: '#e2484d' } });
    t.chart.editDrawing('d1', { locked: true });
    t.chart.editDrawing('d1', { visible: false });
    t.chart.undoDrawing(); // visible again
    expect(t.chart.getDrawings()[0]).toMatchObject({ visible: true, locked: true });
    t.chart.undoDrawing(); // unlocked
    t.chart.undoDrawing(); // original color
    expect(t.chart.getDrawings()[0]).toEqual(d);
    t.chart.redoDrawing();
    expect(t.chart.getDrawings()[0]!.style.color).toBe('#e2484d');

    t.chart.selectDrawing('d1');
    t.chart.editDrawing('d1', { locked: false });
    t.key('Delete');
    expect(t.chart.getDrawings()).toEqual([]);
    t.key('z', { ctrlKey: true });
    expect(t.chart.getDrawings()).toHaveLength(1);
    expect(t.chart.getSelectedDrawingId()).toBe('d1'); // the deleted drawing comes back selected
  });

  test('a completed drag is ONE history step; undo/redo restore the anchors exactly', () => {
    const t = setup();
    const d = t.trendLine();
    const pb = t.at(t.B.time, t.B.price);
    t.drag(pb, { x: pb.x - 80, y: pb.y + 50 }, 12); // 12 pointer moves
    const moved = t.chart.getDrawings()[0]!;
    expect(moved.anchors).not.toEqual(d.anchors);
    t.chart.undoDrawing();
    expect(t.chart.getDrawings()[0]).toEqual(d); // one undo undoes the whole drag
    t.chart.undoDrawing(); // and the next one the creation
    expect(t.chart.getDrawings()).toEqual([]);
    t.chart.redoDrawing();
    t.chart.redoDrawing();
    expect(t.chart.getDrawings()[0]).toEqual(moved);
    // Whole-line drag too (grabbed at the moved line's midpoint).
    const [m0, m1] = moved.anchors.map((a) => t.at(a.time, a.price));
    const grab = { x: (m0!.x + m1!.x) / 2, y: (m0!.y + m1!.y) / 2 };
    t.drag(grab, { x: grab.x + 50, y: grab.y - 20 }, 10);
    expect(t.chart.getDrawings()[0]).not.toEqual(moved);
    t.chart.undoDrawing();
    expect(t.chart.getDrawings()[0]).toEqual(moved);
  });

  test('a new mutation after undo clears redo; history state events follow', () => {
    const t = setup();
    t.trendLine();
    t.chart.editDrawing('d1', { style: { lineWidth: 3 } });
    t.chart.undoDrawing();
    expect(t.chart.getDrawingHistory()).toEqual({ canUndo: true, canRedo: true });
    t.chart.editDrawing('d1', { style: { lineWidth: 4 } });
    expect(t.chart.getDrawingHistory()).toEqual({ canUndo: true, canRedo: false });
    expect(t.chart.redoDrawing()).toBe(false);
    expect(t.history).toEqual([
      { canUndo: true, canRedo: false },
      { canUndo: true, canRedo: true },
      { canUndo: true, canRedo: false },
    ]);
  });

  test('cancelled gestures, plain clicks and selection never enter the history', () => {
    const t = setup();
    t.trendLine();
    const steps = () => t.changes.length;
    const before = steps();
    const pb = t.at(t.B.time, t.B.price);
    // Escape mid-drag, pointercancel mid-drag, a 2 px jittery click, select/deselect.
    t.down(pb);
    t.move({ x: pb.x - 40, y: pb.y });
    t.key('Escape');
    t.up({ x: pb.x - 40, y: pb.y });
    t.down(pb);
    t.move({ x: pb.x - 40, y: pb.y });
    t.overlay.dispatch('pointercancel', pointer(pb.x - 40, pb.y));
    t.drag(t.mid(), { x: t.mid().x + 2, y: t.mid().y + 1 });
    t.click({ x: 5, y: 5 });
    t.click(t.mid());
    // An unfinished drawing cancelled with Escape.
    t.chart.setDrawingTool('rectangle');
    t.click(t.at(t.A.time, 600));
    t.key('Escape');
    expect(steps()).toBe(before);
    t.chart.undoDrawing(); // the only step is still the creation
    expect(t.chart.getDrawings()).toEqual([]);
    expect(t.chart.getDrawingHistory()).toEqual({ canUndo: false, canRedo: true });
  });

  test('host replacement (setDrawings) clears the history; passing the same array does not', () => {
    const t = setup();
    t.trendLine();
    t.chart.setDrawings(t.chart.getDrawings()); // controlled prop echo: no-op
    expect(t.chart.getDrawingHistory().canUndo).toBe(true);
    t.chart.setDrawings([]); // another set (e.g. symbol switch)
    expect(t.chart.getDrawingHistory()).toEqual({ canUndo: false, canRedo: false });
  });

  test('undo is ignored mid-gesture and never touches view, data or tool', () => {
    const t = setup();
    t.trendLine();
    t.chart.setDrawingTool('rectangle');
    t.click(t.at(t.A.time, 600)); // one corner placed
    expect(t.chart.undoDrawing()).toBe(false);
    t.key('Escape');
    const view = { ...t.chart.getView() };
    expect(t.chart.undoDrawing()).toBe(true);
    expect(t.chart.getView()).toEqual(view);
  });
});

describe('keyboard', () => {
  test('Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y / ⌘Z on the chart; prevented only when they acted', () => {
    const t = setup();
    t.trendLine();
    expect(t.key('z', { ctrlKey: true })).toBe(true);
    expect(t.chart.getDrawings()).toEqual([]);
    expect(t.key('Z', { ctrlKey: true, shiftKey: true })).toBe(true);
    expect(t.chart.getDrawings()).toHaveLength(1);
    t.key('z', { metaKey: true });
    expect(t.key('y', { ctrlKey: true })).toBe(true);
    expect(t.chart.getDrawings()).toHaveLength(1);
    expect(t.key('y', { ctrlKey: true })).toBe(false); // nothing to redo: browser keeps the key
    expect(t.key('z', { ctrlKey: true, altKey: true })).toBe(false);
  });

  test('forwarded page keys: ignored in inputs/selects/textareas and when already handled', () => {
    const t = setup();
    t.trendLine();
    const ev = (target: unknown, extra = {}) => {
      let prevented = false;
      const e = {
        key: 'Delete',
        target,
        preventDefault: () => (prevented = true),
        ...extra,
      };
      return { handled: t.chart.handleKeyDown(e), prevented: () => prevented };
    };
    for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT'])
      expect(ev({ tagName }).handled).toBe(false);
    expect(ev({ tagName: 'DIV', isContentEditable: true }).handled).toBe(false);
    expect(ev({ tagName: 'BUTTON' }, { defaultPrevented: true }).handled).toBe(false);
    expect(t.chart.getDrawings()).toHaveLength(1);
    const r = ev({ tagName: 'BUTTON' }); // e.g. focus on a toolbar button
    expect(r.handled).toBe(true);
    expect(r.prevented()).toBe(true);
    expect(t.chart.getDrawings()).toEqual([]);
  });
});

describe('selection ergonomics', () => {
  test('overlapping drawings: the topmost wins, but a selected drawing keeps precedence', () => {
    const t = setup();
    // Two lines crossing at the middle: "under" first (bottom), "over" second (top).
    const under = line('under', t.A.time, t.A.price, t.B.time, t.B.price);
    const over = line('over', t.A.time, t.B.price, t.B.time, t.A.price);
    t.chart.setDrawings([under, over]);
    t.flush();
    const cross = t.mid();
    t.click(cross);
    expect(t.chart.getSelectedDrawingId()).toBe('over');
    t.chart.selectDrawing('under');
    t.flush();
    t.click(cross);
    expect(t.chart.getSelectedDrawingId()).toBe('under'); // the selection is not stolen
    t.drag(cross, { x: cross.x + 40, y: cross.y }); // and it is the one that moves
    expect(t.chart.getDrawings()[0]!.anchors).not.toEqual(under.anchors);
    expect(t.chart.getDrawings()[1]).toBe(over);
  });

  test('cursor: grab on a movable body, move on a handle, grabbing while dragging', () => {
    const t = setup();
    t.trendLine();
    t.move(t.mid());
    t.flush();
    expect(t.overlay.style.cursor).toBe('grab');
    const pb = t.at(t.B.time, t.B.price);
    t.move(pb);
    t.flush();
    expect(t.overlay.style.cursor).toBe('move');
    t.down(pb);
    t.move({ x: pb.x - 30, y: pb.y });
    expect(t.overlay.style.cursor).toBe('grabbing');
    t.up({ x: pb.x - 30, y: pb.y });
  });
});

describe('lifecycle', () => {
  test('after destroy: commands are refused, keys are not listened to, no callbacks', () => {
    const t = setup();
    t.trendLine();
    const n = t.changes.length;
    t.chart.destroy();
    expect(t.chart.undoDrawing()).toBe(false);
    expect(t.chart.editDrawing('d1', { locked: true })).toBe(false);
    expect(t.chart.duplicateDrawing('d1')).toBeNull();
    expect(t.chart.handleKeyDown({ key: 'z', ctrlKey: true })).toBe(false);
    expect(t.overlay.listenerCount()).toBe(0);
    expect(t.changes).toHaveLength(n);
  });
});

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
