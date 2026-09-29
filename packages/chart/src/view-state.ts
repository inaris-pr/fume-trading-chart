/**
 * Horizontal view state and its transitions (zoom, pan, clamping). Pure.
 *
 * The view is { barSpacing, rightOffset }: CSS px per slot, and how many slots the latest bar's
 * slot sits left of the right edge (negative = the latest bar is scrolled off to the right).
 * These are exactly the inputs createViewport() takes, so every transition here is expressed with
 * the same slot <-> x mapping the renderer uses.
 */
import { createViewport } from './viewport.ts';

export interface ViewState {
  barSpacing: number;
  rightOffset: number;
}

export interface ViewContext {
  plotWidth: number;
  /** Slot of the first and latest bar. */
  firstSlot: number;
  lastSlot: number;
}

export interface ViewLimits {
  minBarSpacing: number;
  maxBarSpacing: number;
  /** At least this many bars stay visible at either pan extreme (fewer if the series is shorter). */
  minVisibleBars: number;
  /** Maximum empty space right of the latest bar, as a fraction of the plot width. */
  maxRightOverscroll: number;
}

export const DEFAULT_VIEW_LIMITS: Readonly<ViewLimits> = {
  minBarSpacing: 1,
  maxBarSpacing: 60,
  minVisibleBars: 5,
  maxRightOverscroll: 0.6,
};

/** Keeps spacing within limits and the view within pan bounds. Always returns finite values. */
export function clampView(view: ViewState, ctx: ViewContext, limits: ViewLimits): ViewState {
  const barSpacing = clamp(
    Number.isFinite(view.barSpacing) ? view.barSpacing : limits.minBarSpacing,
    limits.minBarSpacing,
    limits.maxBarSpacing,
  );
  const { min, max } = rightOffsetBounds(barSpacing, ctx, limits);
  const offset = Number.isFinite(view.rightOffset) ? view.rightOffset : max;
  return { barSpacing, rightOffset: clamp(offset, min, max) };
}

/**
 * Pan bounds for rightOffset.
 * - max (latest bar pushed left): at most `maxRightOverscroll` of the plot is empty future space
 *   and at least `minVisibleBars` of the newest bars remain visible.
 * - min (panned into history): at least `minVisibleBars` of the oldest bars remain visible.
 */
export function rightOffsetBounds(
  barSpacing: number,
  ctx: ViewContext,
  limits: ViewLimits,
): { min: number; max: number } {
  const slotsOnScreen = ctx.plotWidth / barSpacing;
  const span = Math.max(0, ctx.lastSlot - ctx.firstSlot);
  const keep = Math.min(limits.minVisibleBars, span + 1);
  const max = Math.max(
    0,
    Math.min(slotsOnScreen * limits.maxRightOverscroll, slotsOnScreen - keep),
  );
  // x(firstSlot) must stay at least `keep` slots inside the right edge:
  // rightX - (rightOffset + 0.5 + span) * s <= rightX - keep * s  =>  rightOffset >= keep - 0.5 - span
  const min = Math.min(keep - 0.5 - span, max);
  return { min, max };
}

/**
 * Zoom by `factor` (> 1 = zoom in) keeping the slot under `anchorX` (plot-relative CSS px) fixed.
 * When the anchor is on or right of the latest bar, the right offset in slots is kept instead, so
 * the live edge does not jump.
 */
export function zoomView(
  view: ViewState,
  factor: number,
  anchorX: number,
  ctx: ViewContext,
  limits: ViewLimits,
): ViewState {
  if (!(factor > 0) || !Number.isFinite(factor)) return clampView(view, ctx, limits);
  const barSpacing = clamp(view.barSpacing * factor, limits.minBarSpacing, limits.maxBarSpacing);
  const before = viewportFor(view, ctx);
  const anchorSlot = before.xToSlot(anchorX);
  if (anchorSlot >= ctx.lastSlot - 0.5) {
    return clampView({ barSpacing, rightOffset: view.rightOffset }, ctx, limits);
  }
  // Solve anchorX = rightX - (rightOffset' + 0.5) * s' - (lastSlot - anchorSlot) * s'.
  const rightOffset = (ctx.plotWidth - anchorX) / barSpacing - (ctx.lastSlot - anchorSlot) - 0.5;
  return clampView({ barSpacing, rightOffset }, ctx, limits);
}

/** Pan by `dxPx` CSS px: positive = content moves right (towards older history). */
export function panView(
  view: ViewState,
  dxPx: number,
  ctx: ViewContext,
  limits: ViewLimits,
): ViewState {
  if (!Number.isFinite(dxPx)) return clampView(view, ctx, limits);
  return clampView(
    { barSpacing: view.barSpacing, rightOffset: view.rightOffset - dxPx / view.barSpacing },
    ctx,
    limits,
  );
}

export interface WheelInput {
  deltaX: number;
  deltaY: number;
  /** 0 = pixels, 1 = lines, 2 = pages (WheelEvent.deltaMode). */
  deltaMode: number;
  /** Trackpad pinch arrives as a wheel event with ctrlKey set in Chromium, Firefox and Safari. */
  ctrlKey: boolean;
}

export type WheelAction = { kind: 'zoom'; factor: number } | { kind: 'pan'; dxPx: number } | null;

const LINE_PX = 16;
const ZOOM_PER_PX = 0.0015;
const PINCH_ZOOM_PER_PX = 0.01;
const MAX_STEP_FACTOR = 2;

/**
 * Normalizes a wheel event: mostly-horizontal scrolling pans, everything else zooms. The zoom
 * factor per event is exponential in the delta (so many small trackpad events compose the same as
 * one large wheel notch) and clamped to [1/2, 2] to avoid jumps.
 */
export function wheelAction(input: WheelInput, pagePx: number): WheelAction {
  const delta = normalizeWheelDelta(input, pagePx);
  if (!delta) return null;
  const { dx, dy } = delta;
  if (!input.ctrlKey && Math.abs(dx) > Math.abs(dy)) return { kind: 'pan', dxPx: -dx };
  const rate = input.ctrlKey ? PINCH_ZOOM_PER_PX : ZOOM_PER_PX;
  const factor = clamp(Math.exp(-dy * rate), 1 / MAX_STEP_FACTOR, MAX_STEP_FACTOR);
  return { kind: 'zoom', factor };
}

/** Wheel deltas in CSS px (line/page modes converted), or null for zero/invalid deltas. */
export function normalizeWheelDelta(
  input: WheelInput,
  pagePx: number,
): { dx: number; dy: number } | null {
  const unit = input.deltaMode === 1 ? LINE_PX : input.deltaMode === 2 ? pagePx : 1;
  const dx = input.deltaX * unit;
  const dy = input.deltaY * unit;
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || (dx === 0 && dy === 0)) return null;
  return { dx, dy };
}

function viewportFor(view: ViewState, ctx: ViewContext) {
  return createViewport({
    plotLeft: 0,
    plotWidth: ctx.plotWidth,
    barSpacing: view.barSpacing,
    anchorSlot: ctx.lastSlot,
    rightOffset: view.rightOffset,
  });
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}
