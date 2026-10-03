/** Chart regions in CSS pixels. Pure. */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One vertically stacked pane: its plot and its own price axis to the right. */
export interface PaneLayout {
  plot: Rect;
  priceAxis: Rect;
}

export interface ChartLayout {
  width: number;
  height: number;
  /** The MAIN price pane's plot: candles, price overlays and drawings. */
  plot: Rect;
  /** The main pane's price scale (manual price scaling happens here). */
  priceAxis: Rect;
  /** Bottom time scale, shared by every pane (below the last one). */
  timeAxis: Rect;
  /** All panes top to bottom; panes[0] is the main pane (same rects as plot / priceAxis). */
  panes: PaneLayout[];
  /** Union of every pane's plot: the area where the time axis, crosshair and panning apply. */
  paneArea: Rect;
}

/** Default height of one indicator pane as a share of the panes' total height. */
export const PANE_SHARE = 0.2;
/** Preferred minimum / maximum indicator pane height (CSS px) while space allows. */
export const PANE_MIN_HEIGHT = 40;
export const PANE_MAX_HEIGHT = 160;
/** Indicator panes together never take more than this share; the main pane keeps the rest. */
export const PANES_MAX_SHARE = 0.5;

/**
 * Heights of [main, pane1, pane2, …] for `total` CSS px and `count` indicator panes (fixed
 * proportions; deterministic; always summing to `total`). Each indicator pane gets PANE_SHARE of
 * the height within [PANE_MIN_HEIGHT, PANE_MAX_HEIGHT]; when that would exceed PANES_MAX_SHARE
 * (small charts, many panes) they shrink evenly, so the main pane always keeps at least half.
 */
export function paneHeights(total: number, count: number): number[] {
  const h = Math.max(0, total);
  if (count <= 0) return [h];
  let pane = Math.min(PANE_MAX_HEIGHT, Math.max(PANE_MIN_HEIGHT, Math.round(h * PANE_SHARE)));
  if (pane * count > h * PANES_MAX_SHARE) pane = Math.floor((h * PANES_MAX_SHARE) / count);
  return [h - pane * count, ...Array<number>(count).fill(pane)];
}

export function computeLayout(
  width: number,
  height: number,
  priceAxisWidth: number,
  timeAxisHeight: number,
  indicatorPanes = 0,
): ChartLayout {
  const w = Math.max(0, width);
  const h = Math.max(0, height);
  const axisW = Math.min(Math.max(0, priceAxisWidth), w);
  const axisH = Math.min(Math.max(0, timeAxisHeight), h);
  const plotW = w - axisW;
  const plotH = h - axisH;
  const panes: PaneLayout[] = [];
  let y = 0;
  for (const paneH of paneHeights(plotH, indicatorPanes)) {
    panes.push({
      plot: { x: 0, y, width: plotW, height: paneH },
      priceAxis: { x: plotW, y, width: axisW, height: paneH },
    });
    y += paneH;
  }
  const main = panes[0]!;
  return {
    width: w,
    height: h,
    plot: main.plot,
    priceAxis: main.priceAxis,
    timeAxis: { x: 0, y: plotH, width: plotW, height: axisH },
    panes,
    paneArea: { x: 0, y: 0, width: plotW, height: plotH },
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
