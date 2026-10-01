/**
 * Drawing interaction controller: the framework-independent tool state machine plus the drawing
 * set it edits. FumeChart feeds it pointer/keyboard input (CSS px) with the current frame's
 * coordinates; it decides whether the input belongs to drawings (consumed) or to the chart
 * (pan/zoom), mutates drawings immutably and reports user changes. No DOM, no canvas, no React.
 *
 * States (docs/drawings.md):
 *   idle              cursor tool, nothing in progress (selection and hover live beside it)
 *   drawing           a drawing tool is active; 0..n-1 anchors placed, preview follows the pointer
 *   dragging-drawing  moving a whole drawing (by whole bars + a price delta)
 *   dragging-handle   moving one handle (anchor or rectangle corner)
 *
 * Events: onDrawingsChange only for USER edits (add/update/remove; host replacements via
 * setDrawings are not echoed); onToolChange and onSelectionChange for every change. Nothing is
 * reported during a drag: one update is reported when it ends, so hosts never re-render per move.
 */
import type { UnixMs } from '@fume/core';
import type { ChartCoordinates, ChartPoint } from '../coordinates.ts';
import {
  anchorAt,
  drawingGeometry,
  moveHandle,
  pointOf,
  translateDrawing,
  type DrawingGeometry,
} from './geometry.ts';
import { hitTestDrawings, type DrawingHit } from './hit-test.ts';
import {
  ANCHOR_COUNT,
  type Drawing,
  type DrawingAnchor,
  type DrawingChange,
  type DrawingStyle,
  type DrawingTool,
  type DrawingType,
} from './model.ts';

export type DrawingInteractionState =
  | { kind: 'idle' }
  | {
      kind: 'drawing';
      tool: DrawingType;
      /** Anchors placed so far (fewer than the type needs). */
      anchors: readonly DrawingAnchor[];
      /** Snapped anchor under the pointer (the preview's free end). */
      cursor: DrawingAnchor | null;
      /** Where the first anchor was pressed, while that press is still down (drag-to-create). */
      press: { pointerId: number; at: ChartPoint } | null;
    }
  | {
      kind: 'dragging-drawing';
      id: string;
      pointerId: number;
      original: Drawing;
      /** Exact time/price under the pointer when the drag started. */
      startTime: UnixMs;
      startPrice: number;
      moved: boolean;
    }
  | {
      kind: 'dragging-handle';
      id: string;
      pointerId: number;
      original: Drawing;
      handle: number;
      moved: boolean;
    };

export interface DrawingPointer {
  x: number;
  y: number;
  pointerId: number;
  button: number;
}

export interface DrawingControllerOptions {
  /** New drawing ids (default: crypto.randomUUID). */
  createId?: () => string;
  /** Style of a newly created drawing. */
  defaultStyle: (type: DrawingType) => DrawingStyle;
  onDrawingsChange?: (drawings: readonly Drawing[], change: DrawingChange) => void;
  onToolChange?: (tool: DrawingTool) => void;
  onSelectionChange?: (id: string | null) => void;
  /** The drawing layer needs a repaint. */
  onInvalidate?: () => void;
}

/** A press-drag-release longer than this (CSS px) creates a two-anchor drawing in one gesture. */
export const DRAG_CREATE_THRESHOLD = 6;
/** Second click this close (CSS px) to the first anchor is ignored (no zero-length drawings). */
export const MIN_DRAWING_SIZE = 3;

const IDLE: DrawingInteractionState = { kind: 'idle' };

export class DrawingController {
  private drawings: readonly Drawing[] = [];
  private tool: DrawingTool = 'cursor';
  private selectedId: string | null = null;
  private hover: DrawingHit | null = null;
  private state: DrawingInteractionState = IDLE;
  private options: DrawingControllerOptions | null;
  private cache: {
    coords: ChartCoordinates;
    drawings: readonly Drawing[];
    geometries: DrawingGeometry[];
  } | null = null;

  constructor(options: DrawingControllerOptions) {
    this.options = options;
  }

  // --- host API ---------------------------------------------------------------------------------

  getDrawings(): readonly Drawing[] {
    return this.drawings;
  }

  /** Replaces the drawing set (host-owned data; not reported back). Cancels a drag in progress. */
  setDrawings(drawings: readonly Drawing[]): void {
    if (drawings === this.drawings) return;
    if (this.state.kind === 'dragging-drawing' || this.state.kind === 'dragging-handle')
      this.state = IDLE;
    this.drawings = drawings;
    this.hover = null;
    if (this.selectedId !== null && !drawings.some((d) => d.id === this.selectedId))
      this.setSelected(null);
    this.invalidate();
  }

  getTool(): DrawingTool {
    return this.tool;
  }

  /** Activates a tool; any unfinished drawing or drag is cancelled. `cursor` ends drawing. */
  setTool(tool: DrawingTool): void {
    this.cancelInteraction();
    if (tool !== 'cursor') this.setSelected(null);
    this.state = tool === 'cursor' ? IDLE : newDrawingState(tool);
    if (tool !== this.tool) {
      this.tool = tool;
      this.options?.onToolChange?.(tool);
    }
    this.invalidate();
  }

  getSelectedId(): string | null {
    return this.selectedId;
  }

  select(id: string | null): void {
    this.setSelected(id !== null && this.drawings.some((d) => d.id === id) ? id : null);
    this.invalidate();
  }

  getState(): Readonly<DrawingInteractionState> {
    return this.state;
  }

  getHover(): Readonly<DrawingHit> | null {
    return this.hover;
  }

  /**
   * Abandons an unfinished drawing (the tool stays active) or reverts a drag in progress. Used
   * when the chart's data is replaced under the interaction.
   */
  cancelInteraction(): void {
    const s = this.state;
    if (s.kind === 'dragging-drawing' || s.kind === 'dragging-handle') {
      this.replace(s.original);
      this.state = IDLE;
    } else if (s.kind === 'drawing') {
      this.state = newDrawingState(s.tool);
    }
    this.invalidate();
  }

  dispose(): void {
    this.options = null;
    this.cache = null;
  }

  // --- rendering --------------------------------------------------------------------------------

  /** Geometry of all visible drawings for these coordinates, in z-order (memoized per frame). */
  geometries(coords: ChartCoordinates): readonly DrawingGeometry[] {
    const c = this.cache;
    if (c && c.coords === coords && c.drawings === this.drawings) return c.geometries;
    const geometries: DrawingGeometry[] = [];
    for (const d of this.drawings) {
      const g = drawingGeometry(d, coords);
      if (g) geometries.push(g);
    }
    this.cache = { coords, drawings: this.drawings, geometries };
    return geometries;
  }

  /** The unfinished drawing (placed anchors + the pointer), or null. */
  preview(coords: ChartCoordinates): DrawingGeometry | null {
    const s = this.state;
    if (s.kind !== 'drawing' || s.anchors.length === 0 || !s.cursor) return null;
    const needed = ANCHOR_COUNT[s.tool];
    const anchors = [...s.anchors, s.cursor].slice(0, needed);
    if (anchors.length !== needed) return null;
    return drawingGeometry(this.newDrawing('preview', s.tool, anchors), coords);
  }

  hoveredId(): string | null {
    return this.state.kind === 'idle' ? (this.hover?.id ?? null) : null;
  }

  /** Cursor for the current state/hover, or null for the chart's own default. */
  cursor(): string | null {
    const s = this.state;
    if (s.kind === 'dragging-drawing' || s.kind === 'dragging-handle') return 'grabbing';
    if (s.kind === 'drawing') return 'crosshair';
    if (this.hover?.kind === 'handle') return 'move';
    if (this.hover?.kind === 'body') return 'pointer';
    return null;
  }

  /** A drawing gesture owns this pointer (the chart must not pan with it). */
  isCapturing(pointerId: number): boolean {
    const s = this.state;
    if (s.kind === 'dragging-drawing' || s.kind === 'dragging-handle')
      return s.pointerId === pointerId;
    return s.kind === 'drawing' && s.press?.pointerId === pointerId;
  }

  // --- input ------------------------------------------------------------------------------------

  /**
   * Primary-button press inside the plot. Returns true when drawings consumed it; false means
   * empty space in cursor mode (the chart pans; a selection is cleared).
   */
  pointerDown(p: DrawingPointer, coords: ChartCoordinates | null): boolean {
    if (p.button !== 0) return false;
    const s = this.state;
    if (s.kind === 'drawing') {
      if (!coords) return true;
      const anchor = anchorAt(p, coords);
      if (!anchor) return true; // no real time here (outside the calendar): ignore the click
      const needed = ANCHOR_COUNT[s.tool];
      if (s.anchors.length > 0) {
        const first = pointOf(s.anchors[0]!, coords);
        if (first && Math.hypot(first.x - p.x, first.y - p.y) < MIN_DRAWING_SIZE) return true;
      }
      const anchors = [...s.anchors, anchor];
      if (anchors.length >= needed) {
        this.finish(s.tool, anchors);
      } else {
        this.state = { ...s, anchors, cursor: anchor, press: { pointerId: p.pointerId, at: p } };
        this.invalidate();
      }
      return true;
    }
    if (s.kind !== 'idle') return true; // a drag owns the interaction; other pointers do nothing
    if (!coords) return false;

    const hit = hitTestDrawings(this.geometries(coords), p, coords.plot, this.selectedId);
    if (!hit) {
      if (this.selectedId !== null) {
        this.setSelected(null);
        this.invalidate();
      }
      return false;
    }
    const drawing = this.drawings.find((d) => d.id === hit.id);
    if (!drawing) return false;
    this.setSelected(hit.id);
    if (!drawing.locked) {
      if (hit.kind === 'handle') {
        this.state = {
          kind: 'dragging-handle',
          id: hit.id,
          pointerId: p.pointerId,
          original: drawing,
          handle: hit.handle,
          moved: false,
        };
      } else {
        const startTime = coords.xToTime(p.x);
        if (startTime !== null)
          this.state = {
            kind: 'dragging-drawing',
            id: hit.id,
            pointerId: p.pointerId,
            original: drawing,
            startTime,
            startPrice: coords.yToPrice(p.y),
            moved: false,
          };
      }
    }
    this.hover = hit;
    this.invalidate();
    return true;
  }

  /** Pointer movement (drag, preview, hover). Returns true when a drawing gesture consumed it. */
  pointerMove(p: DrawingPointer, coords: ChartCoordinates | null): boolean {
    const s = this.state;
    if (s.kind === 'drawing') {
      const cursor = coords ? anchorAt(p, coords) : null;
      if (cursor) {
        this.state = { ...s, cursor };
        if (s.anchors.length > 0) this.invalidate();
      }
      return s.press?.pointerId === p.pointerId;
    }
    if (s.kind === 'dragging-handle' || s.kind === 'dragging-drawing') {
      if (s.pointerId !== p.pointerId) return false;
      if (!coords) return true;
      let next: Drawing | null = null;
      if (s.kind === 'dragging-handle') {
        const anchor = anchorAt(p, coords);
        if (anchor) next = moveHandle(s.original, s.handle, anchor);
      } else {
        const startSlot = coords.timeToSlot(s.startTime);
        if (startSlot !== null) {
          const slotDelta = Math.round(coords.xToSlot(p.x) - startSlot);
          const priceDelta = coords.yToPrice(p.y) - s.startPrice;
          next = translateDrawing(s.original, slotDelta, priceDelta, coords);
        }
      }
      if (next) {
        this.replace(next);
        this.state = { ...s, moved: true };
        this.invalidate();
      }
      return true;
    }
    if (!coords) return false;
    const hit = hitTestDrawings(this.geometries(coords), p, coords.plot, this.selectedId);
    if (!sameHit(hit, this.hover)) {
      this.hover = hit;
      this.invalidate();
    }
    return false;
  }

  /** Release or cancel of a pointer. Returns true when it ended a drawing gesture. */
  pointerUp(p: DrawingPointer, coords: ChartCoordinates | null, cancelled: boolean): boolean {
    const s = this.state;
    if (s.kind === 'drawing') {
      if (!s.press || s.press.pointerId !== p.pointerId) return false;
      const dragged = Math.hypot(p.x - s.press.at.x, p.y - s.press.at.y) > DRAG_CREATE_THRESHOLD;
      const anchor = !cancelled && dragged && coords ? anchorAt(p, coords) : null;
      if (anchor && s.anchors.length + 1 >= ANCHOR_COUNT[s.tool]) {
        this.finish(s.tool, [...s.anchors, anchor]);
      } else {
        this.state = { ...s, press: null }; // click-click: wait for the next anchor
      }
      return true;
    }
    if (s.kind !== 'dragging-drawing' && s.kind !== 'dragging-handle') return false;
    if (s.pointerId !== p.pointerId) return false;
    this.state = IDLE;
    if (cancelled) {
      this.replace(s.original);
    } else if (s.moved) {
      this.options?.onDrawingsChange?.(this.drawings, { kind: 'update', id: s.id });
    }
    this.invalidate();
    return true;
  }

  pointerLeave(): void {
    if (this.hover && this.state.kind === 'idle') {
      this.hover = null;
      this.invalidate();
    }
  }

  /** Escape cancels / deselects; Delete or Backspace removes the selected drawing. */
  keyDown(key: string): boolean {
    const s = this.state;
    if (key === 'Escape') {
      if (s.kind === 'dragging-drawing' || s.kind === 'dragging-handle') {
        this.cancelInteraction();
        return true;
      }
      if (s.kind === 'drawing') {
        this.setTool('cursor');
        return true;
      }
      if (this.selectedId !== null) {
        this.select(null);
        return true;
      }
      return false;
    }
    if ((key === 'Delete' || key === 'Backspace') && s.kind === 'idle') {
      const id = this.selectedId;
      const drawing = id === null ? undefined : this.drawings.find((d) => d.id === id);
      if (!drawing || drawing.locked) return false;
      this.drawings = this.drawings.filter((d) => d.id !== drawing.id);
      this.hover = null;
      this.options?.onDrawingsChange?.(this.drawings, { kind: 'remove', id: drawing.id });
      this.setSelected(null);
      this.invalidate();
      return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------------------------------

  private finish(type: DrawingType, anchors: readonly DrawingAnchor[]): void {
    const id = this.options?.createId?.() ?? defaultDrawingId();
    const drawing = this.newDrawing(id, type, anchors);
    this.drawings = [...this.drawings, drawing];
    this.options?.onDrawingsChange?.(this.drawings, { kind: 'add', id });
    this.setSelected(id);
    // One drawing per activation (TradingView-like): back to the cursor, new drawing selected.
    this.state = IDLE;
    this.tool = 'cursor';
    this.options?.onToolChange?.('cursor');
    this.invalidate();
  }

  private newDrawing(id: string, type: DrawingType, anchors: readonly DrawingAnchor[]): Drawing {
    const style = this.options?.defaultStyle(type) ?? {
      color: '#5b8cff',
      lineWidth: 2,
      lineStyle: 'solid' as const,
    };
    return { id, type, anchors, style, visible: true, locked: false };
  }

  private replace(drawing: Drawing): void {
    this.drawings = this.drawings.map((d) => (d.id === drawing.id ? drawing : d));
  }

  private setSelected(id: string | null): void {
    if (id === this.selectedId) return;
    this.selectedId = id;
    this.options?.onSelectionChange?.(id);
  }

  private invalidate(): void {
    this.options?.onInvalidate?.();
  }
}

function newDrawingState(tool: DrawingType): DrawingInteractionState {
  return { kind: 'drawing', tool, anchors: [], cursor: null, press: null };
}

function sameHit(a: DrawingHit | null, b: DrawingHit | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind !== b.kind || a.id !== b.id) return false;
  return a.kind === 'body' || (b.kind === 'handle' && a.handle === b.handle);
}

let fallbackCounter = 0;

/** crypto.randomUUID() where available, else a time + counter id (unique per page). */
export function defaultDrawingId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid ?? `d-${Date.now().toString(36)}-${(fallbackCounter++).toString(36)}`;
}
