/**
 * Builds everything a frame needs to paint: layout, viewport, price scale, ticks, time labels and
 * candle rectangles. Pure apart from writing into the reusable candle buffer, so the whole frame
 * is testable without a canvas.
 */
import type { PriceFormatter, TimeFormatter, TimeScaleMapping } from '@fume/core';
import { computeLayout, type ChartLayout } from './layout.ts';
import {
  choosePriceStep,
  computePriceRange,
  createPriceScale,
  priceTicks,
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
}

export function buildFrame(input: FrameInput, candles: CandleBuffer): Frame {
  const { settings, series, pixelRatio } = input;
  const layout = computeLayout(
    input.cssWidth,
    input.cssHeight,
    settings.priceAxisWidth,
    settings.timeAxisHeight,
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

  const range = computePriceRange(series.bars, visible.from, visible.to, {
    paddingRatio: settings.paddingRatio,
    minPriceStep: settings.minPriceStep,
  });
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
  };
}
