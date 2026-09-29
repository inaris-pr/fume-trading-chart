/** Chart regions in CSS pixels. Pure. */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ChartLayout {
  width: number;
  height: number;
  /** Candles, grid and overlays. */
  plot: Rect;
  /** Right-hand price scale. */
  priceAxis: Rect;
  /** Bottom time scale. */
  timeAxis: Rect;
}

export function computeLayout(
  width: number,
  height: number,
  priceAxisWidth: number,
  timeAxisHeight: number,
): ChartLayout {
  const w = Math.max(0, width);
  const h = Math.max(0, height);
  const axisW = Math.min(Math.max(0, priceAxisWidth), w);
  const axisH = Math.min(Math.max(0, timeAxisHeight), h);
  const plotW = w - axisW;
  const plotH = h - axisH;
  return {
    width: w,
    height: h,
    plot: { x: 0, y: 0, width: plotW, height: plotH },
    priceAxis: { x: plotW, y: 0, width: axisW, height: plotH },
    timeAxis: { x: 0, y: plotH, width: plotW, height: axisH },
  };
}

/**
 * Backing-store size for a canvas displayed at `cssWidth` x `cssHeight`.
 * When the browser reports the exact device-pixel content box it is used as-is (sharpest);
 * otherwise CSS size * devicePixelRatio is rounded.
 */
export function backingStoreSize(
  cssWidth: number,
  cssHeight: number,
  devicePixelRatio: number,
  exactDevice?: { width: number; height: number },
): { width: number; height: number; pixelRatio: number } {
  const dpr = devicePixelRatio > 0 && Number.isFinite(devicePixelRatio) ? devicePixelRatio : 1;
  const width = Math.max(0, exactDevice?.width ?? Math.round(cssWidth * dpr));
  const height = Math.max(0, exactDevice?.height ?? Math.round(cssHeight * dpr));
  const pixelRatio = cssWidth > 0 ? width / cssWidth : dpr;
  return { width, height, pixelRatio };
}
