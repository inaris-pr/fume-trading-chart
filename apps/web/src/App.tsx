import { useState } from 'react';
import type { TimeframeId } from '@fume/core';
import { isReplaySymbol, REPLAY_SYMBOLS, ReplayMarketDataProvider } from '@fume/replay';
import { ChartHost } from './ChartHost.tsx';
import { isTimeframe, TIMEFRAME_LABELS, TIMEFRAME_ORDER } from './timeframes.ts';

/** Initial selection; `?symbol=` / `?tf=` are dev conveniences for QA links, not persistence. */
function initialSelection(): { symbol: string; timeframe: TimeframeId } {
  const params = new URLSearchParams(window.location.search);
  const symbol = params.get('symbol');
  const timeframe = params.get('tf');
  return {
    symbol: isReplaySymbol(symbol) ? symbol : 'SPY',
    timeframe: isTimeframe(timeframe) ? timeframe : '5m',
  };
}

/** Replay speed (market ms per real ms); `?speed=` for QA. */
function replaySpeed(): number {
  const speed = Number(new URLSearchParams(window.location.search).get('speed'));
  return Number.isFinite(speed) && speed > 0 && speed <= 3600 ? speed : 20;
}

export function App() {
  const [provider] = useState(() => new ReplayMarketDataProvider({ speed: replaySpeed() }));
  const [selection, setSelection] = useState(initialSelection);
  const symbolOptions: readonly string[] = (REPLAY_SYMBOLS as readonly string[]).includes(
    selection.symbol,
  )
    ? REPLAY_SYMBOLS
    : [...REPLAY_SYMBOLS, selection.symbol];

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
              if (isReplaySymbol(symbol)) setSelection((s) => ({ ...s, symbol }));
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
        <span className="feed" title="Deterministic synthetic replay data. Not real market data.">
          Replay · not live
        </span>
      </header>
      <main className="chart-area">
        <ChartHost provider={provider} symbol={selection.symbol} timeframe={selection.timeframe} />
      </main>
    </div>
  );
}
