/**
 * Vertical price-scale mode and manual scaling. Pure.
 *
 * - auto:   the price range is fitted to the visible bars every frame (Stage 1 behavior).
 * - manual: the user has dragged or wheeled the price axis; an absolute price range is kept
 *           through horizontal pan/zoom and resize until auto is restored.
 *
 * Scaling is anchored: the anchor price keeps its vertical position, the range grows or shrinks
 * around it. Candle prices are never modified; only the price -> y transform changes.
 */
import type { PriceRange } from './price-scale.ts';

export type PriceScaleMode = { mode: 'auto' } | { mode: 'manual'; range: PriceRange };

export const AUTO_PRICE_SCALE: PriceScaleMode = { mode: 'auto' };

export interface PriceScaleLimits {
  minSpan: number;
  maxSpan: number;
}

/**
 * Safe span limits.
 * - minSpan: two ticks (or 1e-7 of the price level, whichever is larger).
 * - maxSpan: the largest of 20x the whole data's price span, half the mid price, or 1000x minSpan
 *   (the last two keep flat or tiny series usable).
 */
export function priceScaleLimits(
  dataRange: PriceRange | null,
  minPriceStep: number,
): PriceScaleLimits {
  const tick = minPriceStep > 0 && Number.isFinite(minPriceStep) ? minPriceStep : 1e-6;
  const mid = dataRange ? Math.abs((dataRange.min + dataRange.max) / 2) : 0;
  const minSpan = Math.max(tick * 2, mid * 1e-7, 1e-9);
  const dataSpan = dataRange ? dataRange.max - dataRange.min : 0;
  const maxSpan = Math.max(dataSpan * 20, mid * 0.5, minSpan * 1000);
  return { minSpan, maxSpan };
}

/**
 * Scales `range` by `factor` (> 1 = compress, i.e. show a larger price range) keeping
 * `anchorPrice` at the same fractional height. The result is always finite with a span inside
 * the limits.
 */
export function scalePriceRange(
  range: PriceRange,
  factor: number,
  anchorPrice: number,
  limits: PriceScaleLimits,
): PriceRange {
  const span = range.max - range.min;
  if (!(span > 0) || !Number.isFinite(span)) return range;
  const f = factor > 0 && Number.isFinite(factor) ? factor : 1;
  const nextSpan = clamp(span * f, limits.minSpan, limits.maxSpan);
  const anchor = Number.isFinite(anchorPrice)
    ? clamp(anchorPrice, range.min, range.max)
    : (range.min + range.max) / 2;
  const fromTop = (range.max - anchor) / span;
  const max = anchor + fromTop * nextSpan;
  return { min: max - nextSpan, max };
}

const DRAG_RATE = 0.005; // 100 px drag = e^0.5 = 1.65x
const WHEEL_RATE = 0.002;
const MAX_WHEEL_FACTOR = 2;

/** Drag on the price axis: down (dy > 0) compresses, up stretches. Continuous in dy. */
export function priceDragFactor(dyPx: number): number {
  return Number.isFinite(dyPx) ? Math.exp(dyPx * DRAG_RATE) : 1;
}

/** Wheel on the price axis: scrolling down compresses, up stretches; at most 2x per event. */
export function priceWheelFactor(dyPx: number): number {
  if (!Number.isFinite(dyPx)) return 1;
  return clamp(Math.exp(dyPx * WHEEL_RATE), 1 / MAX_WHEEL_FACTOR, MAX_WHEEL_FACTOR);
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/**
 * Translates a price range vertically by a pointer movement of `dyPx` CSS px on a plot
 * `plotHeightPx` tall, WITHOUT changing its span (translation, not scaling). Uses the same linear
 * price <-> y relation as createPriceScale(): one pixel is (max - min) / plotHeight in price.
 * Dragging down (dy > 0) moves candles down, i.e. the visible window moves up to higher prices.
 * Callers pass the range at drag START and the TOTAL dy, so repeated moves never compound error.
 */
export function translatePriceRange(
  range: PriceRange,
  dyPx: number,
  plotHeightPx: number,
): PriceRange {
  const span = range.max - range.min;
  if (!(span > 0) || !Number.isFinite(span) || !(plotHeightPx > 0) || !Number.isFinite(dyPx)) {
    return range;
  }
  const shift = (dyPx * span) / plotHeightPx;
  const min = range.min + shift;
  return Number.isFinite(min) ? { min, max: min + span } : range;
}

/**
 * Keeps a manually positioned window within reach of the data: its center may move at most
 * `reach` spans beyond the data's low/high. Span is unchanged. Without data, returns `range`.
 */
export function clampPriceRangeCenter(
  range: PriceRange,
  dataRange: PriceRange | null,
  reach = 10,
): PriceRange {
  if (!dataRange) return range;
  const span = range.max - range.min;
  const center = (range.min + range.max) / 2;
  const lo = dataRange.min - reach * span;
  const hi = dataRange.max + reach * span;
  const clamped = center < lo ? lo : center > hi ? hi : center;
  if (clamped === center) return range;
  const min = clamped - span / 2;
  return { min, max: min + span };
}
