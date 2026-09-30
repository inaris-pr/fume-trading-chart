import { useEffect, useRef, useState } from 'react';
import { FumeChart, type FollowingLatestState } from '@fume/chart';
import type { MarketDataProvider, TimeframeId } from '@fume/core';
import { LiveChartController } from './live/chart-controller.ts';

export interface ChartHostProps {
  provider: MarketDataProvider;
  symbol: string;
  timeframe: TimeframeId;
}

/**
 * Hosts the framework-independent FumeChart and the framework-free LiveChartController. React only
 * provides the container, creates/destroys both, and forwards symbol/timeframe selections. Candle
 * math, live updates, zoom, pan, crosshair and rendering never go through React state.
 */
export function ChartHost({ provider, symbol, timeframe }: ChartHostProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<LiveChartController | null>(null);
  const chartRef = useRef<FumeChart | null>(null);
  // Only changes when the live-follow state or the plot corner moves (rare), not per frame.
  const [follow, setFollow] = useState<FollowingLatestState | null>(null);
  const shownRef = useRef<{ symbol: string; timeframe: TimeframeId } | null>(null);
  const latest = useRef({ symbol, timeframe });
  latest.current = { symbol, timeframe };

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
    const controller = new LiveChartController({ provider, chart });
    chart.setOptions({
      onNeedsOlderData: (request) => void controller.requestOlderData(request),
      onFollowingLatestChange: setFollow,
    });
    controllerRef.current = controller;
    chartRef.current = chart;
    const { symbol: s, timeframe: tf } = latest.current;
    shownRef.current = { symbol: s, timeframe: tf };
    void controller.select(s, tf);
    // Dev-only QA handles (stripped from production builds).
    if (import.meta.env.DEV)
      Object.assign(window, { __fumeChart: chart, __fumeController: controller });
    return () => {
      controller.dispose();
      chart.destroy();
      controllerRef.current = null;
      chartRef.current = null;
      shownRef.current = null;
      setFollow(null);
    };
  }, [provider]);

  useEffect(() => {
    const controller = controllerRef.current;
    const shown = shownRef.current;
    if (!controller || !shown) return;
    if (shown.symbol !== symbol) void controller.select(symbol, timeframe);
    else if (shown.timeframe !== timeframe) void controller.setTimeframe(timeframe);
    shownRef.current = { symbol, timeframe };
  }, [symbol, timeframe]);

  return (
    <div className="chart-frame">
      <div ref={containerRef} className="chart-host" data-testid="fume-chart" />
      {follow && !follow.following && (
        <button
          type="button"
          className="go-latest"
          title="Go to latest bar"
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
