/**
 * <FumeChartView />: the thin React binding for embedding a Fume chart (docs/embedding.md).
 *
 * React decides only WHEN things happen; ChartViewBinding (FumeChart + ChartSession) does the
 * work. Candle math, live updates, zoom, pan, crosshair and rendering never go through React
 * state: the only React state here is the optional chrome (go-to-latest visibility, status).
 *
 * Lifecycle: one binding per mounted component and DataFeed. Unmount (or a new `datafeed`)
 * disposes it: the session unsubscribes from the feed and the chart releases its canvases,
 * observers and listeners. The DataFeed itself belongs to the host and may be shared by many
 * views; this component never disposes it. Safe under StrictMode (mount/unmount/remount).
 */
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import type { ChartTheme, FollowingLatestState } from '@fume/chart';
import type { AssetClass, StreamState, TimeframeId } from '@fume/core';
import type { ChartSessionSettings, ChartStatus, DataFeed } from '@fume/datafeed';
import { ChartViewBinding, type FumeChartViewState } from './binding.ts';

export interface FumeChartViewProps {
  /** Where candles come from. Share one instance between views on a page. */
  datafeed: DataFeed;
  /** Equity/ETF ticker or futures root (e.g. "SPY", "NQ"). */
  symbol: string;
  /** Default "equity". "future" resolves a root to a specific contract. */
  assetClass?: AssetClass;
  timeframe: TimeframeId;
  /** Session settings; read when the view is created (remount with a `key` to change them). */
  settings?: ChartSessionSettings;
  /** Colors; applied live when the object changes (memoize it). */
  theme?: Partial<ChartTheme>;
  className?: string;
  style?: CSSProperties;
  /** Built-in "go to latest" button while the newest candle is out of view (default true). */
  goToLatestButton?: boolean;
  /**
   * Built-in loading/empty/error notice: false (default, the host shows its own), true (generic
   * text), or a function returning the text (null hides it).
   */
  statusOverlay?: boolean | ((status: ChartStatus) => ReactNode);
  /** Loading / ready / empty / error, for host UI. */
  onStatus?: (status: ChartStatus) => void;
  /** Live connection health of the displayed instrument (null = history only). */
  onStreamState?: (state: StreamState | null) => void;
  /** Whether the newest candle is in view (and where the plot's corner is). */
  onFollowingLatestChange?: (state: FollowingLatestState) => void;
}

/** Imperative operations that should not need a React render. */
export interface FumeChartViewHandle {
  /** Scrolls to the newest candle the feed has; false when already in view. */
  goToLatest(): boolean;
  /** Switches the timeframe until the next `timeframe` prop change. */
  setTimeframe(timeframe: TimeframeId): Promise<void>;
  /** Switches the instrument until the next `symbol`/`assetClass` prop change. */
  selectInstrument(symbol: string, assetClass?: AssetClass): Promise<void>;
  /** Current series snapshot (null while nothing is loaded). */
  getState(): FumeChartViewState | null;
}

const ROOT_STYLE: CSSProperties = { position: 'relative', width: '100%', height: '100%' };
/** The engine sizes its canvases to this box; it must be positioned and have a real size. */
const CANVAS_STYLE: CSSProperties = { position: 'absolute', inset: 0, overflow: 'hidden' };

function defaultStatusText(status: ChartStatus): ReactNode {
  switch (status.kind) {
    case 'loading':
      return `Loading ${status.symbol} ${status.timeframe}…`;
    case 'empty':
      return `No data for ${status.symbol}`;
    case 'error':
      return `${status.symbol}: ${status.message} (${status.code})`;
    default:
      return null;
  }
}

export const FumeChartView = forwardRef<FumeChartViewHandle, FumeChartViewProps>(
  function FumeChartView(props, ref) {
    const {
      datafeed,
      symbol,
      assetClass = 'equity',
      timeframe,
      theme,
      className,
      style,
      goToLatestButton = true,
      statusOverlay = false,
    } = props;
    const canvasRef = useRef<HTMLDivElement>(null);
    const bindingRef = useRef<ChartViewBinding | null>(null);
    // Changes only when the follow state or plot corner moves (rare), not per frame.
    const [follow, setFollow] = useState<FollowingLatestState | null>(null);
    const [status, setStatus] = useState<ChartStatus | null>(null);
    const latest = useRef({ props, symbol, assetClass, timeframe, theme });
    latest.current = { props, symbol, assetClass, timeframe, theme };

    // One binding per mounted view and DataFeed.
    useEffect(() => {
      const container = canvasRef.current;
      if (!container) return;
      const p = latest.current.props;
      const binding = new ChartViewBinding(container, {
        datafeed,
        ...(p.settings ? { settings: p.settings } : {}),
        ...(latest.current.theme ? { theme: latest.current.theme } : {}),
        onStatus: (s) => {
          setStatus(s);
          latest.current.props.onStatus?.(s);
        },
        onStreamState: (s) => latest.current.props.onStreamState?.(s),
        onFollowingLatestChange: (s) => {
          setFollow(s);
          latest.current.props.onFollowingLatestChange?.(s);
        },
      });
      bindingRef.current = binding;
      const { symbol: s, assetClass: ac, timeframe: tf } = latest.current;
      void binding.apply({ symbol: s, assetClass: ac, timeframe: tf });
      return () => {
        binding.dispose();
        if (bindingRef.current === binding) bindingRef.current = null;
        setFollow(null);
        setStatus(null);
      };
    }, [datafeed]);

    // Prop changes: a new symbol/asset class selects, a new timeframe switches; no-op otherwise.
    useEffect(() => {
      void bindingRef.current?.apply({ symbol, assetClass, timeframe });
    }, [symbol, assetClass, timeframe]);

    const appliedTheme = useRef(theme);
    useEffect(() => {
      if (appliedTheme.current === theme) return;
      appliedTheme.current = theme;
      if (theme) bindingRef.current?.setTheme(theme);
    }, [theme]);

    useImperativeHandle(
      ref,
      () => ({
        goToLatest: () => bindingRef.current?.goToLatest() ?? false,
        setTimeframe: (tf) => bindingRef.current?.setTimeframe(tf) ?? Promise.resolve(),
        selectInstrument: (sym, ac = 'equity') =>
          bindingRef.current?.selectInstrument(sym, ac) ?? Promise.resolve(),
        getState: () => bindingRef.current?.state() ?? null,
      }),
      [],
    );

    const statusText =
      statusOverlay && status && status.kind !== 'ready'
        ? typeof statusOverlay === 'function'
          ? statusOverlay(status)
          : defaultStatusText(status)
        : null;

    return (
      <div
        className={className ? `fume-chart ${className}` : 'fume-chart'}
        style={{ ...ROOT_STYLE, ...style }}
      >
        <div
          ref={canvasRef}
          className="fume-chart-canvas"
          style={CANVAS_STYLE}
          data-testid="fume-chart"
        />
        {goToLatestButton && follow && !follow.following && (
          <button
            type="button"
            className="fume-chart-latest"
            title="Go to latest bar (the newest data the feed has)"
            aria-label="Go to latest bar"
            style={{
              position: 'absolute',
              right: follow.plotCorner.right + 10,
              bottom: follow.plotCorner.bottom + 10,
            }}
            onClick={() => bindingRef.current?.goToLatest()}
          >
            →|
          </button>
        )}
        {statusText !== null && statusText !== undefined && status && (
          <div className={`fume-chart-status fume-chart-status-${status.kind}`} role="status">
            {statusText}
          </div>
        )}
      </div>
    );
  },
);
