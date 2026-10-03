/**
 * Paints the overlay layer: crosshair lines, crosshair price/time readouts, the OHLC legend and
 * the indicator legend rows. Runs on every pointer move, so it only clears and draws a handful of
 * rectangles and strings; candles, the frame model and indicator values are never recomputed.
 */
import type { Bar } from '@fume/core';
import type { Frame } from './frame.ts';
import type { IndicatorLegendRow } from './indicators/engine.ts';
import type { CrosshairModel } from './interaction.ts';
import { candleDirection } from './geometry.ts';
import type { PaintContext } from './paint.ts';
import type { ChartTheme } from './theme.ts';

export type OverlayContext = PaintContext & Pick<CanvasRenderingContext2D, 'clearRect'>;

const LABEL_HEIGHT = 18;
const LABEL_PAD_X = 6;
const DASH = 3;
const GAP = 3;
const LEGEND_X = 8;
const LEGEND_Y = 12;
/** Vertical distance between legend rows (CSS px). */
const LEGEND_ROW = 16;

export function paintOverlay(
  ctx: OverlayContext,
  frame: Frame,
  crosshair: CrosshairModel | null,
  legendBar: Bar | null,
  formatPrice: (price: number) => string,
  theme: ChartTheme,
  indicatorLegend: readonly IndicatorLegendRow[] = [],
): void {
  const pr = frame.pixelRatio;
  const { layout } = frame;
  const W = Math.round(layout.width * pr);
  const H = Math.round(layout.height * pr);
  const plotW = Math.round(layout.plot.width * pr);
  // The vertical line and the time readout span every pane down to the time axis.
  const plotH = Math.round(layout.paneArea.height * pr);
  const line = Math.max(1, Math.floor(pr));

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, W, H);
  ctx.font = `${Math.round(theme.fontSize * pr)}px ${theme.fontFamily}`;
  ctx.textBaseline = 'middle';

  if (crosshair) {
    const x = Math.round(crosshair.x * pr);
    const y = Math.round(crosshair.pointerY * pr);
    ctx.fillStyle = theme.crosshairLine;
    const dash = Math.max(1, Math.round(DASH * pr));
    const gap = Math.max(1, Math.round(GAP * pr));
    if (x >= 0 && x < plotW) {
      for (let yy = 0; yy < plotH; yy += dash + gap)
        ctx.fillRect(x, yy, line, Math.min(dash, plotH - yy));
    }
    // Horizontal line and value readout only in the pane under the pointer.
    const pane = layout.panes[crosshair.pane]?.plot ?? layout.plot;
    const paneTop = Math.round(pane.y * pr);
    const paneBottom = Math.round((pane.y + pane.height) * pr);
    if (crosshair.price !== null) {
      for (let xx = 0; xx < plotW; xx += dash + gap)
        ctx.fillRect(xx, y, Math.min(dash, plotW - xx), line);
    }

    const boxH = Math.round(LABEL_HEIGHT * pr);
    const padX = Math.round(LABEL_PAD_X * pr);
    ctx.textAlign = 'left';

    if (crosshair.priceText !== null) {
      const boxY = clamp(Math.round(y - boxH / 2), paneTop, Math.max(paneTop, paneBottom - boxH));
      ctx.fillStyle = theme.crosshairLabelBackground;
      ctx.fillRect(plotW + line, boxY, W - plotW - line, boxH);
      ctx.fillStyle = theme.crosshairLabelText;
      ctx.fillText(crosshair.priceText, plotW + Math.round(8 * pr), boxY + boxH / 2);
    }

    if (crosshair.timeText !== null) {
      const textW = Math.ceil(ctx.measureText(crosshair.timeText).width);
      const boxW = textW + 2 * padX;
      const boxX = clamp(Math.round(x - boxW / 2), 0, Math.max(0, plotW - boxW));
      const timeTop = plotH + line;
      const timeH = Math.max(0, H - timeTop);
      ctx.fillStyle = theme.crosshairLabelBackground;
      ctx.fillRect(boxX, timeTop, boxW, timeH);
      ctx.fillStyle = theme.crosshairLabelText;
      ctx.fillText(crosshair.timeText, boxX + padX, timeTop + timeH / 2);
    }
  }

  if (legendBar) paintLegend(ctx, legendBar, formatPrice, theme, pr);
  paintIndicatorLegend(ctx, frame, indicatorLegend, theme, pr, legendBar !== null);
}

/**
 * Indicator rows: price overlays below the OHLC row of the main pane, pane indicators at the top
 * of their pane. Each row is "label value [value…]", values in the series' colors.
 */
function paintIndicatorLegend(
  ctx: OverlayContext,
  frame: Frame,
  rows: readonly IndicatorLegendRow[],
  theme: ChartTheme,
  pr: number,
  hasOhlcRow: boolean,
): void {
  const space = Math.round(6 * pr);
  const used = new Map<number, number>();
  ctx.textAlign = 'left';
  for (const row of rows) {
    const pane = frame.layout.panes[row.pane]?.plot;
    if (!pane) continue;
    const n = used.get(row.pane) ?? (row.pane === 0 && hasOhlcRow ? 1 : 0);
    used.set(row.pane, n + 1);
    const yCss = pane.y + LEGEND_Y + n * LEGEND_ROW;
    if (yCss > pane.y + pane.height - 4) continue; // no room left in this pane
    let x = Math.round(LEGEND_X * pr);
    const y = Math.round(yCss * pr);
    ctx.fillStyle = theme.axisText;
    ctx.fillText(row.label, x, y);
    x += ctx.measureText(row.label).width + space;
    for (const value of row.values) {
      ctx.fillStyle = value.color;
      ctx.fillText(value.text, x, y);
      x += ctx.measureText(value.text).width + space;
    }
  }
}

function paintLegend(
  ctx: OverlayContext,
  bar: Bar,
  formatPrice: (price: number) => string,
  theme: ChartTheme,
  pr: number,
): void {
  const direction = candleDirection(bar.open, bar.close);
  const valueColor =
    direction > 0 ? theme.upColor : direction < 0 ? theme.downColor : theme.flatColor;
  let x = Math.round(LEGEND_X * pr);
  const y = Math.round(LEGEND_Y * pr);
  const space = Math.round(4 * pr);
  const groupSpace = Math.round(10 * pr);
  ctx.textAlign = 'left';
  for (const [label, value] of [
    ['O', bar.open],
    ['H', bar.high],
    ['L', bar.low],
    ['C', bar.close],
  ] as const) {
    ctx.fillStyle = theme.axisText;
    ctx.fillText(label, x, y);
    x += ctx.measureText(label).width + space;
    const text = formatPrice(value);
    ctx.fillStyle = valueColor;
    ctx.fillText(text, x, y);
    x += ctx.measureText(text).width + groupSpace;
  }
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}
