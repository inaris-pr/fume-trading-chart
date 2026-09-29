/**
 * Candle geometry in DEVICE pixels, snapped to whole pixels so bodies and wicks are crisp at any
 * devicePixelRatio. Pure; the painter only fills the rectangles computed here.
 */

export type CandleDirection = 1 | -1 | 0;

/** close > open: up (1); close < open: down (-1); equal: flat (0). */
export function candleDirection(open: number, close: number): CandleDirection {
  return close > open ? 1 : close < open ? -1 : 0;
}

export interface CandleWidths {
  body: number;
  wick: number;
}

/**
 * Body ~70% of the slot, wick 1 CSS px (floored to whole device px, min 1). Body and wick share
 * parity so the wick is exactly centered on the body. When slots get very narrow the body
 * collapses to the wick width (a plain bar).
 */
export function candleWidths(barSpacingCss: number, pixelRatio: number): CandleWidths {
  const wick = Math.max(1, Math.floor(pixelRatio));
  let body = Math.floor(barSpacingCss * pixelRatio * 0.7);
  if (body <= wick) return { body: wick, wick };
  if ((body - wick) % 2 !== 0) body -= 1;
  return { body, wick };
}

export interface CandleInput {
  /** Slot center, device px (unrounded). */
  xCenter: number;
  /** Price y positions, device px (unrounded). */
  yOpen: number;
  yHigh: number;
  yLow: number;
  yClose: number;
  open: number;
  close: number;
}

export interface CandleGeometry {
  bodyX: number;
  bodyY: number;
  bodyWidth: number;
  bodyHeight: number;
  wickX: number;
  wickY: number;
  wickWidth: number;
  wickHeight: number;
  direction: CandleDirection;
}

/**
 * Writes one candle's rectangles into `out` (reused to avoid per-candle allocation).
 * A body whose open and close map to the same pixel row (e.g. a doji) keeps a minimum height of
 * one wick width, so it never disappears. The wick always spans at least the body.
 */
export function computeCandleGeometry(
  input: CandleInput,
  widths: CandleWidths,
  out: CandleGeometry,
): CandleGeometry {
  const xc = Math.round(input.xCenter);
  const yOpen = Math.round(input.yOpen);
  const yClose = Math.round(input.yClose);
  const bodyTop = Math.min(yOpen, yClose);
  const bodyHeight = Math.max(Math.max(yOpen, yClose) - bodyTop, widths.wick);
  const wickTop = Math.min(Math.round(input.yHigh), bodyTop);
  const wickBottom = Math.max(Math.round(input.yLow), bodyTop + bodyHeight);

  out.bodyX = xc - Math.floor(widths.body / 2);
  out.bodyY = bodyTop;
  out.bodyWidth = widths.body;
  out.bodyHeight = bodyHeight;
  out.wickX = xc - Math.floor(widths.wick / 2);
  out.wickY = wickTop;
  out.wickWidth = widths.wick;
  out.wickHeight = Math.max(wickBottom - wickTop, 1);
  out.direction = candleDirection(input.open, input.close);
  return out;
}

export function emptyCandleGeometry(): CandleGeometry {
  return {
    bodyX: 0,
    bodyY: 0,
    bodyWidth: 0,
    bodyHeight: 0,
    wickX: 0,
    wickY: 0,
    wickWidth: 0,
    wickHeight: 0,
    direction: 0,
  };
}

/**
 * Struct-of-arrays buffer of candle rectangles, grown on demand and reused across frames so the
 * hot path allocates nothing per candle.
 */
export class CandleBuffer {
  /** Per-buffer scratch geometry for computeCandleGeometry (no shared module state). */
  readonly scratch: CandleGeometry = emptyCandleGeometry();
  count = 0;
  bodyX = new Int32Array(0);
  bodyY = new Int32Array(0);
  bodyWidth = new Int32Array(0);
  bodyHeight = new Int32Array(0);
  wickX = new Int32Array(0);
  wickY = new Int32Array(0);
  wickWidth = new Int32Array(0);
  wickHeight = new Int32Array(0);
  direction = new Int8Array(0);

  reset(capacity: number): void {
    this.count = 0;
    if (this.bodyX.length >= capacity) return;
    const size = Math.max(capacity, this.bodyX.length * 2, 64);
    this.bodyX = new Int32Array(size);
    this.bodyY = new Int32Array(size);
    this.bodyWidth = new Int32Array(size);
    this.bodyHeight = new Int32Array(size);
    this.wickX = new Int32Array(size);
    this.wickY = new Int32Array(size);
    this.wickWidth = new Int32Array(size);
    this.wickHeight = new Int32Array(size);
    this.direction = new Int8Array(size);
  }

  push(g: CandleGeometry): void {
    const i = this.count++;
    this.bodyX[i] = g.bodyX;
    this.bodyY[i] = g.bodyY;
    this.bodyWidth[i] = g.bodyWidth;
    this.bodyHeight[i] = g.bodyHeight;
    this.wickX[i] = g.wickX;
    this.wickY[i] = g.wickY;
    this.wickWidth[i] = g.wickWidth;
    this.wickHeight[i] = g.wickHeight;
    this.direction[i] = g.direction;
  }
}
