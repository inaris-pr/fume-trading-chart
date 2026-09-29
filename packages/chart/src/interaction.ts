/**
 * Pointer interaction models. Pure: the chart feeds pointer positions in, gets view changes and
 * crosshair models out. All coordinate conversion goes through the frame's own viewport and price
 * scale, the same objects the renderer used.
 */
import type { Bar, TimeFormatter, TimeScaleMapping } from '@fume/core';
import type { Frame } from './frame.ts';
import type { IndexedSeries } from './series.ts';
import type { PriceRange } from './price-scale.ts';
import { isResolvedSlot } from './time-labels.ts';
import type { ViewState } from './view-state.ts';

// ---------------------------------------------------------------------------------------------
// Drag state machine: horizontal pan (plot) or vertical price scaling (price axis)

export type DragState =
  | { active: false }
  | { active: true; kind: 'pan'; pointerId: number; startX: number; startView: ViewState }
  | {
      active: true;
      kind: 'price';
      pointerId: number;
      startY: number;
      /** Price range when the drag started; every move rescales from here (no accumulation). */
      startRange: PriceRange;
      /** Price under the pointer at drag start; it keeps its height while scaling. */
      anchorPrice: number;
    };

export const IDLE_DRAG: DragState = { active: false };

/** Starts a pan for the primary button only; any other state is kept. */
export function beginDrag(
  state: DragState,
  pointer: { pointerId: number; x: number; button: number },
  view: ViewState,
): DragState {
  if (state.active || pointer.button !== 0) return state;
  return {
    active: true,
    kind: 'pan',
    pointerId: pointer.pointerId,
    startX: pointer.x,
    startView: view,
  };
}

/** Starts a price-axis scaling drag for the primary button only; any other state is kept. */
export function beginPriceDrag(
  state: DragState,
  pointer: { pointerId: number; y: number; button: number },
  range: PriceRange,
  anchorPrice: number,
): DragState {
  if (state.active || pointer.button !== 0) return state;
  return {
    active: true,
    kind: 'price',
    pointerId: pointer.pointerId,
    startY: pointer.y,
    startRange: range,
    anchorPrice,
  };
}

/** Vertical drag distance for a move of the price-dragging pointer, or null. */
export function priceDragDelta(
  state: DragState,
  pointer: { pointerId: number; y: number },
): number | null {
  if (!state.active || state.kind !== 'price' || state.pointerId !== pointer.pointerId) return null;
  return pointer.y - state.startY;
}

/** Horizontal drag distance for a move of the dragging pointer, or null if not dragging it. */
export function dragDelta(
  state: DragState,
  pointer: { pointerId: number; x: number },
): number | null {
  if (!state.active || state.kind !== 'pan' || state.pointerId !== pointer.pointerId) return null;
  return pointer.x - state.startX;
}

/** Ends the drag on release/cancel of the dragging pointer (or unconditionally with null). */
export function endDrag(state: DragState, pointerId: number | null): DragState {
  if (!state.active) return state;
  return pointerId === null || state.pointerId === pointerId ? IDLE_DRAG : state;
}

// ---------------------------------------------------------------------------------------------
// Crosshair

export interface CrosshairModel {
  /** Pointer position, CSS px. */
  pointerX: number;
  pointerY: number;
  /** Nearest slot and its center x (CSS px) — the vertical line snaps here. */
  slot: number;
  x: number;
  /** Price at the pointer's exact y; null when no price scale exists (no visible bars). */
  price: number | null;
  priceText: string | null;
  /** Readout for the slot's start time, e.g. "Mon, Mar 9, 2026, 10:35"; null outside the resolved calendar. */
  timeText: string | null;
  /** Bar at that slot, or null for an empty slot (gap) or a slot beyond the data. */
  bar: Bar | null;
}

export function isInsidePlot(frame: Frame, x: number, y: number): boolean {
  const { plot } = frame.layout;
  return x >= plot.x && x < plot.x + plot.width && y >= plot.y && y < plot.y + plot.height;
}

/** True over the right price axis (the region used for vertical price scaling). */
export function isInsidePriceAxis(frame: Frame, x: number, y: number): boolean {
  const { priceAxis } = frame.layout;
  return (
    x >= priceAxis.x &&
    x < priceAxis.x + priceAxis.width &&
    y >= priceAxis.y &&
    y < priceAxis.y + priceAxis.height
  );
}

/**
 * Crosshair for a pointer at (x, y) in CSS px, or null when the pointer is outside the plot
 * (over an axis or off the chart).
 */
export function computeCrosshair(args: {
  frame: Frame;
  series: IndexedSeries;
  mapping: TimeScaleMapping;
  formatPrice: (price: number) => string;
  formatTime: TimeFormatter;
  pointer: { x: number; y: number };
}): CrosshairModel | null {
  const { frame, series, mapping, pointer } = args;
  if (!isInsidePlot(frame, pointer.x, pointer.y)) return null;
  const slot = Math.round(frame.viewport.xToSlot(pointer.x));
  const price = frame.priceScale ? frame.priceScale.toPrice(pointer.y) : null;
  const intraday = frame.timeAxis.slotDurationMs !== null;
  return {
    pointerX: pointer.x,
    pointerY: pointer.y,
    slot,
    x: frame.viewport.slotToX(slot),
    price,
    priceText: price === null ? null : args.formatPrice(price),
    timeText: isResolvedSlot(mapping, slot)
      ? args.formatTime(mapping.slotStart(slot), intraday ? 'datetime' : 'date')
      : null,
    bar: barAtSlot(series, slot),
  };
}

/** Bar whose slot equals `slot` exactly (binary search), or null for gaps / out-of-range slots. */
export function barAtSlot(series: IndexedSeries, slot: number): Bar | null {
  const { slots } = series;
  let lo = 0;
  let hi = slots.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const value = slots[mid]!;
    if (value === slot) return series.bars[mid] ?? null;
    if (value < slot) lo = mid + 1;
    else hi = mid - 1;
  }
  return null;
}
