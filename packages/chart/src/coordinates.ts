/**
 * Public coordinate system of one rendered frame: market coordinates (time, price) <-> plot CSS
 * pixels. Drawings use it today; indicators, AI annotations and order/position overlays are meant
 * to use the same object instead of re-deriving the viewport (docs/drawings.md).
 *
 * Time goes through the session-aware slot coordinate of @fume/core: a bar's open time sits at its
 * candle center, time inside a bar moves linearly towards the next bar's center, closed periods
 * have zero width, and times outside the resolved calendar have no position (null). Pixels are
 * CSS px relative to the chart's top-left corner (pointer offsetX/offsetY).
 */
import type { TimeScaleMapping, UnixMs } from '@fume/core';
import type { Frame } from './frame.ts';
import type { Rect } from './layout.ts';

export interface ChartPoint {
  x: number;
  y: number;
}

export interface ChartCoordinates {
  /** Plot rectangle (CSS px). Overlays clip to it. */
  readonly plot: Readonly<Rect>;
  /** CSS px per slot (bar) at this zoom level. */
  readonly barSpacing: number;
  /** x of a time; null when the time lies outside the resolved calendar. */
  timeToX(time: UnixMs): number | null;
  /** Exact time under x (inside a bar: proportional); null outside the resolved calendar. */
  xToTime(x: number): UnixMs | null;
  /** Open time of the bar slot nearest to x (the snapping used for drawing anchors), or null. */
  xToBarTime(x: number): UnixMs | null;
  priceToY(price: number): number;
  yToPrice(y: number): number;
  /** Lower level: the continuous slot coordinate (see TimeScaleMapping.timeToSlotCoordinate). */
  timeToSlot(time: UnixMs): number | null;
  slotToTime(slot: number): UnixMs | null;
  slotToX(slot: number): number;
  xToSlot(x: number): number;
}

/** Coordinates of a rendered frame, or null while the frame has no price scale (no data/size). */
export function createChartCoordinates(
  frame: Frame,
  mapping: TimeScaleMapping,
): ChartCoordinates | null {
  const priceScale = frame.priceScale;
  if (!priceScale) return null;
  const { viewport } = frame;
  const timeToSlot = (time: UnixMs) => mapping.timeToSlotCoordinate(time);
  const slotToTime = (slot: number) => mapping.slotCoordinateToTime(slot);
  return {
    plot: frame.layout.plot,
    barSpacing: viewport.barSpacing,
    timeToX: (time) => {
      const slot = timeToSlot(time);
      return slot === null ? null : viewport.slotToX(slot);
    },
    xToTime: (x) => slotToTime(viewport.xToSlot(x)),
    xToBarTime: (x) => slotToTime(Math.round(viewport.xToSlot(x))),
    priceToY: (price) => priceScale.toY(price),
    yToPrice: (y) => priceScale.toPrice(y),
    timeToSlot,
    slotToTime,
    slotToX: (slot) => viewport.slotToX(slot),
    xToSlot: (x) => viewport.xToSlot(x),
  };
}
