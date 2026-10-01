/**
 * Deterministic hit-testing of drawing geometry in screen space (CSS px), so it keeps working
 * after any zoom, pan, resize or price-scale change: geometry is always the current frame's.
 *
 * Priority (deterministic): handles of the selected (unlocked) drawing, then the selected
 * drawing's body (so a selected drawing under another one can still be dragged), then the other
 * bodies from the top of the z-order (last drawn) down, then empty space (null). Only points
 * inside the plot can hit; hidden drawings have no geometry and never hit.
 */
import type { ChartPoint } from '../coordinates.ts';
import type { Rect } from '../layout.ts';
import type { DrawingGeometry } from './geometry.ts';

/** Max distance (CSS px) from a line for a body hit, on top of half the line width. */
export const HIT_TOLERANCE = 6;
/** Painted handle radius (CSS px). */
export const HANDLE_RADIUS = 5;
/** Max distance (CSS px) from a handle center for a handle hit. */
export const HANDLE_HIT_RADIUS = 9;

export type DrawingHit =
  { kind: 'handle'; id: string; handle: number } | { kind: 'body'; id: string };

export function hitTestDrawings(
  geometries: readonly DrawingGeometry[],
  point: ChartPoint,
  plot: Readonly<Rect>,
  selectedId: string | null,
): DrawingHit | null {
  if (!insideRect(point, plot)) return null;
  const selected =
    selectedId === null ? undefined : geometries.find((g) => g.drawing.id === selectedId);
  if (selected) {
    if (!selected.drawing.locked) {
      let best = -1;
      let bestDist = HANDLE_HIT_RADIUS;
      selected.handles.forEach((h, i) => {
        const d = Math.hypot(point.x - h.x, point.y - h.y);
        if (d <= bestDist) {
          best = i;
          bestDist = d;
        }
      });
      if (best >= 0) return { kind: 'handle', id: selected.drawing.id, handle: best };
    }
    if (hitsBody(selected, point)) return { kind: 'body', id: selected.drawing.id };
  }
  for (let i = geometries.length - 1; i >= 0; i--) {
    const g = geometries[i]!;
    if (hitsBody(g, point)) return { kind: 'body', id: g.drawing.id };
  }
  return null;
}

function hitsBody(g: DrawingGeometry, p: ChartPoint): boolean {
  const tolerance = HIT_TOLERANCE + g.drawing.style.lineWidth / 2;
  const { shape } = g;
  switch (shape.kind) {
    case 'segment':
      return distanceToSegment(p, shape.a, shape.b) <= tolerance;
    case 'horizontal':
      return Math.abs(p.y - shape.y) <= tolerance;
    case 'rect': {
      const inside =
        p.x >= shape.left && p.x <= shape.right && p.y >= shape.top && p.y <= shape.bottom;
      if (inside && g.drawing.style.fillColor !== undefined) return true;
      const nearX = p.x >= shape.left - tolerance && p.x <= shape.right + tolerance;
      const nearY = p.y >= shape.top - tolerance && p.y <= shape.bottom + tolerance;
      return (
        (nearY &&
          (Math.abs(p.x - shape.left) <= tolerance || Math.abs(p.x - shape.right) <= tolerance)) ||
        (nearX &&
          (Math.abs(p.y - shape.top) <= tolerance || Math.abs(p.y - shape.bottom) <= tolerance))
      );
    }
  }
}

/** Euclidean distance from p to the segment ab (to the point when a == b). */
export function distanceToSegment(p: ChartPoint, a: ChartPoint, b: ChartPoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  const t =
    lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function insideRect(p: ChartPoint, r: Readonly<Rect>): boolean {
  return p.x >= r.x && p.x < r.x + r.width && p.y >= r.y && p.y < r.y + r.height;
}
