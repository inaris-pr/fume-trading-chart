/**
 * Paints a Frame onto a 2D context. Everything is drawn in device pixels with an identity
 * transform: rectangles are integer-snapped, so lines and candles are crisp at any DPR.
 * No layout decisions are made here.
 *
 * Order: background, then the main pane (grid, candles, price-overlay indicators, last price),
 * axes and labels, then every indicator pane (separator, grid, guides, series, axis labels).
 */
import type { Bar } from '@fume/core';
import type { Frame, PaneFrame } from './frame.ts';
import { candleWidths } from './geometry.ts';
import type { IndicatorPlot } from './indicators/engine.ts';
import type { ChartTheme } from './theme.ts';

/** The subset of CanvasRenderingContext2D the painter uses (lets tests pass a recorder). */
export type PaintContext = Pick<
  CanvasRenderingContext2D,
  | 'setTransform'
  | 'fillRect'
  | 'fillText'
  | 'measureText'
  | 'save'
  | 'restore'
  | 'beginPath'
  | 'rect'
  | 'clip'
  | 'moveTo'
  | 'lineTo'
  | 'stroke'
  | 'setLineDash'
> & {
  fillStyle: CanvasRenderingContext2D['fillStyle'];
  strokeStyle: CanvasRenderingContext2D['strokeStyle'];
  lineWidth: number;
  lineJoin: CanvasLineJoin;
  font: string;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
};

/** Indicator series to paint with the frame, plus the bar positions they are indexed by. */
export interface IndicatorPaintInput {
  plots: readonly IndicatorPlot[];
  /** slots[i] of bar position i (the frame's viewport maps slots to x). */
  slots: Float64Array;
  /** Bars (histogram direction colors). */
  bars: readonly Bar[];
}

const LAST_PRICE_LABEL_HEIGHT = 18;
const AXIS_TEXT_PADDING = 8;
const DASH = 4;
const GAP = 3;

export function paintFrame(
  ctx: PaintContext,
  frame: Frame,
  theme: ChartTheme,
  indicators?: IndicatorPaintInput,
): void {
  const pr = frame.pixelRatio;
  const { layout } = frame;
  const W = Math.round(layout.width * pr);
  const H = Math.round(layout.height * pr);
  const plotW = Math.round(layout.plot.width * pr);
  const plotH = Math.round(layout.plot.height * pr);
  const line = Math.max(1, Math.floor(pr));

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = theme.background;
  ctx.fillRect(0, 0, W, H);

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, plotW, plotH);
  ctx.clip();

  // Horizontal grid at price ticks, vertical grid at time labels.
  ctx.fillStyle = theme.grid;
  for (const tick of frame.priceTicks) ctx.fillRect(0, Math.round(tick.y * pr), plotW, line);
  for (const label of frame.timeAxis.labels) ctx.fillRect(Math.round(label.x * pr), 0, line, plotH);

  ctx.fillStyle = theme.sessionSeparator;
  for (const x of frame.timeAxis.separators) ctx.fillRect(Math.round(x * pr), 0, line, plotH);

  paintCandles(ctx, frame, theme);
  if (indicators && frame.priceScale)
    paintPlots(ctx, frame, indicators, 0, frame.priceScale.toY, frame.layout.plot);

  if (frame.lastPrice) {
    ctx.fillStyle = directionColor(frame.lastPrice.direction, theme);
    const y = Math.round(frame.lastPrice.y * pr);
    const dash = DASH * pr;
    const gap = GAP * pr;
    for (let x = 0; x < plotW; x += dash + gap) {
      ctx.fillRect(Math.round(x), y, Math.round(Math.min(dash, plotW - x)), line);
    }
  }
  ctx.restore();

  // Axis borders: the price-axis line runs through every pane; the time axis sits below them all.
  const areaH = Math.round(layout.paneArea.height * pr);
  ctx.fillStyle = theme.axisLine;
  ctx.fillRect(plotW, 0, line, areaH);
  ctx.fillRect(0, areaH, W, line);

  ctx.font = `${Math.round(theme.fontSize * pr)}px ${theme.fontFamily}`;
  ctx.textBaseline = 'middle';

  // Price labels (skipping those hidden behind the last-price label).
  ctx.fillStyle = theme.axisText;
  ctx.textAlign = 'left';
  const labelX = plotW + Math.round(AXIS_TEXT_PADDING * pr);
  const lastY = frame.lastPrice?.y;
  for (const tick of frame.priceTicks) {
    if (tick.y < layout.plot.y + 6 || tick.y > layout.plot.y + layout.plot.height - 6) continue;
    if (lastY !== undefined && Math.abs(tick.y - lastY) < LAST_PRICE_LABEL_HEIGHT) continue;
    ctx.fillText(tick.text, labelX, Math.round(tick.y * pr));
  }

  // Time labels, centered under their slot.
  ctx.textAlign = 'center';
  const timeY = Math.round((layout.timeAxis.y + layout.timeAxis.height / 2) * pr);
  for (const label of frame.timeAxis.labels)
    ctx.fillText(label.text, Math.round(label.x * pr), timeY);

  if (frame.lastPrice) {
    const { y, text, direction } = frame.lastPrice;
    const boxH = Math.round(LAST_PRICE_LABEL_HEIGHT * pr);
    // Pinned to the axis edge when the last price is scrolled out of view (manual price scale).
    const boxY = Math.min(Math.max(Math.round(y * pr - boxH / 2), 0), Math.max(0, plotH - boxH));
    ctx.fillStyle = directionColor(direction, theme);
    ctx.fillRect(plotW, boxY, W - plotW, boxH);
    ctx.fillStyle = theme.lastPriceText;
    ctx.textAlign = 'left';
    ctx.fillText(text, labelX, boxY + boxH / 2);
  }

  frame.panes.forEach((pane, k) => paintPane(ctx, frame, pane, k + 1, theme, indicators));
}

/** One indicator pane: separator, grid, guides, series (clipped), then its axis labels. */
function paintPane(
  ctx: PaintContext,
  frame: Frame,
  pane: PaneFrame,
  index: number,
  theme: ChartTheme,
  indicators: IndicatorPaintInput | undefined,
): void {
  const pr = frame.pixelRatio;
  const W = Math.round(frame.layout.width * pr);
  const plotW = Math.round(pane.plot.width * pr);
  const top = Math.round(pane.plot.y * pr);
  const height = Math.round((pane.plot.y + pane.plot.height) * pr) - top;
  const line = Math.max(1, Math.floor(pr));
  if (height <= 0) return;

  ctx.fillStyle = theme.axisLine;
  ctx.fillRect(0, top, W, line); // separator from the pane above
  if (!pane.priceScale) return;

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, top, plotW, height);
  ctx.clip();
  ctx.fillStyle = theme.grid;
  for (const tick of pane.ticks) ctx.fillRect(0, Math.round(tick.y * pr), plotW, line);
  for (const label of frame.timeAxis.labels)
    ctx.fillRect(Math.round(label.x * pr), top, line, height);
  ctx.fillStyle = theme.sessionSeparator;
  for (const x of frame.timeAxis.separators) ctx.fillRect(Math.round(x * pr), top, line, height);
  // Guides (e.g. RSI 30 / 70): dashed.
  ctx.fillStyle = theme.crosshairLine;
  const dash = Math.round(DASH * pr);
  const gap = Math.round(GAP * pr);
  for (const guide of pane.guides) {
    const y = Math.round(guide.y * pr);
    for (let x = 0; x < plotW; x += dash + gap) ctx.fillRect(x, y, Math.min(dash, plotW - x), line);
  }
  if (indicators) paintPlots(ctx, frame, indicators, index, pane.priceScale.toY, pane.plot);
  ctx.restore();

  ctx.font = `${Math.round(theme.fontSize * pr)}px ${theme.fontFamily}`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillStyle = theme.axisText;
  const labelX = plotW + Math.round(AXIS_TEXT_PADDING * pr);
  for (const tick of pane.ticks) {
    if (tick.y < pane.plot.y + 6 || tick.y > pane.plot.y + pane.plot.height - 6) continue;
    ctx.fillText(tick.text, labelX, Math.round(tick.y * pr));
  }
}

/**
 * The series of one pane over the frame's visible bars (plus one bar each side, clipped by the
 * caller). Lines break at positions without a value; nothing is painted during warm-up.
 */
function paintPlots(
  ctx: PaintContext,
  frame: Frame,
  input: IndicatorPaintInput,
  pane: number,
  toY: (value: number) => number,
  plot: { y: number; height: number },
): void {
  const pr = frame.pixelRatio;
  const { viewport, visible } = frame;
  for (const p of input.plots) {
    if (p.pane !== pane) continue;
    const from = Math.max(0, visible.from);
    const to = Math.min(visible.to, p.length);
    if (p.kind === 'line') {
      ctx.strokeStyle = p.color;
      ctx.lineWidth = Math.max(1, Math.round(p.lineWidth * pr));
      ctx.lineJoin = 'round';
      ctx.setLineDash([]);
      ctx.beginPath();
      let drawing = false;
      for (let i = from; i < to; i++) {
        const v = p.values[i]!;
        if (!Number.isFinite(v)) {
          drawing = false;
          continue;
        }
        const x = viewport.slotToX(input.slots[i]!) * pr;
        const y = toY(v) * pr;
        if (drawing) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
        drawing = true;
      }
      ctx.stroke();
    } else {
      const { body } = candleWidths(viewport.barSpacing, pr);
      const zero = Math.round(Math.min(Math.max(toY(0), plot.y), plot.y + plot.height) * pr);
      for (let i = from; i < to; i++) {
        const v = p.values[i]!;
        if (!Number.isFinite(v)) continue;
        const bar = input.bars[i];
        ctx.fillStyle =
          p.directionColors && bar
            ? bar.close >= bar.open
              ? p.directionColors.up
              : p.directionColors.down
            : p.color;
        const x = Math.round(viewport.slotToX(input.slots[i]!) * pr - body / 2);
        const y = Math.round(toY(v) * pr);
        ctx.fillRect(x, Math.min(y, zero), body, Math.max(1, Math.abs(zero - y)));
      }
    }
  }
}

function paintCandles(ctx: PaintContext, frame: Frame, theme: ChartTheme): void {
  const c = frame.candles;
  // One pass per color so fillStyle changes at most three times per frame.
  for (const direction of [1, -1, 0] as const) {
    ctx.fillStyle = directionColor(direction, theme);
    for (let i = 0; i < c.count; i++) {
      if (c.direction[i] !== direction) continue;
      ctx.fillRect(c.wickX[i]!, c.wickY[i]!, c.wickWidth[i]!, c.wickHeight[i]!);
      ctx.fillRect(c.bodyX[i]!, c.bodyY[i]!, c.bodyWidth[i]!, c.bodyHeight[i]!);
    }
  }
}

function directionColor(direction: number, theme: ChartTheme): string {
  return direction > 0 ? theme.upColor : direction < 0 ? theme.downColor : theme.flatColor;
}
