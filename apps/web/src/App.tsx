import { useMemo, useState } from 'react';
import type { ChartData } from '@fume/chart';
import type { TimeframeId } from '@fume/core';
import { ChartHost } from './ChartHost.tsx';
import {
  DEMO_SYMBOLS,
  DemoCatalog,
  isDemoSymbol,
  isTimeframe,
  TIMEFRAME_LABELS,
  TIMEFRAME_ORDER,
  type DemoSymbol,
} from './demo/catalog.ts';

/** Initial selection; `?symbol=` / `?tf=` are dev conveniences for QA links, not persistence. */
function initialSelection(): { symbol: DemoSymbol; timeframe: TimeframeId } {
  const params = new URLSearchParams(window.location.search);
  const symbol = params.get('symbol');
  const timeframe = params.get('tf');
  return {
    symbol: isDemoSymbol(symbol) ? symbol : 'SPY',
    timeframe: isTimeframe(timeframe) ? timeframe : '5m',
  };
}

export function App() {
  const [catalog] = useState(() => new DemoCatalog());
  const [selection, setSelection] = useState(initialSelection);
  const series = useMemo(
    () => catalog.get(selection.symbol, selection.timeframe),
    [catalog, selection.symbol, selection.timeframe],
  );
  const chartData = useMemo<ChartData>(
    () => ({
      bars: series.bars,
      timeScale: series.timeScale,
      formatPrice: series.formatPrice,
      formatTime: series.formatTime,
      minPriceStep: series.minPriceStep,
      barSpacing: series.barSpacing,
      rightOffset: series.rightOffset,
    }),
    [series],
  );
  const symbolOptions: readonly DemoSymbol[] = (DEMO_SYMBOLS as readonly DemoSymbol[]).includes(
    selection.symbol,
  )
    ? DEMO_SYMBOLS
    : [...DEMO_SYMBOLS, selection.symbol];

  return (
    <div className="app">
      <header className="app-header">
        <span className="brand">Fume</span>
        <label className="symbol-picker">
          <span className="visually-hidden">Symbol</span>
          <select
            aria-label="Symbol"
            value={selection.symbol}
            onChange={(e) => {
              const symbol = e.target.value;
              if (isDemoSymbol(symbol)) setSelection((s) => ({ ...s, symbol }));
            }}
          >
            {symbolOptions.map((symbol) => (
              <option key={symbol} value={symbol}>
                {symbol}
              </option>
            ))}
          </select>
        </label>
        <div className="timeframes" role="group" aria-label="Timeframe">
          {TIMEFRAME_ORDER.map((timeframe) => (
            <button
              key={timeframe}
              type="button"
              aria-pressed={selection.timeframe === timeframe}
              onClick={() => setSelection((s) => ({ ...s, timeframe }))}
            >
              {TIMEFRAME_LABELS[timeframe]}
            </button>
          ))}
        </div>
        <span className="meta">RTH</span>
        <span className="feed" title={series.instrument.description}>
          Replay data · not live
        </span>
      </header>
      <main className="chart-area">
        <ChartHost data={chartData} />
      </main>
    </div>
  );
}
