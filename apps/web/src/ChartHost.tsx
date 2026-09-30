import { useEffect, useRef, useState } from 'react';
import { FumeChart, type FollowingLatestState } from '@fume/chart';
import type { AssetClass, StreamState, TimeframeId } from '@fume/core';
import {
  ChartSession,
  type ChartSessionSettings,
  type ChartStatus,
  type DataFeed,
} from '@fume/datafeed';

export interface ChartHostProps {
  /** Where candles come from (shared by every chart on the page). */
  datafeed: DataFeed;
  symbol: string;
  /** Asset class of `symbol`: equity ticker (default) or futures root. */
  assetClass?: AssetClass;
  timeframe: TimeframeId;
  onStatus?: (status: ChartStatus) => void;
  /** Live connection health of the displayed instrument (null = history only). */
  onStreamState?: (state: StreamState | null) => void;
  /** ChartSession settings (read when the chart is created). */
  settings?: ChartSessionSettings;
  /** Dev-only QA handle suffix (window.__fumeChart<suffix>, __fumeSession<suffix>). */
  devName?: string;
}

/**
 * Hosts the framework-independent FumeChart and a headless ChartSession (@fume/datafeed). React
 * only provides the container, creates/destroys both, and forwards symbol/timeframe selections.
 * Candle math, live updates, zoom, pan, crosshair and rendering never go through React state.
 */
export function ChartHost({
  datafeed,
  symbol,
  assetClass = 'equity',
  timeframe,
  onStatus,
  onStreamState,
  settings,
  devName = '',
}: ChartHostProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<ChartSession | null>(null);
  const chartRef = useRef<FumeChart | null>(null);
  // Only changes when the live-follow state or the plot corner moves (rare), not per frame.
  const [follow, setFollow] = useState<FollowingLatestState | null>(null);
  const shownRef = useRef<{
    symbol: string;
    assetClass: AssetClass;
    timeframe: TimeframeId;
  } | null>(null);
  const latest = useRef({ symbol, assetClass, timeframe, onStatus, onStreamState, settings });
  latest.current = { symbol, assetClass, timeframe, onStatus, onStreamState, settings };

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    // Placeholder formatters/mapping until the first series arrives through setData().
    const chart = new FumeChart(container, {
      timeScale: { toSlot: () => null, slotStart: (s) => s, boundaries: () => [] },
      formatPrice: (p) => p.toFixed(2),
      formatTime: () => '',
      minPriceStep: 0.01,
    });
    const session = new ChartSession({
      datafeed,
      chart,
      onStatus: (status) => latest.current.onStatus?.(status),
      onStreamState: (state) => latest.current.onStreamState?.(state),
      ...(latest.current.settings ? { settings: latest.current.settings } : {}),
    });
    chart.setOptions({
      onNeedsOlderData: (request) => void session.requestOlderData(request),
      onFollowingLatestChange: setFollow,
    });
    sessionRef.current = session;
    chartRef.current = chart;
    const { symbol: s, assetClass: ac, timeframe: tf } = latest.current;
    shownRef.current = { symbol: s, assetClass: ac, timeframe: tf };
    void session.select(s, tf, ac);
    // Dev-only QA handles (stripped from production builds).
    if (import.meta.env.DEV) {
      Object.assign(window, {
        [`__fumeChart${devName}`]: chart,
        [`__fumeSession${devName}`]: session,
      });
    }
    return () => {
      session.dispose();
      chart.destroy();
      sessionRef.current = null;
      chartRef.current = null;
      shownRef.current = null;
      setFollow(null);
    };
  }, [datafeed, devName]);

  useEffect(() => {
    const session = sessionRef.current;
    const shown = shownRef.current;
    if (!session || !shown) return;
    if (shown.symbol !== symbol || shown.assetClass !== assetClass) {
      void session.select(symbol, timeframe, assetClass);
    } else if (shown.timeframe !== timeframe) void session.setTimeframe(timeframe);
    shownRef.current = { symbol, assetClass, timeframe };
  }, [symbol, assetClass, timeframe]);

  return (
    <div className="chart-frame">
      <div ref={containerRef} className="chart-host" data-testid="fume-chart" />
      {follow && !follow.following && (
        <button
          type="button"
          className="go-latest"
          title="Go to latest bar (the newest data the feed has)"
          aria-label="Go to latest bar"
          style={{ right: follow.plotCorner.right + 10, bottom: follow.plotCorner.bottom + 10 }}
          onClick={() => chartRef.current?.goToLatest()}
        >
          →|
        </button>
      )}
    </div>
  );
}
