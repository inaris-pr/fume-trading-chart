/**
 * Builds everything a frame needs to paint: layout, viewport, price scale, ticks, time labels and
 * candle rectangles. Pure apart from writing into the reusable candle buffer, so the whole frame
 * is testable without a canvas.
 */
import type { PriceFormatter, TimeFormatter, TimeScaleMapping } from '@fume/core';
import { computeLayout, type ChartLayout, type Rect } from './layout.ts';
import {
  choosePriceStep,
  computePriceRange,
  createPriceScale,
  priceTicks,
  type PriceRange,
  type PriceScale,
} from './price-scale.ts';
import { createViewport, type Viewport } from './viewport.ts';
import { visibleIndexRange, type IndexedSeries } from './series.ts';
import {
  CandleBuffer,
  candleDirection,
  candleWidths,
  computeCandleGeometry,
  type CandleDirection,
} from './geometry.ts';
import { buildTimeAxis, type TimeAxisModel } from './time-labels.ts';

export interface FrameSettings {
  barSpacing: number;
  rightOffset: number;
  priceAxisWidth: number;
  timeAxisHeight: number;
  paddingRatio: number;
  priceLabelSpacing: number;
  timeLabelSpacing: number;
  minPriceStep: number;
}

export const DEFAULT_FRAME_SETTINGS: Readonly<
  Omit<FrameSettings, 'priceAxisWidth' | 'minPriceStep'>
> = {
  barSpacing: 7,
  rightOffset: 6,
  timeAxisHeight: 26,
  paddingRatio: 0.08,
  priceLabelSpacing: 44,
  timeLabelSpacing: 84,
};

export interface FrameInput {
  cssWidth: number;
  cssHeight: number;
  pixelRatio: number;
  series: IndexedSeries;
  mapping: TimeScaleMapping;
  formatPrice: PriceFormatter;
  formatTime: TimeFormatter;
  settings: FrameSettings;
  /** Manual price range (price-scale MANUAL mode). When absent the range auto-fits the visible bars. */
  priceRange?: PriceRange | null;
  /** Indicator panes and price-overlay values (docs/indicators.md); absent: main pane only. */
  indicators?: FrameIndicators;
}

/** What the frame needs from the indicator engine, asked for the visible bar range. */
export interface FrameIndicators {
  /** Indicator panes below the main pane. */
  paneCount: number;
  /** Finite min/max of visible price-overlay values over bars [from, to), or null. */
  overlayRange(from: number, to: number): PriceRange | null;
  /** Vertical scale of indicator pane `pane` (0-based, below the main pane) over bars [from, to). */
  paneScale(pane: number, from: number, to: number): PaneScaleSpec;
}

export type PaneScaleSpec = {
  /** Value formatter for the pane's axis labels. */
  format: (value: number) => string;
  /** Horizontal guide lines (indicator units). */
  guides: readonly number[];
} & (
  | { kind: 'fixed'; range: PriceRange }
  | { kind: 'auto'; includeZero: boolean; range: PriceRange | null }
);

/** One indicator pane of a frame (the main pane's scale is `Frame.priceScale`). */
export interface PaneFrame {
  plot: Rect;
  priceAxis: Rect;
  priceScale: PriceScale | null;
  ticks: PriceTick[];
  guides: { value: number; y: number }[];
  /** Formats this pane's values (axis labels, crosshair readout). */
  format: (value: number) => string;
}

export interface PriceTick {
  price: number;
  y: number;
  text: string;
}

export interface LastPrice {
  price: number;
  y: number;
  text: string;
  direction: CandleDirection;
}

export interface Frame {
  layout: ChartLayout;
  pixelRatio: number;
  viewport: Viewport;
  priceScale: PriceScale | null;
  priceTicks: PriceTick[];
  timeAxis: TimeAxisModel;
  /** Candle rectangles in device px (`candles.count` entries valid). */
  candles: CandleBuffer;
  lastPrice: LastPrice | null;
  /** Index range [from, to) of series bars drawn this frame. */
  visible: { from: number; to: number };
  /** Indicator panes below the main pane, top to bottom (layout.panes[k + 1]). */
  panes: PaneFrame[];
}

/** Gap (CSS px) kept between a pane's edge and its fixed-range extremes (e.g. RSI 0 / 100). */
const PANE_FIXED_INSET = 4;
/** Headroom above the highest visible value of an auto-scaled pane. */
const PANE_AUTO_HEADROOM = 0.1;
const PANE_LABEL_SPACING = 28;

export function buildFrame(input: FrameInput, candles: CandleBuffer): Frame {
  const { settings, series, pixelRatio } = input;
  const layout = computeLayout(
    input.cssWidth,
    input.cssHeight,
    settings.priceAxisWidth,
    settings.timeAxisHeight,
    input.indicators?.paneCount ?? 0,
  );
  const { plot } = layout;
  const lastSlot = series.slots.length > 0 ? series.slots[series.slots.length - 1]! : 0;
  const viewport = createViewport({
    plotLeft: plot.x,
    plotWidth: plot.width,
    barSpacing: settings.barSpacing,
    anchorSlot: lastSlot,
    rightOffset: settings.rightOffset,
  });

  const slots = viewport.visibleSlots();
  // One extra slot each side so candles cut by the plot edge are drawn (and clipped).
  const visible = visibleIndexRange(series.slots, slots.from - 1, slots.to + 1);
  candles.reset(visible.to - visible.from);

  const timeAxis = buildTimeAxis({
    mapping: input.mapping,
    viewport,
    formatTime: input.formatTime,
    minLabelSpacing: settings.timeLabelSpacing,
    edgeMargin: 18,
  });

  const indicators = input.indicators;
  const panes = layout.panes
    .slice(1)
    .map((pane, k) =>
      buildPaneFrame(pane.plot, pane.priceAxis, indicators!.paneScale(k, visible.from, visible.to)),
    );
  const range =
    input.priceRange ??
    computePriceRange(
      series.bars,
      visible.from,
      visible.to,
      { paddingRatio: settings.paddingRatio, minPriceStep: settings.minPriceStep },
      indicators?.overlayRange(visible.from, visible.to) ?? null,
    );
  if (!range || plot.height <= 0 || plot.width <= 0) {
    return {
      layout,
      pixelRatio,
      viewport,
      priceScale: null,
      priceTicks: [],
      timeAxis,
      candles,
      lastPrice: null,
      visible,
      panes,
    };
  }

  const priceScale = createPriceScale(range, plot.y, plot.y + plot.height);
  const step = choosePriceStep(
    range,
    plot.height,
    settings.priceLabelSpacing,
    settings.minPriceStep,
  );
  const ticks = priceTicks(range, step).map((price) => ({
    price,
    y: priceScale.toY(price),
    text: input.formatPrice(price),
  }));

  const widths = candleWidths(settings.barSpacing, pixelRatio);
  const scratch = candles.scratch;
  for (let i = visible.from; i < visible.to; i++) {
    const bar = series.bars[i]!;
    computeCandleGeometry(
      {
        xCenter: viewport.slotToX(series.slots[i]!) * pixelRatio,
        yOpen: priceScale.toY(bar.open) * pixelRatio,
        yHigh: priceScale.toY(bar.high) * pixelRatio,
        yLow: priceScale.toY(bar.low) * pixelRatio,
        yClose: priceScale.toY(bar.close) * pixelRatio,
        open: bar.open,
        close: bar.close,
      },
      widths,
      scratch,
    );
    candles.push(scratch);
  }

  const lastBar = series.bars[series.bars.length - 1];
  const lastPrice = lastBar
    ? {
        price: lastBar.close,
        y: priceScale.toY(lastBar.close),
        text: input.formatPrice(lastBar.close),
        direction: candleDirection(lastBar.open, lastBar.close),
      }
    : null;

  return {
    layout,
    pixelRatio,
    viewport,
    priceScale,
    priceTicks: ticks,
    timeAxis,
    candles,
    lastPrice,
    visible,
    panes,
  };
}

function buildPaneFrame(plot: Rect, priceAxis: Rect, spec: PaneScaleSpec): PaneFrame {
  const empty: PaneFrame = {
    plot,
    priceAxis,
    priceScale: null,
    ticks: [],
    guides: [],
    format: spec.format,
  };
  if (plot.height <= 2 * PANE_FIXED_INSET || plot.width <= 0) return empty;
  let range: PriceRange;
  if (spec.kind === 'fixed') {
    range = spec.range;
  } else {
    const raw = spec.range;
    if (!raw) return empty;
    let min = spec.includeZero ? Math.min(0, raw.min) : raw.min;
    let max = spec.includeZero ? Math.max(0, raw.max) : raw.max;
    if (!(max > min)) max = min + (Math.abs(min) || 1);
    const pad = (max - min) * PANE_AUTO_HEADROOM;
    max += pad;
    if (!spec.includeZero || min < 0) min -= pad;
    range = { min, max };
  }
  const scale = createPriceScale(
    range,
    plot.y + PANE_FIXED_INSET,
    plot.y + plot.height - PANE_FIXED_INSET,
  );
  const values =
    spec.kind === 'fixed' && spec.guides.length > 0
      ? spec.guides
      : priceTicks(range, choosePriceStep(range, plot.height, PANE_LABEL_SPACING, 1e-9));
  return {
    plot,
    priceAxis,
    priceScale: scale,
    ticks: values.map((value) => ({
      price: value,
      y: scale.toY(value),
      text: spec.format(value),
    })),
    guides: spec.guides.map((value) => ({ value, y: scale.toY(value) })),
    format: spec.format,
  };
}
