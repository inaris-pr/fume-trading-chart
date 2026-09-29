/** Price range selection, price <-> y mapping and grid steps. Pure; y is CSS px, down-positive. */
import type { Bar } from '@fume/core';

export interface PriceRange {
  min: number;
  max: number;
}

export interface PriceRangeOptions {
  /** Fraction of the data span added above and below. */
  paddingRatio: number;
  /** Smallest meaningful price increment (instrument tick). */
  minPriceStep: number;
}

/**
 * Visible price range from bars[from..to) (half-open), padded. Degenerate spans (all prices equal
 * or nearly so) are widened to a minimum span so the scale never divides by ~0.
 * Returns null when the range contains no bars.
 */
export function computePriceRange(
  bars: readonly Bar[],
  from: number,
  to: number,
  options: PriceRangeOptions,
): PriceRange | null {
  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;
  for (let i = Math.max(0, from); i < Math.min(to, bars.length); i++) {
    const bar = bars[i]!;
    if (bar.low < low) low = bar.low;
    if (bar.high > high) high = bar.high;
  }
  if (!(low <= high)) return null;
  return padRange({ min: low, max: high }, options);
}

export function padRange(range: PriceRange, options: PriceRangeOptions): PriceRange {
  const mid = (range.min + range.max) / 2;
  const minSpan = Math.max(options.minPriceStep * 4, Math.abs(mid) * 1e-6, 1e-9);
  let { min, max } = range;
  if (max - min < minSpan) {
    min = mid - minSpan / 2;
    max = mid + minSpan / 2;
  }
  const pad = (max - min) * options.paddingRatio;
  return { min: min - pad, max: max + pad };
}

export interface PriceScale {
  readonly range: PriceRange;
  readonly top: number;
  readonly bottom: number;
  toY(price: number): number;
  toPrice(y: number): number;
}

/** Linear mapping of [range.min, range.max] onto [bottom, top] (higher price => smaller y). */
export function createPriceScale(range: PriceRange, top: number, bottom: number): PriceScale {
  const span = range.max - range.min;
  const height = bottom - top;
  if (!(span > 0) || !(height > 0)) {
    throw new Error('Price scale needs a positive price span and pixel height');
  }
  const pxPerPrice = height / span;
  return {
    range,
    top,
    bottom,
    toY: (price) => top + (range.max - price) * pxPerPrice,
    toPrice: (y) => range.max - (y - top) / pxPerPrice,
  };
}

const NICE_MULTIPLIERS = [1, 2, 2.5, 5, 10] as const;

/**
 * Smallest "nice" step (1, 2, 2.5, 5 x 10^n) >= rawStep that is also a whole multiple of the
 * instrument's minimum price step, so grid prices are always valid prices (e.g. with a 1/32 tick,
 * 0.2 is skipped in favour of 0.25). Falls back to rounding up to a tick multiple.
 */
export function niceStep(rawStep: number, minPriceStep: number): number {
  const target = Math.max(rawStep, minPriceStep, Number.MIN_VALUE);
  let exponent = Math.floor(Math.log10(target));
  for (let attempts = 0; attempts < 40; exponent++) {
    const magnitude = 10 ** exponent;
    for (const m of NICE_MULTIPLIERS) {
      const step = m * magnitude;
      if (step < target * (1 - 1e-12)) continue;
      if (isTickMultiple(step, minPriceStep)) return step;
      attempts++;
    }
  }
  return Math.max(1, Math.ceil(target / minPriceStep - 1e-9)) * minPriceStep;
}

function isTickMultiple(step: number, tick: number): boolean {
  if (!(tick > 0)) return true;
  const ratio = step / tick;
  return ratio >= 1 - 1e-9 && Math.abs(ratio - Math.round(ratio)) < 1e-9 * Math.max(1, ratio);
}

/** Step giving grid lines about `targetSpacingPx` apart. */
export function choosePriceStep(
  range: PriceRange,
  heightPx: number,
  targetSpacingPx: number,
  minPriceStep: number,
): number {
  const lines = Math.max(1, heightPx / targetSpacingPx);
  return niceStep((range.max - range.min) / lines, minPriceStep);
}

const MAX_TICKS = 200;

/**
 * Multiples of `step` inside the range. Computed as integer * step (not by accumulation) so
 * floating-point error does not drift across ticks.
 */
export function priceTicks(range: PriceRange, step: number): number[] {
  if (!(step > 0)) return [];
  const first = Math.ceil(range.min / step - 1e-9);
  const last = Math.floor(range.max / step + 1e-9);
  const ticks: number[] = [];
  for (let i = first; i <= last && ticks.length < MAX_TICKS; i++) ticks.push(i * step);
  return ticks;
}
