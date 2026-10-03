/**
 * Indicator definitions (docs/indicators.md): everything the engine needs to know about one
 * indicator type — placement, parameters, styles, outputs, scale, guides — plus its calculator.
 * Engines (the chart) read definitions; they never switch on indicator types.
 */

/** The bar fields indicators read. Structurally a subset of @fume/core's `Bar`. */
export interface IndicatorBar {
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
}

/** `overlay`: drawn on the main price pane with its price scale; `pane`: its own pane below. */
export type IndicatorPlacement = 'overlay' | 'pane';

/** An integer parameter (e.g. a period). Validation is part of the definition, not the engine. */
export interface IndicatorParamSpec {
  readonly key: string;
  readonly label: string;
  readonly kind: 'integer';
  readonly min: number;
  readonly max: number;
  readonly default: number;
}

export interface IndicatorStyleSpec {
  readonly key: string;
  readonly label: string;
  /** `color`: a CSS color string; `lineWidth`: CSS px, 0.5..5. */
  readonly kind: 'color' | 'lineWidth';
  readonly default: string | number;
}

/** One output series of an indicator (an indicator may have several, e.g. MACD later). */
export interface IndicatorOutputSpec {
  readonly key: string;
  readonly label: string;
  readonly plot: 'line' | 'histogram';
  /** Style key holding the color. */
  readonly color: string;
  /** Style key holding the line width (lines). */
  readonly lineWidth?: string;
  /** Histogram bars colored by their candle's direction (close >= open: up) with these style keys. */
  readonly directionColors?: { readonly up: string; readonly down: string };
}

/**
 * Vertical scale. Overlays always use the main price scale (`price`). Panes either fit the visible
 * values (`auto`, optionally always including zero) or use a fixed range.
 */
export type IndicatorScale =
  | { readonly kind: 'price' }
  | { readonly kind: 'auto'; readonly includeZero: boolean }
  | { readonly kind: 'fixed'; readonly min: number; readonly max: number };

/** How values are shown in legends and pane axes. `price` uses the instrument's price format. */
export type IndicatorValueFormat = 'price' | 'volume' | 'number';

/**
 * Incremental calculator for one indicator instance. Outputs and any internal per-bar state are
 * indexed by bar position. `update` recomputes positions [from, bars.length) and may rely on
 * everything before `from` being correct, so results are identical whether reached from scratch
 * or through any sequence of suffix updates. Values without enough data are NaN (never Infinity).
 */
export interface IndicatorCalculator {
  /** Grow internal per-bar state to hold at least `capacity` bars, keeping existing values. */
  ensureCapacity(capacity: number): void;
  update(bars: readonly IndicatorBar[], from: number, outputs: readonly Float64Array[]): void;
}

export interface IndicatorDefinition {
  /** Stable type id stored in the schema (e.g. `sma`). */
  readonly type: string;
  readonly name: string;
  readonly placement: IndicatorPlacement;
  readonly params: readonly IndicatorParamSpec[];
  readonly style: readonly IndicatorStyleSpec[];
  readonly outputs: readonly IndicatorOutputSpec[];
  readonly scale: IndicatorScale;
  /** Horizontal reference lines in the indicator's own units (e.g. RSI 30 / 70). */
  readonly guides: readonly number[];
  readonly valueFormat: IndicatorValueFormat;
  /** Short legend label for these (already validated) parameters, e.g. `SMA 20`. */
  label(params: Readonly<Record<string, number>>): string;
  createCalculator(params: Readonly<Record<string, number>>): IndicatorCalculator;
}

/** Copies `source` into a new array of at least `capacity` (amortized doubling), keeping values. */
export function grow(
  source: Float64Array<ArrayBuffer>,
  capacity: number,
): Float64Array<ArrayBuffer> {
  if (source.length >= capacity) return source;
  const next = new Float64Array(Math.max(capacity, source.length * 2, 64)).fill(Number.NaN);
  next.set(source);
  return next;
}

/** The value, or NaN when it is not finite (no Infinity ever reaches a renderer). */
export function finiteOrNaN(value: number): number {
  return Number.isFinite(value) ? value : Number.NaN;
}
