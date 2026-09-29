/**
 * FumeChart: one instance per chart. Owns two stacked canvases, sizing, interaction state and
 * render scheduling; delegates math to pure modules and drawing to the painters.
 *
 * Layers (both DPR-correct, sized together, removed by destroy()):
 * - main canvas: grid, candles, axes, last price. Repainted only when data, view or size change.
 * - overlay canvas: crosshair, crosshair readouts, OHLC legend. Repainted on pointer moves without
 *   rebuilding the frame. It sits on top and receives all pointer and wheel events.
 */
import type { Bar, PriceFormatter, TimeFormatter, TimeScaleMapping } from '@fume/core';
import { backingStoreSize } from './layout.ts';
import { indexSeries, type IndexedSeries } from './series.ts';
import { CandleBuffer } from './geometry.ts';
import { buildFrame, DEFAULT_FRAME_SETTINGS, type Frame } from './frame.ts';
import { paintFrame } from './paint.ts';
import { paintOverlay } from './paint-overlay.ts';
import { DEFAULT_THEME, type ChartTheme } from './theme.ts';
import { browserEnvironment, type ChartEnvironment, type ElementSize } from './environment.ts';
import {
  clampView,
  DEFAULT_VIEW_LIMITS,
  normalizeWheelDelta,
  panView,
  wheelAction,
  zoomView,
  type ViewContext,
  type ViewState,
} from './view-state.ts';
import {
  beginDrag,
  beginPriceDrag,
  computeCrosshair,
  dragDelta,
  endDrag,
  IDLE_DRAG,
  isInsidePlot,
  isInsidePriceAxis,
  priceDragDelta,
  type CrosshairModel,
  type DragState,
} from './interaction.ts';
import {
  AUTO_PRICE_SCALE,
  priceDragFactor,
  priceScaleLimits,
  priceWheelFactor,
  scalePriceRange,
  type PriceScaleMode,
} from './price-scale-state.ts';
import type { PriceRange } from './price-scale.ts';

export interface FumeChartOptions {
  /** Session-aware slot mapping (built outside the chart, e.g. by @fume/core). */
  timeScale: TimeScaleMapping;
  /** Formats axis prices; built from instrument metadata by the host. */
  formatPrice: PriceFormatter;
  /** Formats axis times in the instrument's time zone; built by the host. */
  formatTime: TimeFormatter;
  /** Smallest price increment for grid steps (instrument tick). */
  minPriceStep: number;
  /** Initial CSS px per slot after data is set. Default 7. */
  barSpacing?: number;
  /** Initial empty slots right of the latest bar after data is set. Default 6. */
  rightOffset?: number;
  theme?: Partial<ChartTheme>;
}

/** Everything that describes one series. Replaced atomically by setData(). */
export interface ChartData {
  bars: readonly Bar[];
  timeScale: TimeScaleMapping;
  formatPrice: PriceFormatter;
  formatTime: TimeFormatter;
  minPriceStep: number;
  /** Initial view for this data; also becomes the default for later resets. */
  barSpacing?: number;
  rightOffset?: number;
}

type PointerLike = { offsetX: number; offsetY: number; pointerId: number; button: number };

const MIN_PRICE_AXIS_WIDTH = 56;
const PRICE_AXIS_PADDING = 18;

export class FumeChart {
  private readonly env: ChartEnvironment;
  private readonly canvas: HTMLCanvasElement;
  private readonly overlay: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly overlayCtx: CanvasRenderingContext2D;
  private readonly candles = new CandleBuffer();
  private readonly disposers: (() => void)[] = [];
  private options: FumeChartOptions;
  private theme: ChartTheme;
  private bars: readonly Bar[] = [];
  private series: IndexedSeries = { bars: [], slots: new Float64Array(0), unmappedCount: 0 };
  private priceAxisWidth = MIN_PRICE_AXIS_WIDTH;
  private size: ElementSize = { cssWidth: 0, cssHeight: 0 };
  private pixelRatio = 1;
  private view: ViewState;
  private drag: DragState = IDLE_DRAG;
  private pointer: { x: number; y: number } | null = null;
  private crosshair: CrosshairModel | null = null;
  private priceScale: PriceScaleMode = AUTO_PRICE_SCALE;
  /** Low/high of all bars (for manual price-scale limits); null without data. */
  private dataRange: PriceRange | null = null;
  private mainDirty = true;
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
    this.view = this.defaultView();

    this.canvas = env.createCanvas(container);
    this.overlay = env.createCanvas(container);
    const ctx = this.canvas.getContext('2d', { alpha: false });
    const overlayCtx = this.overlay.getContext('2d');
    if (!ctx || !overlayCtx) throw new Error('Canvas 2D context is unavailable');
    this.ctx = ctx;
    this.overlayCtx = overlayCtx;
    const layer = {
      display: 'block',
      position: 'absolute',
      inset: '0',
      width: '100%',
      height: '100%',
    };
    Object.assign(this.canvas.style, layer, { pointerEvents: 'none' });
    Object.assign(this.overlay.style, layer, {
      cursor: 'crosshair',
      touchAction: 'none',
      userSelect: 'none',
    });
    container.appendChild(this.canvas);
    container.appendChild(this.overlay);

    this.disposers.push(env.observeResize(container, (size) => this.resize(size)));
    this.disposers.push(env.watchPixelRatio(() => this.resize(this.size)));
    this.listen('pointerdown', (e) => this.onPointerDown(e as PointerEvent));
    this.listen('pointermove', (e) => this.onPointerMove(e as PointerEvent));
    this.listen('pointerup', (e) => this.onPointerUp(e as PointerEvent, false));
    this.listen('pointercancel', (e) => this.onPointerUp(e as PointerEvent, true));
    this.listen('lostpointercapture', (e) => this.onPointerUp(e as PointerEvent, false));
    this.listen('pointerleave', () => this.onPointerLeave());
    this.listen('dblclick', (e) => this.onDoubleClick(e as MouseEvent));
    this.listen('wheel', (e) => this.onWheel(e as WheelEvent), { passive: false });
  }

  /**
   * Replaces bars, time scale and formatters together (e.g. on symbol or timeframe change), then
   * resets the view to the latest bars and clears the crosshair. Nothing from the previous
   * dataset (slots, labels, price range) survives.
   */
  setData(data: ChartData): void {
    if (this.destroyed) return;
    this.options = {
      ...this.options,
      timeScale: data.timeScale,
      formatPrice: data.formatPrice,
      formatTime: data.formatTime,
      minPriceStep: data.minPriceStep,
      ...(data.barSpacing !== undefined ? { barSpacing: data.barSpacing } : {}),
      ...(data.rightOffset !== undefined ? { rightOffset: data.rightOffset } : {}),
    };
    this.bars = data.bars;
    this.reindex();
  }

  /** Replaces all bars (same time scale) and resets the view to the latest bars. */
  setBars(bars: readonly Bar[]): void {
    if (this.destroyed) return;
    this.bars = bars;
    this.reindex();
  }

  setOptions(options: Partial<FumeChartOptions>): void {
    if (this.destroyed) return;
    const dataChanged =
      (options.timeScale !== undefined && options.timeScale !== this.options.timeScale) ||
      (options.formatPrice !== undefined && options.formatPrice !== this.options.formatPrice);
    this.options = { ...this.options, ...options };
    if (options.theme) this.theme = { ...DEFAULT_THEME, ...this.options.theme };
    if (dataChanged) {
      this.reindex();
      return;
    }
    if (options.barSpacing !== undefined || options.rightOffset !== undefined) this.resetView();
    this.invalidate('main');
  }

  /** Back to the latest bars at the default spacing and AUTO price scale; clears the crosshair. */
  resetView(): void {
    if (this.destroyed) return;
    this.view = this.defaultView();
    this.priceScale = AUTO_PRICE_SCALE;
    this.drag = IDLE_DRAG;
    this.pointer = null;
    this.crosshair = null;
    this.invalidate('main');
  }

  /** Restores AUTO price scaling: the visible bars determine the price range again. */
  resetPriceScale(): void {
    if (this.destroyed || this.priceScale.mode === 'auto') return;
    this.priceScale = AUTO_PRICE_SCALE;
    this.invalidate('main');
  }

  getPriceScaleMode(): 'auto' | 'manual' {
    return this.priceScale.mode;
  }

  /** Renders pending layers synchronously (normally scheduled automatically; exposed for measurement). */
  render(): void {
    if (this.destroyed) return;
    if (this.pendingFrame) {
      this.env.cancelFrame(this.pendingFrame);
      this.pendingFrame = 0;
    }
    const { cssWidth, cssHeight } = this.size;
    if (cssWidth <= 0 || cssHeight <= 0) return;
    if (this.mainDirty || !this.lastFrame) this.renderMain(cssWidth, cssHeight);
    this.renderOverlay();
    this.mainDirty = false;
  }

  /** Forces a full repaint of both layers now (measurement helper). */
  renderAll(): void {
    this.mainDirty = true;
    this.render();
  }

  /** Repaints only the overlay now (measurement helper). */
  renderOverlayOnly(): void {
    if (this.destroyed || !this.lastFrame) return;
    this.renderOverlay();
  }

  getLastFrame(): Frame | null {
    return this.lastFrame;
  }

  getView(): Readonly<ViewState> {
    return this.view;
  }

  getCrosshair(): Readonly<CrosshairModel> | null {
    return this.crosshair;
  }

  /** A horizontal pan drag is in progress. */
  isPanning(): boolean {
    return this.drag.active && this.drag.kind === 'pan';
  }

  /** A price-axis scaling drag is in progress. */
  isScalingPrice(): boolean {
    return this.drag.active && this.drag.kind === 'price';
  }

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
    this.overlay.remove();
    this.lastFrame = null;
    this.crosshair = null;
    this.drag = IDLE_DRAG;
  }

  // ---------------------------------------------------------------------------------------------

  private renderMain(cssWidth: number, cssHeight: number): void {
    const plotWidth = Math.max(0, cssWidth - Math.min(this.priceAxisWidth, cssWidth));
    if (plotWidth > 0)
      this.view = clampView(this.view, this.viewContext(plotWidth), DEFAULT_VIEW_LIMITS);
    const frame = buildFrame(
      {
        cssWidth,
        cssHeight,
        pixelRatio: this.pixelRatio,
        series: this.series,
        mapping: this.options.timeScale,
        formatPrice: this.options.formatPrice,
        formatTime: this.options.formatTime,
        priceRange: this.priceScale.mode === 'manual' ? this.priceScale.range : null,
        settings: {
          ...DEFAULT_FRAME_SETTINGS,
          barSpacing: this.view.barSpacing,
          rightOffset: this.view.rightOffset,
          priceAxisWidth: this.priceAxisWidth,
          minPriceStep: this.options.minPriceStep,
        },
      },
      this.candles,
    );
    paintFrame(this.ctx, frame, this.theme);
    this.lastFrame = frame;
  }

  private renderOverlay(): void {
    const frame = this.lastFrame;
    if (!frame) return;
    this.crosshair = this.pointer
      ? computeCrosshair({
          frame,
          series: this.series,
          mapping: this.options.timeScale,
          formatPrice: this.options.formatPrice,
          formatTime: this.options.formatTime,
          pointer: this.pointer,
        })
      : null;
    const latest = this.series.bars[this.series.bars.length - 1] ?? null;
    const legendBar = this.crosshair ? this.crosshair.bar : latest;
    paintOverlay(
      this.overlayCtx,
      frame,
      this.crosshair,
      legendBar,
      this.options.formatPrice,
      this.theme,
    );
  }

  private defaultView(): ViewState {
    return {
      barSpacing: this.options.barSpacing ?? DEFAULT_FRAME_SETTINGS.barSpacing,
      rightOffset: this.options.rightOffset ?? DEFAULT_FRAME_SETTINGS.rightOffset,
    };
  }

  private viewContext(plotWidth: number): ViewContext {
    const { slots } = this.series;
    return {
      plotWidth,
      firstSlot: slots.length > 0 ? slots[0]! : 0,
      lastSlot: slots.length > 0 ? slots[slots.length - 1]! : 0,
    };
  }

  private reindex(): void {
    this.series = indexSeries(this.bars, this.options.timeScale);
    this.priceAxisWidth = this.measurePriceAxisWidth();
    this.lastFrame = null;
    this.resetView();
  }

  /** Axis width from the widest formatted extreme price, measured once per data change. */
  private measurePriceAxisWidth(): number {
    let low = Number.POSITIVE_INFINITY;
    let high = Number.NEGATIVE_INFINITY;
    for (const bar of this.series.bars) {
      if (bar.low < low) low = bar.low;
      if (bar.high > high) high = bar.high;
    }
    this.dataRange = low <= high ? { min: low, max: high } : null;
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
    for (const canvas of [this.canvas, this.overlay]) {
      if (canvas.width !== backing.width) canvas.width = backing.width;
      if (canvas.height !== backing.height) canvas.height = backing.height;
    }
    this.pixelRatio = backing.pixelRatio;
    this.invalidate('main');
  }

  // --- pointer & wheel -------------------------------------------------------------------------

  private listen(
    type: string,
    handler: (e: Event) => void,
    options?: AddEventListenerOptions,
  ): void {
    this.overlay.addEventListener(type, handler, options);
    this.disposers.push(() => this.overlay.removeEventListener(type, handler, options));
  }

  private onPointerDown(e: PointerLike & Partial<Pick<PointerEvent, 'preventDefault'>>): void {
    const frame = this.lastFrame;
    if (!frame) return;
    const pointer = { pointerId: e.pointerId, x: e.offsetX, y: e.offsetY, button: e.button };
    let next = this.drag;
    if (isInsidePlot(frame, e.offsetX, e.offsetY)) {
      next = beginDrag(this.drag, pointer, this.view);
    } else if (isInsidePriceAxis(frame, e.offsetX, e.offsetY) && frame.priceScale) {
      next = beginPriceDrag(
        this.drag,
        pointer,
        frame.priceScale.range,
        frame.priceScale.toPrice(e.offsetY),
      );
    }
    if (next === this.drag || !next.active) return;
    this.drag = next;
    e.preventDefault?.();
    try {
      this.overlay.setPointerCapture(e.pointerId);
    } catch {
      // Capture can fail for synthetic or already-released pointers; dragging still works.
    }
    this.overlay.style.cursor = next.kind === 'pan' ? 'grabbing' : 'ns-resize';
    this.pointer = { x: e.offsetX, y: e.offsetY };
    this.invalidate('overlay');
  }

  private onPointerMove(e: PointerLike): void {
    this.pointer = { x: e.offsetX, y: e.offsetY };
    const frame = this.lastFrame;
    const drag = this.drag;
    if (frame && drag.active && drag.pointerId === e.pointerId) {
      if (drag.kind === 'pan') {
        const dx = dragDelta(drag, { pointerId: e.pointerId, x: e.offsetX }) ?? 0;
        this.view = panView(
          drag.startView,
          dx,
          this.viewContext(frame.layout.plot.width),
          DEFAULT_VIEW_LIMITS,
        );
      } else {
        const dy = priceDragDelta(drag, { pointerId: e.pointerId, y: e.offsetY }) ?? 0;
        this.priceScale = {
          mode: 'manual',
          range: scalePriceRange(
            drag.startRange,
            priceDragFactor(dy),
            drag.anchorPrice,
            this.priceScaleLimits(),
          ),
        };
      }
      this.invalidate('main');
      return;
    }
    if (frame) this.overlay.style.cursor = this.cursorAt(frame, e.offsetX, e.offsetY);
    this.invalidate('overlay');
  }

  private onPointerUp(e: PointerLike, cancelled: boolean): void {
    const wasActive = this.drag.active;
    this.drag = endDrag(this.drag, e.pointerId);
    if (wasActive && !this.drag.active) {
      const frame = this.lastFrame;
      this.overlay.style.cursor = frame ? this.cursorAt(frame, e.offsetX, e.offsetY) : 'crosshair';
      try {
        if (this.overlay.hasPointerCapture?.(e.pointerId))
          this.overlay.releasePointerCapture(e.pointerId);
      } catch {
        // Already released.
      }
    }
    if (cancelled) this.pointer = null;
    this.invalidate('overlay');
  }

  private onPointerLeave(): void {
    if (this.drag.active) return;
    this.pointer = null;
    this.invalidate('overlay');
  }

  private onDoubleClick(e: { offsetX: number; offsetY: number }): void {
    const frame = this.lastFrame;
    if (frame && isInsidePriceAxis(frame, e.offsetX, e.offsetY)) this.resetPriceScale();
  }

  private onWheel(e: WheelEvent): void {
    const frame = this.lastFrame;
    if (!frame) return;
    const plotWidth = frame.layout.plot.width;
    const input = {
      deltaX: e.deltaX,
      deltaY: e.deltaY,
      deltaMode: e.deltaMode,
      ctrlKey: e.ctrlKey,
    };

    if (isInsidePriceAxis(frame, e.offsetX, e.offsetY)) {
      // Price axis: vertical price scaling only, anchored at the price under the pointer.
      const delta = normalizeWheelDelta(input, frame.layout.plot.height);
      if (!delta || !frame.priceScale || delta.dy === 0) return;
      e.preventDefault();
      const base =
        this.priceScale.mode === 'manual' ? this.priceScale.range : frame.priceScale.range;
      this.priceScale = {
        mode: 'manual',
        range: scalePriceRange(
          base,
          priceWheelFactor(delta.dy),
          frame.priceScale.toPrice(e.offsetY),
          this.priceScaleLimits(),
        ),
      };
      this.invalidate('main');
      return;
    }

    if (!isInsidePlot(frame, e.offsetX, e.offsetY)) return;
    // Plot: horizontal zoom / pan only; the price-scale mode is untouched.
    const action = wheelAction(input, plotWidth);
    if (!action) return;
    e.preventDefault();
    const ctx = this.viewContext(plotWidth);
    this.view =
      action.kind === 'zoom'
        ? zoomView(
            this.view,
            action.factor,
            e.offsetX - frame.layout.plot.x,
            ctx,
            DEFAULT_VIEW_LIMITS,
          )
        : panView(this.view, action.dxPx, ctx, DEFAULT_VIEW_LIMITS);
    this.pointer = { x: e.offsetX, y: e.offsetY };
    this.invalidate('main');
  }

  private cursorAt(frame: Frame, x: number, y: number): string {
    if (isInsidePlot(frame, x, y)) return 'crosshair';
    if (isInsidePriceAxis(frame, x, y)) return 'ns-resize';
    return 'default';
  }

  private priceScaleLimits() {
    return priceScaleLimits(this.dataRange, this.options.minPriceStep);
  }

  /** Coalesces changes into one render on the next animation frame. */
  private invalidate(layer: 'main' | 'overlay'): void {
    if (layer === 'main') this.mainDirty = true;
    if (this.destroyed || this.pendingFrame) return;
    this.pendingFrame = this.env.requestFrame(() => {
      this.pendingFrame = 0;
      this.render();
    });
  }
}
