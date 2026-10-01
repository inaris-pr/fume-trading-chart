/**
 * Drawing interaction controller: the framework-independent tool state machine, the drawing set it
 * edits and its undo/redo history. FumeChart feeds it pointer/keyboard input (CSS px) with the
 * current frame's coordinates; it decides whether the input belongs to drawings (consumed) or to
 * the chart (pan/zoom), mutates drawings immutably and reports user changes. No DOM, no canvas,
 * no React.
 *
 * States (docs/drawings.md):
 *   idle              cursor tool, nothing in progress (selection and hover live beside it)
 *   drawing           a drawing tool is active; 0..n-1 anchors placed, preview follows the pointer
 *   dragging-drawing  moving a whole drawing (by whole bars + a price delta)
 *   dragging-handle   moving one handle (anchor or rectangle corner)
 *
 * One mutation path: every USER mutation (create, drag, handle drag, delete, duplicate, style,
 * lock, visibility) goes through commit(): one history entry and one onDrawingsChange each.
 * Host replacements (setDrawings) are not echoed and clear the history. Nothing is reported during
 * a drag; one update is committed when it ends, so hosts never re-render per pointer move.
 */
import type { UnixMs } from '@fume/core';
import type { ChartCoordinates, ChartPoint } from '../coordinates.ts';
import {
  anchorAt,
  drawingGeometry,
  duplicateAnchors,
  moveHandle,
  pointOf,
  translateDrawing,
  type DrawingGeometry,
} from './geometry.ts';
import {
  DrawingHistory,
  inverseChange,
  type DrawingHistoryEntry,
  type DrawingHistoryState,
} from './history.ts';
import { hitTestDrawings, type DrawingHit } from './hit-test.ts';
import type { DrawingCommand } from './keyboard.ts';
import {
  ANCHOR_COUNT,
  applyDrawingPatch,
  type Drawing,
  type DrawingAnchor,
  type DrawingChange,
  type DrawingPatch,
  type DrawingStyle,
  type DrawingTool,
  type DrawingType,
} from './model.ts';

interface DragBase {
  id: string;
  pointerId: number;
  original: Drawing;
  /** The whole drawing set when the drag started (restored exactly on cancel; history "before"). */
  startDrawings: readonly Drawing[];
  /** Where the press happened; nothing moves until the pointer leaves DRAG_START_THRESHOLD. */
  press: ChartPoint;
  moved: boolean;
}

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
  | (DragBase & {
      kind: 'dragging-drawing';
      /** Exact time/price under the pointer when the drag started. */
      startTime: UnixMs;
      startPrice: number;
    })
  | (DragBase & { kind: 'dragging-handle'; handle: number });

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
  onHistoryChange?: (state: DrawingHistoryState) => void;
  /** The drawing layer needs a repaint. */
  onInvalidate?: () => void;
}

/** A press-drag-release longer than this (CSS px) creates a two-anchor drawing in one gesture. */
export const DRAG_CREATE_THRESHOLD = 6;
/** Second click this close (CSS px) to the first anchor is ignored (no zero-length drawings). */
export const MIN_DRAWING_SIZE = 3;
/** A press on a drawing only starts moving it beyond this distance (CSS px): clicks never nudge. */
export const DRAG_START_THRESHOLD = 3;

const IDLE: DrawingInteractionState = { kind: 'idle' };

export class DrawingController {
  private drawings: readonly Drawing[] = [];
  private tool: DrawingTool = 'cursor';
  private selectedId: string | null = null;
  private hover: DrawingHit | null = null;
  private state: DrawingInteractionState = IDLE;
  private options: DrawingControllerOptions | null;
  private readonly history = new DrawingHistory();
  private reportedHistory = 'false|false';
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

  /**
   * Replaces the drawing set (host-owned data; not reported back). Cancels a drag in progress and
   * clears the undo history, which described the previous set. The same array is a no-op.
   */
  setDrawings(drawings: readonly Drawing[]): void {
    if (drawings === this.drawings) return;
    if (this.state.kind === 'dragging-drawing' || this.state.kind === 'dragging-handle')
      this.state = IDLE;
    this.drawings = drawings;
    this.hover = null;
    this.history.clear();
    this.reportHistory();
    if (this.selectedId !== null && !this.isSelectable(this.selectedId)) this.setSelected(null);
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

  /** Selects a visible drawing (hidden or unknown ids clear the selection). */
  select(id: string | null): void {
    this.setSelected(id !== null && this.isSelectable(id) ? id : null);
    this.invalidate();
  }

  getState(): Readonly<DrawingInteractionState> {
    return this.state;
  }

  getHover(): Readonly<DrawingHit> | null {
    return this.hover;
  }

  getHistoryState(): DrawingHistoryState {
    return this.history.state();
  }

  /**
   * Abandons an unfinished drawing (the tool stays active) or reverts a drag in progress. Used
   * when the chart's data is replaced under the interaction. Never enters the history.
   */
  cancelInteraction(): void {
    const s = this.state;
    if (s.kind === 'dragging-drawing' || s.kind === 'dragging-handle') {
      this.drawings = s.startDrawings;
      this.state = IDLE;
    } else if (s.kind === 'drawing') {
      this.state = newDrawingState(s.tool);
    }
    this.invalidate();
  }

  dispose(): void {
    this.options = null;
    this.cache = null;
    this.history.clear();
  }

  // --- user commands (toolbar, context controls, keyboard) ---------------------------------------

  /**
   * Edits a drawing's style, visibility or lock state (allowed on locked drawings, so they can be
   * restyled and unlocked). Hiding the selected drawing deselects it. Returns false for an unknown
   * id, an invalid patch, a patch that changes nothing, or while a gesture is in progress.
   */
  edit(id: string, patch: DrawingPatch): boolean {
    if (!this.isQuiet()) return false;
    const drawing = this.find(id);
    if (!drawing) return false;
    const next = applyDrawingPatch(drawing, patch);
    if (!next || next === drawing) return false;
    const selectAfter = !next.visible && this.selectedId === id ? null : this.selectedId;
    this.commit(
      this.drawings.map((d) => (d.id === id ? next : d)),
      { kind: 'update', id },
      selectAfter,
    );
    return true;
  }

  /**
   * Duplicates a drawing (default: the selected one) next to it (see duplicateAnchors), on top of
   * the z-order, visible and unlocked, and selects it. Returns the new id, or null.
   */
  duplicate(id: string | null, coords: ChartCoordinates | null): string | null {
    if (!this.isQuiet() || !coords) return null;
    const original = this.find(id ?? this.selectedId);
    if (!original) return null;
    const newId = this.options?.createId?.() ?? defaultDrawingId();
    const copy: Drawing = {
      ...original,
      id: newId,
      anchors: duplicateAnchors(original, coords),
      visible: true,
      locked: false,
    };
    this.commit([...this.drawings, copy], { kind: 'add', id: newId }, newId);
    return newId;
  }

  /** Deletes a drawing (default: the selected one). Locked drawings are refused. */
  remove(id: string | null = null): boolean {
    if (!this.isQuiet()) return false;
    const drawing = this.find(id ?? this.selectedId);
    if (!drawing || drawing.locked) return false;
    this.hover = null;
    const selectAfter = this.selectedId === drawing.id ? null : this.selectedId;
    this.commit(
      this.drawings.filter((d) => d.id !== drawing.id),
      { kind: 'remove', id: drawing.id },
      selectAfter,
    );
    return true;
  }

  undo(): boolean {
    if (!this.isQuiet()) return false;
    const entry = this.history.undo();
    if (!entry) return false;
    this.restore(entry.before, entry.selectedBefore, {
      ...inverseChange(entry.change),
      source: 'undo',
    });
    return true;
  }

  redo(): boolean {
    if (!this.isQuiet()) return false;
    const entry = this.history.redo();
    if (!entry) return false;
    this.restore(entry.after, entry.selectedAfter, { ...entry.change, source: 'redo' });
    return true;
  }

  /** A keyboard command (drawings/keyboard.ts). Returns whether it did something. */
  command(cmd: DrawingCommand, coords: ChartCoordinates | null): boolean {
    const s = this.state;
    switch (cmd) {
      case 'cancel':
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
      case 'delete':
        return s.kind === 'idle' && this.remove();
      case 'undo':
        return this.undo();
      case 'redo':
        return this.redo();
      case 'duplicate':
        return s.kind === 'idle' && this.duplicate(null, coords) !== null;
    }
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
    if (this.hover?.kind === 'body') return this.find(this.hover.id)?.locked ? 'pointer' : 'grab';
    return null;
  }

  /** A drawing gesture owns this pointer (the chart must not pan with it). */
  isCapturing(pointerId: number): boolean {
    const s = this.state;
    if (s.kind === 'dragging-drawing' || s.kind === 'dragging-handle')
      return s.pointerId === pointerId;
    return s.kind === 'drawing' && s.press?.pointerId === pointerId;
  }

  // --- pointer input ----------------------------------------------------------------------------

  /**
   * Primary-button press inside the plot. Returns true when drawings consumed it. False means the
   * chart handles it (pan): empty space (a selection is cleared) or a locked drawing (selected,
   * and the chart can still be panned by dragging across it).
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
    const drawing = this.find(hit.id);
    if (!drawing) return false;
    this.setSelected(hit.id);
    this.hover = hit;
    this.invalidate();
    if (drawing.locked) return false;
    const base = {
      id: hit.id,
      pointerId: p.pointerId,
      original: drawing,
      startDrawings: this.drawings,
      press: { x: p.x, y: p.y },
      moved: false,
    };
    if (hit.kind === 'handle') {
      this.state = { ...base, kind: 'dragging-handle', handle: hit.handle };
    } else {
      const startTime = coords.xToTime(p.x);
      if (startTime !== null)
        this.state = {
          ...base,
          kind: 'dragging-drawing',
          startTime,
          startPrice: coords.yToPrice(p.y),
        };
    }
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
      if (!s.moved && Math.hypot(p.x - s.press.x, p.y - s.press.y) <= DRAG_START_THRESHOLD)
        return true;
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
        this.drawings = s.startDrawings.map((d) => (d.id === next.id ? next : d));
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
    const after = this.drawings;
    this.drawings = s.startDrawings;
    if (!cancelled && s.moved && after !== s.startDrawings) {
      this.commit(after, { kind: 'update', id: s.id }, this.selectedId);
    } else {
      this.invalidate(); // cancelled or a plain click: exactly the set before the press
    }
    return true;
  }

  pointerLeave(): void {
    if (this.hover && this.state.kind === 'idle') {
      this.hover = null;
      this.invalidate();
    }
  }

  // ---------------------------------------------------------------------------------------------

  /** The single path for user mutations: history entry, change event, selection, repaint. */
  private commit(
    next: readonly Drawing[],
    change: Pick<DrawingChange, 'kind' | 'id'>,
    selectAfter: string | null,
  ): void {
    const entry: DrawingHistoryEntry = {
      before: this.drawings,
      after: next,
      selectedBefore: this.selectedId,
      selectedAfter: selectAfter,
      change,
    };
    this.drawings = next;
    this.history.push(entry);
    this.options?.onDrawingsChange?.(next, { ...change, source: 'edit' });
    this.setSelected(selectAfter);
    this.reportHistory();
    this.invalidate();
  }

  private restore(
    drawings: readonly Drawing[],
    selected: string | null,
    change: DrawingChange,
  ): void {
    this.drawings = drawings;
    this.hover = null;
    this.options?.onDrawingsChange?.(drawings, change);
    this.setSelected(selected !== null && this.isSelectable(selected) ? selected : null);
    this.reportHistory();
    this.invalidate();
  }

  private finish(type: DrawingType, anchors: readonly DrawingAnchor[]): void {
    const id = this.options?.createId?.() ?? defaultDrawingId();
    const drawing = this.newDrawing(id, type, anchors);
    // One drawing per activation (TradingView-like): back to the cursor, new drawing selected.
    this.state = IDLE;
    this.commit([...this.drawings, drawing], { kind: 'add', id }, id);
    this.tool = 'cursor';
    this.options?.onToolChange?.('cursor');
  }

  private newDrawing(id: string, type: DrawingType, anchors: readonly DrawingAnchor[]): Drawing {
    const style = this.options?.defaultStyle(type) ?? {
      color: '#5b8cff',
      lineWidth: 2,
      lineStyle: 'solid' as const,
    };
    return { id, type, anchors, style, visible: true, locked: false };
  }

  /** No gesture in progress (an active tool without placed anchors counts as quiet). */
  private isQuiet(): boolean {
    const s = this.state;
    return s.kind === 'idle' || (s.kind === 'drawing' && s.anchors.length === 0);
  }

  private find(id: string | null): Drawing | undefined {
    return id === null ? undefined : this.drawings.find((d) => d.id === id);
  }

  private isSelectable(id: string): boolean {
    return this.find(id)?.visible === true;
  }

  private setSelected(id: string | null): void {
    if (id === this.selectedId) return;
    this.selectedId = id;
    this.options?.onSelectionChange?.(id);
  }

  private reportHistory(): void {
    const state = this.history.state();
    const key = `${state.canUndo}|${state.canRedo}`;
    if (key === this.reportedHistory) return;
    this.reportedHistory = key;
    this.options?.onHistoryChange?.(state);
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
