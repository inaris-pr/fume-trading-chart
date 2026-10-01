/**
 * Drawing geometry: market anchors -> screen shapes for one frame, and the pure edit operations
 * (move a handle, translate a whole drawing). Recomputed from (time, price) on every frame, so
 * zoom, pan, price scaling, resize, paging and live data never touch the stored anchors.
 */
import type { ChartCoordinates, ChartPoint } from '../coordinates.ts';
import { hasValidAnchors, type Drawing, type DrawingAnchor } from './model.ts';

export type DrawingShape =
  | { kind: 'segment'; a: ChartPoint; b: ChartPoint }
  | { kind: 'horizontal'; y: number }
  | { kind: 'rect'; left: number; top: number; right: number; bottom: number };

export interface DrawingGeometry {
  drawing: Drawing;
  shape: DrawingShape;
  /** Edit handles in handle-index order (see moveHandle). */
  handles: ChartPoint[];
}

/**
 * Screen geometry of a visible drawing, or null when it is hidden, malformed, or an anchor time
 * has no position on this chart's axis (outside the resolved calendar; never extrapolated).
 */
export function drawingGeometry(
  drawing: Drawing,
  coords: ChartCoordinates,
): DrawingGeometry | null {
  if (!drawing.visible || !hasValidAnchors(drawing)) return null;
  const [a0, a1] = drawing.anchors as [DrawingAnchor, DrawingAnchor | undefined];
  switch (drawing.type) {
    case 'horizontal-line': {
      const y = coords.priceToY(a0.price);
      // Only the price matters; the handle sits at the anchor time when it is on the axis.
      const { plot } = coords;
      const x = coords.timeToX(a0.time) ?? plot.x + plot.width / 2;
      const handleX = Math.min(Math.max(x, plot.x), plot.x + plot.width);
      return { drawing, shape: { kind: 'horizontal', y }, handles: [{ x: handleX, y }] };
    }
    case 'trend-line': {
      const a = pointOf(a0, coords);
      const b = a1 ? pointOf(a1, coords) : null;
      if (!a || !b) return null;
      return { drawing, shape: { kind: 'segment', a, b }, handles: [a, b] };
    }
    case 'rectangle': {
      const p0 = pointOf(a0, coords);
      const p1 = a1 ? pointOf(a1, coords) : null;
      if (!p0 || !p1) return null;
      return {
        drawing,
        shape: {
          kind: 'rect',
          left: Math.min(p0.x, p1.x),
          right: Math.max(p0.x, p1.x),
          top: Math.min(p0.y, p1.y),
          bottom: Math.max(p0.y, p1.y),
        },
        // Corner order: [t0,p0], [t1,p0], [t1,p1], [t0,p1] (see RECT_CORNERS).
        handles: [p0, { x: p1.x, y: p0.y }, p1, { x: p0.x, y: p1.y }],
      };
    }
  }
}

export function pointOf(anchor: DrawingAnchor, coords: ChartCoordinates): ChartPoint | null {
  const x = coords.timeToX(anchor.time);
  return x === null ? null : { x, y: coords.priceToY(anchor.price) };
}

/**
 * Anchor for a pointer position: the open time of the nearest bar slot (snapping) and the exact
 * price. null where the axis has no real time (outside the resolved calendar).
 */
export function anchorAt(point: ChartPoint, coords: ChartCoordinates): DrawingAnchor | null {
  const time = coords.xToBarTime(point.x);
  return time === null ? null : { time, price: coords.yToPrice(point.y) };
}

/** Rectangle corner -> [anchor supplying the time, anchor supplying the price]. */
const RECT_CORNERS: readonly (readonly [number, number])[] = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
];

/** The drawing with handle `handle` moved to `anchor` (pure). */
export function moveHandle(drawing: Drawing, handle: number, anchor: DrawingAnchor): Drawing {
  const anchors = drawing.anchors.map((a) => ({ ...a }));
  if (drawing.type === 'rectangle') {
    const corner = RECT_CORNERS[handle];
    if (!corner) return drawing;
    anchors[corner[0]]!.time = anchor.time;
    anchors[corner[1]]!.price = anchor.price;
  } else {
    if (!anchors[handle]) return drawing;
    anchors[handle] = { time: anchor.time, price: anchor.price };
  }
  return { ...drawing, anchors };
}

/**
 * The drawing moved by whole slots (bars of the current timeframe) and a price delta (pure).
 * Each anchor keeps its position inside its bar; times are re-derived through the session axis,
 * so a move across a closed period lands on real open time. null when an anchor would leave the
 * resolved calendar (the move is then not applied). A horizontal line only needs its price.
 */
export function translateDrawing(
  drawing: Drawing,
  slotDelta: number,
  priceDelta: number,
  coords: ChartCoordinates,
): Drawing | null {
  const anchors: DrawingAnchor[] = [];
  for (const a of drawing.anchors) {
    const slot = coords.timeToSlot(a.time);
    const time = slot === null ? null : coords.slotToTime(slot + slotDelta);
    if (time === null && drawing.type !== 'horizontal-line') return null;
    anchors.push({ time: time ?? a.time, price: a.price + priceDelta });
  }
  return { ...drawing, anchors };
}

/** Bars a duplicate is moved right of its original (whole slots of the current timeframe). */
export const DUPLICATE_BAR_OFFSET = 5;
/** Fraction of the visible price range a duplicate is moved down. */
export const DUPLICATE_PRICE_OFFSET = 0.04;

/**
 * The anchors of a duplicate of `drawing` (pure, market units only): moved DUPLICATE_BAR_OFFSET
 * whole bars later through the session axis (so it never lands in closed time) and
 * DUPLICATE_PRICE_OFFSET of the visible price range lower. Falls back to an earlier move, then to
 * a price-only move, where the calendar does not reach far enough.
 */
export function duplicateAnchors(
  drawing: Drawing,
  coords: ChartCoordinates,
): readonly DrawingAnchor[] {
  const { plot } = coords;
  const range = coords.yToPrice(plot.y) - coords.yToPrice(plot.y + plot.height);
  const priceDelta = -DUPLICATE_PRICE_OFFSET * range;
  for (const bars of [DUPLICATE_BAR_OFFSET, -DUPLICATE_BAR_OFFSET]) {
    const moved = translateDrawing(drawing, bars, priceDelta, coords);
    if (moved) return moved.anchors;
  }
  return drawing.anchors.map((a) => ({ time: a.time, price: a.price + priceDelta }));
}
