/**
 * Paints the overlay layer: crosshair lines, crosshair price/time readouts and the OHLC legend.
 * Runs on every pointer move, so it only clears and draws a handful of rectangles and strings;
 * candles and the frame model are never rebuilt for it.
 */
import type { Bar } from '@fume/core';
import type { Frame } from './frame.ts';
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

export function paintOverlay(
  ctx: OverlayContext,
  frame: Frame,
  crosshair: CrosshairModel | null,
  legendBar: Bar | null,
  formatPrice: (price: number) => string,
  theme: ChartTheme,
): void {
  const pr = frame.pixelRatio;
  const { layout } = frame;
  const W = Math.round(layout.width * pr);
  const H = Math.round(layout.height * pr);
  const plotW = Math.round(layout.plot.width * pr);
  const plotH = Math.round(layout.plot.height * pr);
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
    if (crosshair.price !== null) {
      for (let xx = 0; xx < plotW; xx += dash + gap)
        ctx.fillRect(xx, y, Math.min(dash, plotW - xx), line);
    }

    const boxH = Math.round(LABEL_HEIGHT * pr);
    const padX = Math.round(LABEL_PAD_X * pr);
    ctx.textAlign = 'left';

    if (crosshair.priceText !== null) {
      const boxY = clamp(Math.round(y - boxH / 2), 0, plotH - boxH);
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
