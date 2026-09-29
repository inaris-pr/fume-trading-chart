/**
 * Paints a Frame onto a 2D context. Everything is drawn in device pixels with an identity
 * transform: rectangles are integer-snapped, so lines and candles are crisp at any DPR.
 * No layout decisions are made here.
 */
import type { Frame } from './frame.ts';
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
> & {
  fillStyle: CanvasRenderingContext2D['fillStyle'];
  font: string;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
};

const LAST_PRICE_LABEL_HEIGHT = 18;
const AXIS_TEXT_PADDING = 8;
const DASH = 4;
const GAP = 3;

export function paintFrame(ctx: PaintContext, frame: Frame, theme: ChartTheme): void {
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

  // Axis borders.
  ctx.fillStyle = theme.axisLine;
  ctx.fillRect(plotW, 0, line, plotH);
  ctx.fillRect(0, plotH, W, line);

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
