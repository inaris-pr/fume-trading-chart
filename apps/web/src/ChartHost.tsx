import { useEffect, useRef, useState } from 'react';
import { FumeChart, type FollowingLatestState, type OlderDataRequest } from '@fume/chart';
import type { MarketDataProvider, TimeframeId } from '@fume/core';
import { LiveChartController } from './live/chart-controller.ts';
import {
  HistoricalChartController,
  type HistoryClient,
  type HistoryStatus,
} from './history/historical-controller.ts';

/**
 * Where candles come from:
 * - replay: the deterministic in-browser replay provider (live ticks, Stage 3);
 * - api: canonical history from Fume's backend over HTTP (Stage 4; no live ticks).
 */
export type ChartSource =
  { kind: 'replay'; provider: MarketDataProvider } | { kind: 'api'; client: HistoryClient };

/** What ChartHost needs from either controller. */
interface ChartController {
  select(symbol: string, timeframe: TimeframeId): Promise<void>;
  setTimeframe(timeframe: TimeframeId): Promise<void>;
  requestOlderData(request: OlderDataRequest): Promise<void>;
  dispose(): void;
}

export interface ChartHostProps {
  source: ChartSource;
  symbol: string;
  timeframe: TimeframeId;
  /** History status (api source only). */
  onStatus?: (status: HistoryStatus) => void;
}

/**
 * Hosts the framework-independent FumeChart and a framework-free controller. React only provides
 * the container, creates/destroys both, and forwards symbol/timeframe selections. Candle math,
 * live updates, zoom, pan, crosshair and rendering never go through React state.
 */
export function ChartHost({ source, symbol, timeframe, onStatus }: ChartHostProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<ChartController | null>(null);
  const chartRef = useRef<FumeChart | null>(null);
  // Only changes when the live-follow state or the plot corner moves (rare), not per frame.
  const [follow, setFollow] = useState<FollowingLatestState | null>(null);
  const shownRef = useRef<{ symbol: string; timeframe: TimeframeId } | null>(null);
  const latest = useRef({ symbol, timeframe, onStatus });
  latest.current = { symbol, timeframe, onStatus };

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
    const controller: ChartController =
      source.kind === 'replay'
        ? new LiveChartController({ provider: source.provider, chart })
        : new HistoricalChartController({
            client: source.client,
            chart,
            onStatus: (status) => latest.current.onStatus?.(status),
          });
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
  }, [source]);

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
