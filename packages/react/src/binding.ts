/**
 * ChartViewBinding: the framework-free lifecycle unit behind <FumeChartView />. It owns exactly one
 * FumeChart and one ChartSession for one container and wires them together; React only decides
 * WHEN to create, update and dispose it. Keeping this out of the component keeps the React layer
 * thin and lets the lifecycle be tested without a DOM.
 *
 * Nothing here re-implements chart, session or feed logic: candles, paging, live updates, resync
 * and drawings (tools, hit-testing, editing) all live in @fume/chart and @fume/datafeed.
 */
import {
  FumeChart,
  type ChartEnvironment,
  type ChartTheme,
  type Drawing,
  type DrawingChange,
  type DrawingHistoryState,
  type DrawingPatch,
  type DrawingTool,
  type FollowingLatestState,
  type KeyInput,
} from '@fume/chart';
import { EMPTY_TIME_SCALE, type AssetClass, type StreamState, type TimeframeId } from '@fume/core';
import {
  ChartSession,
  type ChartSessionSettings,
  type ChartStatus,
  type DataFeed,
} from '@fume/datafeed';

export interface ChartTarget {
  symbol: string;
  assetClass: AssetClass;
  timeframe: TimeframeId;
}

/** Read-only snapshot for hosts (via the component's ref). */
export interface FumeChartViewState {
  symbol: string;
  timeframe: TimeframeId;
  /** Candles loaded for the displayed series. */
  bars: number;
  /** True while older history may be loaded by panning left. */
  hasMore: boolean;
  /** True when the instrument receives live (or delayed) updates. */
  streaming: boolean;
  /** True while the newest candle is in view. */
  followingLatest: boolean;
}

export interface ChartViewBindingOptions {
  datafeed: DataFeed;
  settings?: ChartSessionSettings;
  theme?: Partial<ChartTheme>;
  onStatus?: (status: ChartStatus) => void;
  onStreamState?: (state: StreamState | null) => void;
  onFollowingLatestChange?: (state: FollowingLatestState) => void;
  /** Initial drawings (host-owned). */
  drawings?: readonly Drawing[];
  onDrawingsChange?: (drawings: readonly Drawing[], change: DrawingChange) => void;
  onDrawingToolChange?: (tool: DrawingTool) => void;
  onDrawingSelectionChange?: (id: string | null) => void;
  onDrawingHistoryChange?: (state: DrawingHistoryState) => void;
  /** Rendering environment (tests pass a fake; default: the browser). */
  environment?: ChartEnvironment;
}

export class ChartViewBinding {
  private readonly chart: FumeChart;
  private readonly session: ChartSession;
  private shown: ChartTarget | null = null;
  private disposed = false;

  constructor(container: HTMLElement, options: ChartViewBindingOptions) {
    // Placeholder formatters/mapping until the first series arrives through setData().
    this.chart = new FumeChart(
      container,
      {
        timeScale: EMPTY_TIME_SCALE,
        formatPrice: (p) => p.toFixed(2),
        formatTime: () => '',
        minPriceStep: 0.01,
        ...(options.theme ? { theme: options.theme } : {}),
        ...(options.onDrawingsChange ? { onDrawingsChange: options.onDrawingsChange } : {}),
        ...(options.onDrawingToolChange
          ? { onDrawingToolChange: options.onDrawingToolChange }
          : {}),
        ...(options.onDrawingSelectionChange
          ? { onDrawingSelectionChange: options.onDrawingSelectionChange }
          : {}),
        ...(options.onDrawingHistoryChange
          ? { onDrawingHistoryChange: options.onDrawingHistoryChange }
          : {}),
      },
      ...(options.environment ? [options.environment] : []),
    );
    this.session = new ChartSession({
      datafeed: options.datafeed,
      chart: this.chart,
      ...(options.onStatus ? { onStatus: options.onStatus } : {}),
      ...(options.onStreamState ? { onStreamState: options.onStreamState } : {}),
      ...(options.settings ? { settings: options.settings } : {}),
    });
    this.chart.setOptions({
      onNeedsOlderData: (request) => void this.session.requestOlderData(request),
      ...(options.onFollowingLatestChange
        ? { onFollowingLatestChange: options.onFollowingLatestChange }
        : {}),
    });
    if (options.drawings) this.chart.setDrawings(options.drawings);
  }

  /**
   * Shows `target`: a new symbol or asset class selects it, a new timeframe only switches the
   * timeframe, an unchanged target does nothing (so repeated renders are free).
   */
  apply(target: ChartTarget): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const shown = this.shown;
    this.shown = { ...target };
    if (!shown || shown.symbol !== target.symbol || shown.assetClass !== target.assetClass) {
      return this.session.select(target.symbol, target.timeframe, target.assetClass);
    }
    if (shown.timeframe !== target.timeframe) return this.session.setTimeframe(target.timeframe);
    return Promise.resolve();
  }

  /** Imperative symbol switch (keeps the current timeframe unless one is given). */
  selectInstrument(symbol: string, assetClass: AssetClass = 'equity', timeframe?: TimeframeId) {
    const tf = timeframe ?? this.shown?.timeframe;
    if (tf === undefined) return Promise.resolve();
    return this.apply({ symbol, assetClass, timeframe: tf });
  }

  setTimeframe(timeframe: TimeframeId): Promise<void> {
    if (!this.shown) return Promise.resolve();
    return this.apply({ ...this.shown, timeframe });
  }

  setTheme(theme: Partial<ChartTheme>): void {
    if (!this.disposed) this.chart.setOptions({ theme });
  }

  /**
   * Host drawings. The set the chart last reported (onDrawingsChange) is already shown, so passing
   * it back is a no-op: a controlled `drawings` prop does not loop.
   */
  setDrawings(drawings: readonly Drawing[]): void {
    if (!this.disposed && drawings !== this.chart.getDrawings()) this.chart.setDrawings(drawings);
  }

  getDrawings(): readonly Drawing[] {
    return this.chart.getDrawings();
  }

  setDrawingTool(tool: DrawingTool): void {
    if (!this.disposed) this.chart.setDrawingTool(tool);
  }

  getDrawingTool(): DrawingTool {
    return this.chart.getDrawingTool();
  }

  // Drawing commands: straight delegation; the engine owns the rules and the history.
  selectDrawing(id: string | null): void {
    if (!this.disposed) this.chart.selectDrawing(id);
  }

  getSelectedDrawingId(): string | null {
    return this.disposed ? null : this.chart.getSelectedDrawingId();
  }

  editDrawing(id: string, patch: DrawingPatch): boolean {
    return !this.disposed && this.chart.editDrawing(id, patch);
  }

  duplicateDrawing(id?: string): string | null {
    return this.disposed ? null : this.chart.duplicateDrawing(id);
  }

  deleteDrawing(id?: string): boolean {
    return !this.disposed && this.chart.deleteDrawing(id);
  }

  undoDrawing(): boolean {
    return !this.disposed && this.chart.undoDrawing();
  }

  redoDrawing(): boolean {
    return !this.disposed && this.chart.redoDrawing();
  }

  getDrawingHistory(): DrawingHistoryState {
    return this.disposed ? { canUndo: false, canRedo: false } : this.chart.getDrawingHistory();
  }

  handleKeyDown(e: KeyInput & { defaultPrevented?: boolean; preventDefault?: () => void }) {
    return !this.disposed && this.chart.handleKeyDown(e);
  }

  /** Scrolls to the newest candle the feed has; false when it is already in view. */
  goToLatest(): boolean {
    return this.disposed ? false : this.chart.goToLatest();
  }

  state(): FumeChartViewState | null {
    if (this.disposed) return null;
    const s = this.session.state();
    return s
      ? {
          symbol: s.symbol,
          timeframe: s.timeframe,
          bars: s.bars,
          hasMore: s.hasMore,
          streaming: s.streaming,
          followingLatest: this.chart.isFollowingLatest(),
        }
      : null;
  }

  /** Releases the session (and its live subscription) and the chart (canvases, observers). */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.session.dispose();
    this.chart.destroy();
  }
}
