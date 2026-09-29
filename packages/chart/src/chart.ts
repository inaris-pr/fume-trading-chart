/**
 * FumeChart: one instance per chart. Owns its canvas, sizing and render scheduling; delegates
 * math to pure modules (frame.ts and below) and drawing to paint.ts.
 */
import type { Bar, PriceFormatter, TimeFormatter, TimeScaleMapping } from '@fume/core';
import { backingStoreSize } from './layout.ts';
import { indexSeries, type IndexedSeries } from './series.ts';
import { CandleBuffer } from './geometry.ts';
import { buildFrame, DEFAULT_FRAME_SETTINGS, type Frame } from './frame.ts';
import { paintFrame } from './paint.ts';
import { DEFAULT_THEME, type ChartTheme } from './theme.ts';
import { browserEnvironment, type ChartEnvironment, type ElementSize } from './environment.ts';

export interface FumeChartOptions {
  /** Session-aware slot mapping (built outside the chart, e.g. by @fume/core). */
  timeScale: TimeScaleMapping;
  /** Formats axis prices; built from instrument metadata by the host. */
  formatPrice: PriceFormatter;
  /** Formats axis times in the instrument's time zone; built by the host. */
  formatTime: TimeFormatter;
  /** Smallest price increment for grid steps (instrument tick). */
  minPriceStep: number;
  /** CSS px per slot. Default 7. */
  barSpacing?: number;
  /** Empty slots kept right of the latest bar. Default 6. */
  rightOffset?: number;
  theme?: Partial<ChartTheme>;
}

const MIN_PRICE_AXIS_WIDTH = 56;
const PRICE_AXIS_PADDING = 18;

export class FumeChart {
  private readonly env: ChartEnvironment;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly candles = new CandleBuffer();
  private readonly disposers: (() => void)[] = [];
  private options: FumeChartOptions;
  private theme: ChartTheme;
  private bars: readonly Bar[] = [];
  private series: IndexedSeries = { bars: [], slots: new Float64Array(0), unmappedCount: 0 };
  private priceAxisWidth = MIN_PRICE_AXIS_WIDTH;
  private size: ElementSize = { cssWidth: 0, cssHeight: 0 };
  private pixelRatio = 1;
  private pendingFrame = 0;
  private destroyed = false;
  private lastFrame: Frame | null = null;

  constructor(
    container: HTMLElement,
    options: FumeChartOptions,
    env: ChartEnvironment = browserEnvironment(),
  ) {
    this.env = env;
    this.options = options;
    this.theme = { ...DEFAULT_THEME, ...options.theme };
    this.canvas = env.createCanvas(container);
    const ctx = this.canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas 2D context is unavailable');
    this.ctx = ctx;
    Object.assign(this.canvas.style, {
      display: 'block',
      position: 'absolute',
      inset: '0',
      width: '100%',
      height: '100%',
    });
    container.appendChild(this.canvas);
    this.disposers.push(env.observeResize(container, (size) => this.resize(size)));
    this.disposers.push(env.watchPixelRatio(() => this.resize(this.size)));
  }

  /** Replaces all bars. Bars must be ascending by `start`, one per slot. */
  setBars(bars: readonly Bar[]): void {
    if (this.destroyed) return;
    this.bars = bars;
    this.reindex();
  }

  setOptions(options: Partial<FumeChartOptions>): void {
    if (this.destroyed) return;
    const mappingChanged =
      options.timeScale !== undefined && options.timeScale !== this.options.timeScale;
    const formatChanged =
      options.formatPrice !== undefined && options.formatPrice !== this.options.formatPrice;
    this.options = { ...this.options, ...options };
    if (options.theme) this.theme = { ...DEFAULT_THEME, ...this.options.theme };
    if (mappingChanged || formatChanged) this.reindex();
    else this.invalidate();
  }

  /** Renders synchronously. Normally frames are scheduled automatically; exposed for measurement. */
  render(): void {
    if (this.destroyed) return;
    if (this.pendingFrame) {
      this.env.cancelFrame(this.pendingFrame);
      this.pendingFrame = 0;
    }
    const { cssWidth, cssHeight } = this.size;
    if (cssWidth <= 0 || cssHeight <= 0) return;
    const frame = buildFrame(
      {
        cssWidth,
        cssHeight,
        pixelRatio: this.pixelRatio,
        series: this.series,
        mapping: this.options.timeScale,
        formatPrice: this.options.formatPrice,
        formatTime: this.options.formatTime,
        settings: {
          ...DEFAULT_FRAME_SETTINGS,
          ...(this.options.barSpacing !== undefined ? { barSpacing: this.options.barSpacing } : {}),
          ...(this.options.rightOffset !== undefined
            ? { rightOffset: this.options.rightOffset }
            : {}),
          priceAxisWidth: this.priceAxisWidth,
          minPriceStep: this.options.minPriceStep,
        },
      },
      this.candles,
    );
    paintFrame(this.ctx, frame, this.theme);
    this.lastFrame = frame;
  }

  /** The most recently rendered frame model (diagnostics and tests). */
  getLastFrame(): Frame | null {
    return this.lastFrame;
  }

  /** Bars that could not be placed on the time scale (compressed time / outside sessions). */
  getUnmappedBarCount(): number {
    return this.series.unmappedCount;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.pendingFrame) this.env.cancelFrame(this.pendingFrame);
    this.pendingFrame = 0;
    for (const dispose of this.disposers.splice(0)) dispose();
    this.canvas.remove();
    this.lastFrame = null;
  }

  private reindex(): void {
    this.series = indexSeries(this.bars, this.options.timeScale);
    this.priceAxisWidth = this.measurePriceAxisWidth();
    this.invalidate();
  }

  /** Axis width from the widest formatted extreme price, measured once per data change. */
  private measurePriceAxisWidth(): number {
    let low = Number.POSITIVE_INFINITY;
    let high = Number.NEGATIVE_INFINITY;
    for (const bar of this.series.bars) {
      if (bar.low < low) low = bar.low;
      if (bar.high > high) high = bar.high;
    }
    if (!(low <= high)) return MIN_PRICE_AXIS_WIDTH;
    this.ctx.font = `${this.theme.fontSize}px ${this.theme.fontFamily}`;
    const widest = Math.max(
      this.ctx.measureText(this.options.formatPrice(low)).width,
      this.ctx.measureText(this.options.formatPrice(high)).width,
    );
    return Math.max(MIN_PRICE_AXIS_WIDTH, Math.ceil(widest + PRICE_AXIS_PADDING));
  }

  private resize(size: ElementSize): void {
    if (this.destroyed) return;
    this.size = size;
    const backing = backingStoreSize(
      size.cssWidth,
      size.cssHeight,
      this.env.devicePixelRatio(),
      size.device,
    );
    if (this.canvas.width !== backing.width) this.canvas.width = backing.width;
    if (this.canvas.height !== backing.height) this.canvas.height = backing.height;
    this.pixelRatio = backing.pixelRatio;
    this.invalidate();
  }

  /** Coalesces any number of changes into one render on the next animation frame. */
  private invalidate(): void {
    if (this.destroyed || this.pendingFrame) return;
    this.pendingFrame = this.env.requestFrame(() => {
      this.pendingFrame = 0;
      this.render();
    });
  }
}
